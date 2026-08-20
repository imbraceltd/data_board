/**
 * Document AI Category Controller.
 *
 * Mounted at the router root — full paths become:
 *   GET    /api/categories
 *   GET    /api/categories/:id
 *   POST   /api/categories
 *   PUT    /api/categories/:id
 *   DELETE /api/categories/:id
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { DatabaseClient } from "../../infrastructure/database/types";
import { DocCategoryService } from "../../core/services/doc-category.service";
import {
  docCategoryListQuerySchema,
  createDocCategorySchema,
  updateDocCategorySchema,
} from "../schemas/doc-category.schema";
import {
  NotFoundError,
  ValidationError,
} from "../../domain/shared/errors";
import logger from "../../infrastructure/logging/logger";

export interface DocCategoryControllerContext {
  Variables: {
    db: DatabaseClient;
    userId?: string;
    organizationId?: string;
    businessUnitId?: string;
    teamIds?: string[];
  };
}

export const docCategoryController = new Hono<DocCategoryControllerContext>();

/**
 * GET /categories — list as tree, supports `type` filter + search + pagination
 */
docCategoryController.get(
  "/categories",
  zValidator("query", docCategoryListQuerySchema),
  async (c) => {
    try {
      const organizationId = c.get("organizationId");
      if (!organizationId) {
        return c.json({ error: "Organization ID required" }, 401);
      }
      const db = c.get("db");
      const { search, type, limit, skip } = c.req.valid("query");
      const service = new DocCategoryService({ db });
      const { data, count } = await service.listAsTree(organizationId, {
        search,
        type,
        limit,
        skip,
      });
      return c.json({
        data,
        count,
        limit: limit ?? null,
        skip: skip ?? 0,
      });
    } catch (error) {
      logger.error("Error listing doc categories:", error);
      return c.json(
        {
          error: "Failed to list categories",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * GET /categories/:id — full subtree rooted at this id
 */
docCategoryController.get("/categories/:id", async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");
    const service = new DocCategoryService({ db });
    const tree = await service.getTreeFromRoot(id);
    return c.json({ data: tree });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error getting doc category:", error);
    return c.json(
      { error: "Failed to get category", message: (error as Error).message },
      500,
    );
  }
});

/**
 * POST /categories — `type` is required (400 if missing/invalid)
 */
docCategoryController.post(
  "/categories",
  zValidator("json", createDocCategorySchema),
  async (c) => {
    try {
      const organizationId = c.get("organizationId");
      if (!organizationId) {
        return c.json({ error: "Organization ID required" }, 401);
      }
      const db = c.get("db");
      const body = c.req.valid("json");
      const service = new DocCategoryService({ db });
      const created = await service.create({
        organization_id: organizationId,
        name: body.name,
        type: body.type,
        parentId: body.parentId ?? null,
      });
      return c.json({ data: created }, 201);
    } catch (error) {
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      logger.error("Error creating doc category:", error);
      return c.json(
        {
          error: "Failed to create category",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * PUT /categories/:id
 */
docCategoryController.put(
  "/categories/:id",
  zValidator("json", updateDocCategorySchema),
  async (c) => {
    try {
      const db = c.get("db");
      const id = c.req.param("id");
      const body = c.req.valid("json");
      const service = new DocCategoryService({ db });
      const updated = await service.update(id, body);
      return c.json({ data: updated });
    } catch (error) {
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      logger.error("Error updating doc category:", error);
      return c.json(
        {
          error: "Failed to update category",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * DELETE /categories/:id — delete this category only.
 * Direct children are promoted up to the deleted node's parent (or to root).
 * Schemas attached to the deleted category have their category_id cleared
 * so they show up under the 'All' tab on the FE.
 */
docCategoryController.delete("/categories/:id", async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");
    const service = new DocCategoryService({ db });
    await service.delete(id);
    return c.body(null, 204);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error deleting doc category:", error);
    return c.json(
      {
        error: "Failed to delete category",
        message: (error as Error).message,
      },
      500,
    );
  }
});
