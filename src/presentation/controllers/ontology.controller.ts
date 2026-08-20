/**
 * Ontology Controller
 *
 * GET /api/ontologies — derived property-graph view from boards / fields /
 * board_items / table_in_columns. Postgres-only; Mongo deployments get 501.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/drizzle/schema";
import type { DatabaseClient } from "../../infrastructure/database/types";
import { OntologyService } from "../../core/services/ontology.service";
import { ontologyQuerySchema } from "../schemas/ontology.schema";
import { NotFoundError } from "../../domain/shared/errors";
import config from "../../config";
import logger from "../../infrastructure/logging/logger";

export interface OntologyControllerContext {
  Variables: {
    db: DatabaseClient;
    userId?: string;
    organizationId?: string;
    businessUnitId?: string;
    teamIds?: string[];
  };
}

export const ontologyController = new Hono<OntologyControllerContext>();

ontologyController.get(
  "/",
  zValidator("query", ontologyQuerySchema),
  async (c) => {
    if (config.dbType !== "postgres") {
      return c.json(
        {
          error: "Ontology API requires PostgreSQL",
          message:
            "Set DB_TYPE=postgres to enable /api/ontologies. The legacy Mongo path is not implemented in this repo.",
        },
        501,
      );
    }

    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }

    const db = c.get("db");
    const drizzleDb = db.getRawClient() as NodePgDatabase<typeof schema>;
    const query = c.req.valid("query");

    try {
      const service = new OntologyService({ db, drizzleDb });
      const graph = await service.buildGraph(query, { organizationId });
      return c.json(graph);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      logger.error("Failed to build ontology:", error);
      return c.json(
        {
          error: "Failed to build ontology",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);
