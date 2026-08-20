/**
 * Segmentation Controller
 * Ported from legacy backend /v1/board/:board_id/segmentation[/:id].
 *
 * Lean CRUD against the segmentations table — no repository/service layer
 * since there is no business logic beyond the writes.
 */

import { Hono } from "hono";
import { and, eq, desc } from "drizzle-orm";
import type { DatabaseClient } from "../../infrastructure/database/types";
import { getDrizzleDb } from "../../db/drizzle";
import { segmentations } from "../../db/drizzle/schema";
import { BoardService } from "../../core/services/board.service";
import { NotFoundError } from "../../domain/shared/errors";
import logger from "../../infrastructure/logging/logger";

interface SegmentationContext {
  Variables: {
    db: DatabaseClient;
    userId?: string;
    organizationId?: string;
    businessUnitId?: string;
  };
}

export const segmentationController = new Hono<SegmentationContext>();

const drizzle = () => getDrizzleDb();

// POST /boards/:boardId/segmentation
segmentationController.post("/:boardId/segmentation", async (c) => {
  try {
    const db = c.get("db");
    const boardId = c.req.param("boardId");
    const body = await c.req.json();
    const organizationId = c.get("organizationId");
    const userId = c.get("userId") ?? "";

    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }

    // Resolve the board to pick up business_unit_id (and to return 404 if gone).
    const board = await new BoardService({ db }).getBoard(boardId);

    const [row] = await drizzle()
      .insert(segmentations)
      .values({
        business_unit_id: (board as any).business_unit_id ?? "",
        organization_id: organizationId,
        board_id: boardId,
        user_id: userId,
        name: body?.name ?? null,
        description: body?.description ?? null,
        filters: Array.isArray(body?.filters) ? body.filters : [],
      })
      .returning();

    return c.json(row);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error creating segmentation:", error);
    return c.json(
      { error: "Failed to create segmentation", message: (error as Error).message },
      500,
    );
  }
});

// GET /boards/:boardId/segmentation
segmentationController.get("/:boardId/segmentation", async (c) => {
  try {
    const boardId = c.req.param("boardId");
    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }
    const rows = await drizzle()
      .select()
      .from(segmentations)
      .where(
        and(
          eq(segmentations.board_id, boardId),
          eq(segmentations.organization_id, organizationId),
        ),
      )
      .orderBy(desc(segmentations.created_at));
    return c.json({ data: rows });
  } catch (error) {
    logger.error("Error listing segmentations:", error);
    return c.json(
      { error: "Failed to list segmentations", message: (error as Error).message },
      500,
    );
  }
});

// GET /boards/:boardId/segmentation/:id
segmentationController.get("/:boardId/segmentation/:id", async (c) => {
  try {
    const boardId = c.req.param("boardId");
    const id = c.req.param("id");
    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }
    const [row] = await drizzle()
      .select()
      .from(segmentations)
      .where(
        and(
          eq(segmentations.id, id),
          eq(segmentations.board_id, boardId),
          eq(segmentations.organization_id, organizationId),
        ),
      )
      .limit(1);
    if (!row) return c.json({ error: "Segmentation not found" }, 404);
    return c.json(row);
  } catch (error) {
    logger.error("Error getting segmentation:", error);
    return c.json(
      { error: "Failed to get segmentation", message: (error as Error).message },
      500,
    );
  }
});

// PUT /boards/:boardId/segmentation/:id
segmentationController.put("/:boardId/segmentation/:id", async (c) => {
  try {
    const boardId = c.req.param("boardId");
    const id = c.req.param("id");
    const body = await c.req.json();
    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }

    const patch: Record<string, any> = { updated_at: new Date() };
    if (body?.name !== undefined) patch.name = body.name;
    if (body?.description !== undefined) patch.description = body.description;
    if (Array.isArray(body?.filters)) patch.filters = body.filters;

    const [row] = await drizzle()
      .update(segmentations)
      .set(patch)
      .where(
        and(
          eq(segmentations.id, id),
          eq(segmentations.board_id, boardId),
          eq(segmentations.organization_id, organizationId),
        ),
      )
      .returning();
    if (!row) return c.json({ error: "Segmentation not found" }, 404);
    return c.json(row);
  } catch (error) {
    logger.error("Error updating segmentation:", error);
    return c.json(
      { error: "Failed to update segmentation", message: (error as Error).message },
      500,
    );
  }
});

// DELETE /boards/:boardId/segmentation/:id
segmentationController.delete("/:boardId/segmentation/:id", async (c) => {
  try {
    const boardId = c.req.param("boardId");
    const id = c.req.param("id");
    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }
    const [row] = await drizzle()
      .delete(segmentations)
      .where(
        and(
          eq(segmentations.id, id),
          eq(segmentations.board_id, boardId),
          eq(segmentations.organization_id, organizationId),
        ),
      )
      .returning();
    if (!row) return c.json({ error: "Segmentation not found" }, 404);
    return c.json({ message: "is deleted" });
  } catch (error) {
    logger.error("Error deleting segmentation:", error);
    return c.json(
      { error: "Failed to delete segmentation", message: (error as Error).message },
      500,
    );
  }
});
