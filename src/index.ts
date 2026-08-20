/**
 * Hono Application Entry Point
 *
 * This is a parallel entry point using Hono instead of Express
 * Can be used for testing before fully migrating from Express
 *
 * To run this:
 * 1. Set USE_HONO=true in environment
 * 2. Or update package.json to point to this file
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { initializeDatabase, getDatabase } from "./infrastructure/database/factory";
import apiRouter from "./presentation/routers";
import legacyBoardRouter from "./presentation/routers/legacy-board.router";
import auditInternalRouter from "./presentation/routers/audit-internal.router";
import { errorHandler, httpLogger, requestContext } from "./presentation/middleware";
import config from "./config";
import logger from "./infrastructure/logging/logger";
import { installCorrelation } from "./infrastructure/http/client";
import { runMigrations } from "./db/drizzle/migrate";
import db from "./db/mongodb";
import { Pool } from "pg";

// Import background services
import ingestionWorker from "./core/services/ingestion-worker.service";
import onedrivePollingService from "./core/services/onedrive-polling.service";
import googleDrivePollingService from "./core/services/google-drive-polling.service";
import { SchedulerService } from "./core/services/scheduler.service";

const app = new Hono();

async function ensureDatabase(): Promise<void> {
  const rawUrl = config.pgUrl;
  const url = new URL(rawUrl);
  const database = url.pathname.slice(1);
  const needsSSL =
    process.env.POSTGRES_SSL === "true" ||
    /sslmode=(require|verify-ca)/.test(rawUrl ?? "");
  const sslOpts = needsSSL ? { rejectUnauthorized: false } : undefined;

  const adminPool = new Pool({
    host: url.hostname,
    port: parseInt(url.port || "5432"),
    database: "postgres",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    max: 1,
    ssl: sslOpts,
  });
  try {
    const { rows } = await adminPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [database],
    );
    if (rows.length === 0) {
      await adminPool.query(`CREATE DATABASE "${database}"`);
      logger.info(`[startup] created database "${database}"`);
    }
  } finally {
    await adminPool.end();
  }
}

/**
 * Start Hono server
 */
const startHonoServer = async () => {
  // Propagate x-request-id / x-proxy on every outbound axios call.
  installCorrelation();

  try {
    if (config.dbType === "postgres") {
      // Ensure the target database exists before running migrations.
      await ensureDatabase();
    }

    if (config.dbType === "mongodb") {
      await db.connect();
    }
  } catch (dbInitError) {
    logger.warn(
      "Pre-migration setup failed — some features will be unavailable:",
      (dbInitError as Error).message,
    );
  }

  // Apply any pending DB migrations before serving (Postgres only). Fail fast
  // so an incomplete deploy never serves against a schema it doesn't match —
  // this is what stops "column does not exist" errors when a new image ships
  // ahead of its migrations.
  try {
    await runMigrations();
  } catch (migrateError) {
    logger.error(
      "migrate: failed to apply migrations — aborting startup:",
      (migrateError as Error).message,
    );
    process.exit(1);
  }

  try {
    logger.info("Initializing database adapter...");
    await initializeDatabase();
    logger.info("Database adapter initialized");
  } catch (dbError) {
    logger.warn(
      "Database initialization failed — some features will be unavailable:",
      (dbError as Error).message,
    );
  }

  try {
    // Global middleware — requestContext MUST be first so every downstream
    // log line and outbound call carries the correlation id.
    app.use("*", requestContext);
    app.use("*", cors());
    app.use("*", httpLogger);

    // Root endpoint
    app.get("/", (c) =>
      c.json({
        name: "My data_board API (Hono)",
        version: config.version,
        environment: config.environment,
      }),
    );

    // Internal route inventory — consumed by app-gateway to build its
    // permission catalog. Reads Hono's live route table at request time.
    // Internal-only: relies on network isolation — the gateway never proxies
    // /internal/* so this is unreachable by clients.
    app.get("/internal/routes", (c) => {
      const seen = new Set<string>();
      const routes = app.routes
        .filter(
          (r) =>
            /^(GET|POST|PUT|PATCH|DELETE)$/i.test(r.method) &&
            !r.path.includes("*"),
        )
        .map((r) => ({ method: r.method.toUpperCase(), path: r.path }))
        .filter((r) => {
          const k = `${r.method} ${r.path}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      return c.json({ service: "data-board", routes });
    });

    // Mount API routes
    app.route("/api", apiRouter);

    // Legacy private-backend shape (`/v1/board/:id`) for callers built against
    // the pre-migration backend — kept at root so IMBRACE_PRIVATE_API can point
    // at the data-board host without a path suffix.
    app.route("/", legacyBoardRouter);

    // Internal audit-revert command endpoint (platform dispatches reverts here).
    app.route("/", auditInternalRouter);

    // Global error handler (must be last)
    app.onError(errorHandler);

    // Start server
    serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" });
    logger.info(`Hono server running at http://localhost:${config.port}`);

    // Start background workers
    await ingestionWorker.start();
    // The OneDrive / Google-Drive pollers are Mongoose-only (Folder/File
    // models). In Postgres mode the legacy Mongo connection is skipped, so
    // starting them just spams `buffering timed out` errors every cycle.
    // Skip them until they're ported to the PG adapter.
    if (config.dbType === "postgres") {
      logger.info(
        "DB_TYPE=postgres — skipping OneDrive/Google-Drive pollers (Mongoose-only, not yet PG-aware)",
      );
    } else {
      await onedrivePollingService.start();
      await googleDrivePollingService.start();
    }

    // Re-arm node-schedule jobs from `schedulers` table. Non-blocking
    // on failure so a broken row doesn't keep the API offline.
    try {
      const dbClient = getDatabase();
      const schedulerService = new SchedulerService(dbClient);
      await schedulerService.recoverActiveJobs();
    } catch (err) {
      logger.error(
        `scheduler: recoverActiveJobs failed at boot: ${(err as Error).message}`,
      );
    }
  } catch (error) {
    logger.error("Hono server startup error:", error);
    process.exit(1);
  }
};

// Start the server
startHonoServer();
