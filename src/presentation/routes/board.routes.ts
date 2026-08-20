/**
 * Board Routes Configuration
 * Configures all board-related routes with middleware
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/drizzle/schema";
import { boardController, boardItemController, searchController } from "../controllers";
import {
  injectDatabase,
  extractUserContext,
  requireOrganization,
  requestLogger,
  corsConfig,
} from "../middleware";
import { errorHandler } from "../middleware/error.middleware";

/**
 * Create board routes with all middleware configured
 */
export function createBoardRoutes(db: NodePgDatabase<typeof schema>) {
  const app = new Hono();

  // Global middleware
  app.use("*", cors(corsConfig()));
  app.use("*", requestLogger());
  app.use("*", errorHandler());
  app.use("*", injectDatabase(db));
  app.use("*", extractUserContext());

  // Health check (no auth required)
  app.get("/health", (c) => {
    return c.json({
      status: "healthy",
      service: "data_board",
      timestamp: new Date().toISOString(),
    });
  });

  // Board routes (require organization context)
  app.route("/boards", boardController);

  // BoardItem routes are nested under boards
  // They're handled by boardItemController which uses /:boardId/items pattern
  app.route("/boards", boardItemController);

  // Search routes (backward compatible with Meilisearch API)
  // POST /search/:boardId -> search in single board
  // POST /search/multi -> multi-board search
  // POST /search/:boardId/fetch -> fetch without search
  app.route("/search", searchController);

  return app;
}

/**
 * API version wrapper
 */
export function createApiV1Routes(db: NodePgDatabase<typeof schema>) {
  const app = new Hono();

  // Mount board routes under /api/v1
  app.route("/", createBoardRoutes(db));

  return app;
}
