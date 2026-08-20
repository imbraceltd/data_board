import path from "node:path";
import fs from "node:fs";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDrizzleDb } from "./index";
import config from "../../config";
import logger from "../../infrastructure/logging/logger";

/**
 * Resolve the drizzle migrations folder.
 *
 * In the built image the migrations are copied next to this compiled file at
 * `dist/db/drizzle/migrations` (see the Dockerfile runner stage — swc does not
 * copy `.sql`/`.json`, so they must be COPYied in explicitly). When running
 * from source they live under `src/db/drizzle/migrations`. `MIGRATIONS_DIR`
 * overrides both.
 */
function resolveMigrationsDir(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.join(__dirname, "migrations"),
    path.join(process.cwd(), "src/db/drizzle/migrations"),
    path.join(process.cwd(), "dist/db/drizzle/migrations"),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "meta", "_journal.json"))) return dir;
  }

  throw new Error(
    `migrate: could not locate drizzle migrations folder (looked in: ${candidates.join(", ")}). ` +
      "In the Docker image the migrations must be copied into dist/db/drizzle/migrations.",
  );
}

/**
 * Apply any pending drizzle migrations before the app starts serving.
 *
 * Uses the programmatic drizzle-orm migrator rather than `drizzle-kit migrate`
 * — drizzle-kit is a dev-only dependency and is not present in the production
 * image. The migrator is idempotent: on an up-to-date DB it reads the journal
 * and applies nothing. All pending statements run inside a single transaction.
 *
 * Gated to Postgres (Mongo deploys skip it). Set `AUTO_MIGRATE=false` to opt
 * out, e.g. when a deploy applies migrations out-of-band.
 *
 * NOTE: data-board runs as a single replica per environment, so concurrent
 * boots racing the migrator is not a concern here. If that ever changes, wrap
 * this in a Postgres advisory lock on a dedicated client.
 */
export async function runMigrations(): Promise<void> {
  if (config.dbType !== "postgres") {
    logger.info("migrate: DB_TYPE is not postgres — skipping auto-migrate");
    return;
  }
  if (process.env.AUTO_MIGRATE === "false") {
    logger.warn("migrate: AUTO_MIGRATE=false — skipping auto-migrate");
    return;
  }

  const migrationsFolder = resolveMigrationsDir();
  logger.info(`migrate: applying pending migrations from ${migrationsFolder}`);
  const db = getDrizzleDb();
  await migrate(db, { migrationsFolder });
  logger.info("migrate: schema is up to date");
}
