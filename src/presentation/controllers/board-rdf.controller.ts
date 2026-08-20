/**
 * Board RDF / SPARQL Controller
 *
 * Exposes:
 *   GET  /boards/:boardId/items-with-relations  — convenience tree of items
 *                                                 + transitively connected
 *                                                 TableInTable child items.
 *   GET  /boards/:boardId/rdf-schema             — compact, self-describing
 *                                                 schema response for LLM
 *                                                 agents that wrap /sparql.
 *   POST /boards/:boardId/sparql                — read-only SPARQL endpoint
 *                                                 scoped to the materialized
 *                                                 RDF graph for that board.
 *
 * Note: the convenience endpoint is mounted at `/items-with-relations`
 * (single segment) rather than `/items/with-relations` so it doesn't collide
 * with `GET /:boardId/items/:id` in board-item.controller.ts.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { DatabaseClient } from "../../infrastructure/database/types";
import {
  buildGraph,
  GraphTooLargeError,
} from "../../core/rdf/graph-builder";
import {
  buildItemTree,
  runQuery,
  SparqlForbiddenError,
} from "../../core/rdf/sparql.service";
import {
  INTROSPECTION_SPARQL,
  schemaSummaryFromBindings,
} from "../../core/rdf/schema-summary";
import {
  withRelationsQuerySchema,
  sparqlQuerySchema,
  sparqlBodySchema,
  rdfSchemaQuerySchema,
} from "../schemas/board-rdf.schema";
import { respond } from "../utils/response-format";
import { NotFoundError } from "../../domain/shared/errors";
import logger from "../../infrastructure/logging/logger";

interface BoardRdfControllerContext {
  Variables: {
    db: DatabaseClient;
    userId?: string;
    organizationId?: string;
    teamIds?: string[];
  };
}

export const boardRdfController = new Hono<BoardRdfControllerContext>();

/**
 * GET /boards/:boardId/items-with-relations?depth=N&limit=L&offset=O
 *
 * Returns a paginated list of items belonging to the board, each annotated
 * with `children` — a map keyed by parent field id to nested arrays of
 * TableInTable-connected child items, recursively up to `depth`.
 */
boardRdfController.get(
  "/:boardId/items-with-relations",
  zValidator("query", withRelationsQuerySchema),
  async (c) => {
    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Organization context required" }, 401);
    }
    const db = c.get("db");
    const boardId = c.req.param("boardId");
    const { depth, limit, offset, item_id, format } = c.req.valid("query");

    try {
      const { store, rootBoard, boardIds, itemCount, linkCount } =
        await buildGraph(db, {
          rootBoardId: boardId,
          organizationId,
          maxDepth: depth,
        });

      const tree = buildItemTree(store, {
        rootBoardId: rootBoard.id ?? rootBoard._id,
        limit,
        offset,
        itemId: item_id,
      });

      return respond(c, {
        ...tree,
        skip: offset,
        limit,
        meta: {
          depth,
          boardCount: boardIds.length,
          itemCount,
          linkCount,
        },
      }, format);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof GraphTooLargeError) {
        return c.json({ error: error.message }, 413);
      }
      logger.error("[board-rdf] with-relations failed:", error);
      return c.json(
        {
          error: "Failed to build relation tree",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * GET /boards/:boardId/rdf-schema?depth=N
 *
 * Self-describing schema discovery for LLM agents. Returns the boards,
 * fields, types, TableInTable → child-board edges, item counts, and the
 * RDF vocabulary used by the /sparql endpoint. One call gives an agent
 * everything it needs to compose a valid SPARQL query.
 */
boardRdfController.get(
  "/:boardId/rdf-schema",
  zValidator("query", rdfSchemaQuerySchema),
  async (c) => {
    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Organization context required" }, 401);
    }
    const db = c.get("db");
    const boardId = c.req.param("boardId");
    const { depth, format } = c.req.valid("query");

    try {
      const { store, rootBoard, boardIds, itemCount, linkCount } =
        await buildGraph(db, {
          rootBoardId: boardId,
          organizationId,
          maxDepth: depth,
        });

      const result = runQuery(store, INTROSPECTION_SPARQL);
      if (result.kind !== "select") {
        // Shouldn't happen — INTROSPECTION_SPARQL is a SELECT.
        return c.json(
          { error: "Unexpected SPARQL result kind", kind: result.kind },
          500,
        );
      }

      const summary = schemaSummaryFromBindings(
        result.data,
        store,
        rootBoard.id ?? rootBoard._id,
      );

      return respond(c, {
        ...summary,
        meta: {
          depth,
          boardCount: boardIds.length,
          itemCount,
          linkCount,
        },
      }, format);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof GraphTooLargeError) {
        return c.json({ error: error.message }, 413);
      }
      logger.error("[board-rdf] rdf-schema failed:", error);
      return c.json(
        {
          error: "Failed to build RDF schema",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * POST /boards/:boardId/sparql?depth=N
 * Body: { query: "<SPARQL>" }
 *
 * Runs a read-only SPARQL query against the in-memory RDF graph
 * materialized from the board and its TableInTable closure.
 */
boardRdfController.post(
  "/:boardId/sparql",
  zValidator("query", sparqlQuerySchema),
  zValidator("json", sparqlBodySchema),
  async (c) => {
    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Organization context required" }, 401);
    }
    const db = c.get("db");
    const boardId = c.req.param("boardId");
    const { depth, format, hydrate, limit, offset } = c.req.valid("query");
    const { query } = c.req.valid("json");

    try {
      const { store } = await buildGraph(db, {
        rootBoardId: boardId,
        organizationId,
        maxDepth: depth,
      });

      const accept = c.req.header("accept") ?? "";
      const rdfFormat = accept.includes("text/turtle")
        ? "text/turtle"
        : "application/n-triples";

      const result = runQuery(store, query, { rdfFormat, hydrate, limit, offset });

      if (result.kind === "graph") {
        // CONSTRUCT / DESCRIBE — RDF body regardless of ?format.
        return c.body(result.data, 200, { "content-type": result.format });
      }
      // SELECT / ASK — honors ?format=yaml for token-efficient LLM consumption.
      return respond(c, result.data, format);
    } catch (error) {
      if (error instanceof SparqlForbiddenError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof GraphTooLargeError) {
        return c.json({ error: error.message }, 413);
      }
      logger.error("[board-rdf] sparql failed:", error);
      return c.json(
        {
          error: "SPARQL query failed",
          message: (error as Error).message,
        },
        400,
      );
    }
  },
);
