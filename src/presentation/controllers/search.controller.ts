/**
 * Search Controller
 * Handles search, multi-search, and fetch endpoints
 * Maintains backward compatibility with Meilisearch API
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { DatabaseClient } from "../../infrastructure/database/types";
import { SearchProviderFactory } from "../../core/services/search";
import { BoardItemService } from "../../core/services/board-item.service";
import logger from "../../infrastructure/logging/logger";

// Context type for dependency injection
export interface SearchControllerContext {
  Variables: {
    db: DatabaseClient;
    userId?: string;
    organizationId?: string;
    teamIds?: string[];
  };
}

export const searchController = new Hono<SearchControllerContext>();

// ========================================
// Validation Schemas
// ========================================

const searchSchema = z.object({
  q: z.string().optional(),
  filter: z.string().optional(),
  // Callers (e.g. the Workflow "Automate Databoard" filtered-search action)
  // pass a large limit (10000) to mean "all matching". The Postgres search
  // provider turns this into a real SQL LIMIT, so raise the ceiling to accept
  // that legacy value rather than 400ing on it.
  limit: z.number().int().positive().max(10000).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
  sort: z.array(z.string()).optional(),
});

const multiSearchQuerySchema = z.object({
  indexUid: z.string(),
  q: z.string().optional(),
  filter: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().min(0).optional(),
  sort: z.array(z.string()).optional(),
});

const multiSearchSchema = z.object({
  queries: z.array(multiSearchQuerySchema),
});

const fetchSchema = z.object({
  limit: z.number().int().positive().max(1000).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
  filter: z.string().optional(),
});

// ========================================
// Endpoints
// ========================================

/**
 * POST /search/multi
 * Multi-board search
 * NOTE: must be registered before /:boardId to avoid route shadowing
 */
searchController.post(
  "/multi",
  zValidator("json", multiSearchSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const organizationId = c.get("organizationId");
      const { queries } = c.req.valid("json");

      // Inject organization_id filter for all queries
      const enhancedQueries = queries.map((q) => {
        let filter = q.filter || "";
        if (organizationId) {
          const orgFilter = `organization_id = '${organizationId}'`;
          filter = filter ? `${filter} AND ${orgFilter}` : orgFilter;
        }
        return {
          ...q,
          filter,
        };
      });

      // Create search provider
      const searchProvider = SearchProviderFactory.createFromDatabaseClient(db);

      // Execute multi-search
      const result = await searchProvider.multiSearch(enhancedQueries);

      // Return in Meilisearch-compatible format
      return c.json(
        {
          success: true,
          message: result,
        },
        200
      );
    } catch (error) {
      logger.error("Multi-search error:", error);

      return c.json(
        {
          success: false,
          code: 50000,
          message: "Multi-search service error",
          error: (error as Error).message,
        },
        500
      );
    }
  }
);

/**
 * POST /search/:boardId
 * Single board search
 */
searchController.post(
  "/:boardId",
  zValidator("json", searchSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const boardId = c.req.param("boardId");
      const organizationId = c.get("organizationId");
      const payload = c.req.valid("json");

      // Inject organization_id filter for security
      let finalFilter = payload.filter || "";
      if (organizationId) {
        const orgFilter = `organization_id = '${organizationId}'`;
        finalFilter = finalFilter
          ? `${finalFilter} AND ${orgFilter}`
          : orgFilter;
      }

      // Create search provider
      const searchProvider = SearchProviderFactory.createFromDatabaseClient(db);

      // Execute search
      const result = await searchProvider.search(boardId, {
        q: payload.q,
        filter: finalFilter,
        limit: payload.limit || 20,
        offset: payload.offset || 0,
        sort: payload.sort,
      });

      // Hydrate TableInTable fields so search hits match the /items shape
      // (raw child-id arrays → { count, sum, data }).
      const boardItemService = new BoardItemService({ db });
      await boardItemService.hydrateTitForBoard(boardId, result.hits);

      // Return in Meilisearch-compatible format
      return c.json(
        {
          success: true,
          message: result,
        },
        200
      );
    } catch (error) {
      logger.error("Search error:", error);

      return c.json(
        {
          success: false,
          code: 50000,
          message: "Search service error",
          error: (error as Error).message,
        },
        500
      );
    }
  }
);

/**
 * POST /search/:boardId/fetch
 * Fetch documents (filtered list without text search)
 */
searchController.post(
  "/:boardId/fetch",
  zValidator("json", fetchSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const boardId = c.req.param("boardId");
      const organizationId = c.get("organizationId");
      const payload = c.req.valid("json");

      // Inject organization_id filter
      let finalFilter = payload.filter || "";
      if (organizationId) {
        const orgFilter = `organization_id = '${organizationId}'`;
        finalFilter = finalFilter
          ? `${finalFilter} AND ${orgFilter}`
          : orgFilter;
      }

      // Create search provider
      const searchProvider = SearchProviderFactory.createFromDatabaseClient(db);

      // Execute fetch
      const result = await searchProvider.fetch(boardId, {
        limit: payload.limit || 20,
        offset: payload.offset || 0,
        filter: finalFilter,
      });

      // Hydrate TableInTable fields so fetch results match the /items shape.
      // Note: FetchResult uses `results` (not `hits`).
      const boardItemService = new BoardItemService({ db });
      await boardItemService.hydrateTitForBoard(boardId, result.results);

      // Return in Meilisearch-compatible format
      return c.json(
        {
          success: true,
          message: result,
        },
        200
      );
    } catch (error) {
      logger.error("Fetch error:", error);

      return c.json(
        {
          success: false,
          code: 50000,
          message: "Fetch service error",
          error: (error as Error).message,
        },
        500
      );
    }
  }
);
