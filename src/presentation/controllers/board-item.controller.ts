/**
 * BoardItem Controller
 * Hono endpoints for board item management
 */

import { Context, Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { DatabaseClient } from "../../infrastructure/database/types";
import { BoardItemService } from "../../core/services/board-item.service";
import { publishAudit, buildBoardItemChanges } from "../../core/services/audit-publisher";
import { createNotifications, NotificationType } from "../../core/services/notification-client";
import { BoardService } from "../../core/services/board.service";
import { BoardType, BoardFieldType } from "../../domain/shared/board.types";
import {
  createBoardItemSchema,
  updateBoardItemSchema,
  bulkCreateBoardItemsSchema,
  bulkUpdateBoardItemsSchema,
  updateByFilterSchema,
  deleteByFilterSchema,
  queryOptionsSchema,
  linkRelatedItemsSchema,
  unlinkRelatedItemsSchema,
} from "../schemas/board-item.schema";
import {
  ValidationError,
  NotFoundError,
  ConflictError,
} from "../../domain/shared/errors";
import logger from "../../infrastructure/logging/logger";
import config from "../../config";

// Cross-service lookup — Contacts-type board items embed the linked contact
// from channel-service so the FE's CRM panel can read display_name, email,
// channel_type, etc. off `data.contacts` without an extra round-trip. Same
// pattern as board.controller's /boards/by-contact/:id but in the other
// direction (item → contact).
async function fetchContactFromChannelService(
  c: Context,
  path: string,
): Promise<any | null> {
  const headers: Record<string, string> = {};
  const orgId = c.req.header("x-organization-id") ?? c.get("organizationId");
  const userId = c.req.header("x-user-id") ?? c.get("userId");
  if (orgId) headers["x-organization-id"] = orgId;
  if (userId) headers["x-user-id"] = userId;
  try {
    const res = await fetch(`${config.channelServiceUrl}${path}`, { headers });
    if (!res.ok) return null;
    const payload: any = await res.json();
    const contact = payload?.data ?? payload;
    if (!contact?.id) return null;
    // FE reads contacts._id; expose both. id mirror keeps the entity-style
    // consumers happy too.
    return { ...contact, _id: contact.id, id: contact.id };
  } catch (err) {
    logger.warn(
      `fetchContact: cross-service lookup failed for ${path}: ${(err as Error).message}`,
    );
    return null;
  }
}

async function resolveContactForItem(
  c: Context,
  item: any,
): Promise<any | null> {
  // Forward link first: fields.contact_id is the canonical path when present.
  const directContactId = item?.fields?.contact_id as string | undefined;
  if (directContactId) {
    const direct = await fetchContactFromChannelService(
      c,
      `/v1/contacts/${encodeURIComponent(directContactId)}`,
    );
    if (direct) return direct;
  }
  // Reverse link: legacy/dev data doesn't carry fields.contact_id on the
  // item, but contact.board_item_id points back to this row. channel-service
  // exposes /contacts/by-board-item/:id for exactly this lookup.
  if (item?.id) {
    return fetchContactFromChannelService(
      c,
      `/v1/contacts/by-board-item/${encodeURIComponent(item.id)}`,
    );
  }
  return null;
}

// Build the assignee-hydration context from gateway headers / request context.
// Forwarded to BoardItemService so assignee/people field values are resolved
// to { id, display_name, email, avatar_url } via platform-service.
function assigneeCtx(c: Context): {
  organizationId?: string;
  userId?: string;
  accessToken?: string;
} {
  return {
    organizationId: c.req.header("x-organization-id") ?? c.get("organizationId"),
    userId: c.req.header("x-user-id") ?? c.get("userId"),
    accessToken:
      c.req.header("x-access-token") ??
      c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
      c.get("accessToken"),
  };
}

// Context type
export interface BoardItemControllerContext {
  Variables: {
    db: DatabaseClient;
    userId?: string;
    organizationId?: string;
    accessToken?: string;
    teamIds?: string[];
  };
}

export const boardItemController = new Hono<BoardItemControllerContext>();

/**
 * Emit a board-item audit event (fire-and-forget). Resolves the board's field
 * definitions to produce a human-readable resourceName (identifier field) +
 * label-based before/after diff; falls back to the raw items if the board
 * lookup fails. Never throws — audit must not break the mutation.
 */
async function emitBoardItemAudit(args: {
  db: any;
  boardId: string;
  organizationId?: string;
  userId?: string;
  action: "create" | "update" | "delete";
  itemId: string;
  before: any;
  after: any;
}): Promise<void> {
  const { db, boardId, organizationId, userId, action, itemId, before, after } = args;
  if (!organizationId) return;
  let resourceName: string | null = null;
  let changes: { before: unknown; after: unknown; fields?: unknown } = { before, after };
  try {
    const board = await new BoardService({ db }).getBoard(boardId);
    const built = buildBoardItemChanges(board as any, before, after);
    resourceName = built.resourceName;
    changes = built.changes;
  } catch {
    /* board lookup failed — fall back to raw before/after */
  }
  publishAudit([{
    organizationId,
    userId,
    action,
    resource: "board_item",
    resourceId: itemId,
    resourceName,
    changes,
    metadata: { boardId, source: "board" },
  }]);
}

/**
 * Notify users newly added to an item's Assignee / MultipleAssignee field
 * (CRM_ASSIGN, type 101) — ports the monolith's board.js ASSIGNEE handler.
 * Diffs before/after assignee values, takes the set of assignee `_id`s present
 * in `after` but not `before`, and POSTs a notification to each (excluding the
 * editor). title/content = record name, from = editor, action_to carries the
 * board + item id. Fire-and-forget; never throws.
 */
async function notifyCrmAssign(args: {
  db: any;
  boardId: string;
  organizationId?: string;
  userId?: string;
  itemId: string;
  before: any;
  after: any;
}): Promise<void> {
  const { db, boardId, organizationId, userId, itemId, before, after } = args;
  if (!organizationId) return;
  try {
    const board = await new BoardService({ db }).getBoard(boardId);
    const fields = (board?.fields ?? []) as Array<{ id: string; type: BoardFieldType }>;
    const assigneeFieldIds = fields
      .filter((f) => f.type === BoardFieldType.ASSIGNEE || f.type === BoardFieldType.MULTI_ASSIGNEE)
      .map((f) => f.id);
    if (assigneeFieldIds.length === 0) return;

    const beforeFields = (before?.fields ?? {}) as Record<string, unknown>;
    const afterFields = (after?.fields ?? {}) as Record<string, unknown>;

    // Collect assignee user ids (AssigneeValue._id) from a single field value,
    // which is either one object or an array of them.
    const idsOf = (val: unknown): Set<string> => {
      const out = new Set<string>();
      const arr = Array.isArray(val) ? val : val ? [val] : [];
      for (const a of arr) {
        const id = (a as any)?._id ?? (a as any)?.id;
        if (id) out.add(String(id));
      }
      return out;
    };

    const newlyAssigned = new Set<string>();
    for (const fid of assigneeFieldIds) {
      const beforeIds = idsOf(beforeFields[fid]);
      for (const id of idsOf(afterFields[fid])) {
        if (!beforeIds.has(id)) newlyAssigned.add(id);
      }
    }
    // Don't notify the actor about their own assignment.
    if (userId) newlyAssigned.delete(userId);
    if (newlyAssigned.size === 0) return;

    const { resourceName } = buildBoardItemChanges(board as any, before, after);
    const recordName = resourceName ?? "";

    await createNotifications(
      organizationId,
      [...newlyAssigned].map((recipient) => ({
        type: NotificationType.CRM_ASSIGN,
        recipient,
        from: userId ?? "",
        title: recordName,
        content: recordName,
        action_to: { board_id: boardId, board_item_id: itemId },
      })),
    );
  } catch (err) {
    logger.warn(`notifyCrmAssign failed: ${(err as Error).message}`);
  }
}

/**
 * GET /boards/:boardId/items
 * List board items with pagination
 */
boardItemController.get(
  "/:boardId/items",
  zValidator("query", queryOptionsSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const boardId = c.req.param("boardId");
      const queryOptions = c.req.valid("query");

      const boardItemService = new BoardItemService({ db });

      // If filter provided in query, use findByFilter, otherwise use findByBoard
      const result = queryOptions.filter
        ? await boardItemService.getBoardItemsByFilter(
            boardId,
            queryOptions.filter,
            queryOptions,
            assigneeCtx(c),
          )
        : await boardItemService.getBoardItems(
            boardId,
            queryOptions,
            assigneeCtx(c),
          );

      if (queryOptions.include_parent) {
        await boardItemService.enrichWithParents(result.data);
      }

      // Flatten fields to top level for backward compatibility with frontend
      // (table columns use accessorKey=field._id expecting values at row root)
      const data = result.data.map((item) => ({
        ...item,
        ...(item.fields || {}),
      }));

      if (queryOptions.include_parent) {
        // New envelope: { data, count, total, has_more }. `count` = page size,
        // `total` = matching rows. Old envelope (skip/limit/totalPages) kept
        // for callers that don't opt in.
        return c.json({
          data,
          count: data.length,
          total: result.count,
          has_more: result.skip + data.length < result.count,
        });
      }

      return c.json({ ...result, data });
    } catch (error) {
      logger.error("Error listing board items:", error);
      return c.json(
        {
          error: "Failed to list board items",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * GET /boards/:boardId/items/count
 * Count board items (must be before /:id to avoid route shadowing)
 */
boardItemController.get("/:boardId/items/count", async (c) => {
  try {
    const db = c.get("db");
    const boardId = c.req.param("boardId");
    const filter = c.req.query("filter");

    const boardItemService = new BoardItemService({ db });
    const count = await boardItemService.count(
      boardId,
      filter ? JSON.parse(filter) : undefined,
    );

    return c.json({ count });
  } catch (error) {
    logger.error("Error counting board items:", error);
    return c.json(
      {
        error: "Failed to count board items",
        message: (error as Error).message,
      },
      500,
    );
  }
});

/**
 * GET /boards/:boardId/items/:id/details
 *
 * Legacy-compatible read that returns the item's fields keyed by
 * human-readable name and wrapped as `{ data: [row], count: 1 }`. Replaces
 * the pre-migration backend route `GET /:id/board_item_details/:item_id`.
 * Registered before `/:boardId/items/:id` so Hono matches the more
 * specific path first.
 */
boardItemController.get("/:boardId/items/:id/details", async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");

    const boardItemService = new BoardItemService({ db });
    const result = await boardItemService.getBoardItemDetails(id);

    return c.json(result);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ message: error.message }, 404);
    }
    logger.error("Error getting board item details:", error);
    return c.json(
      {
        error: "Failed to get board item details",
        message: (error as Error).message,
      },
      500,
    );
  }
});

/**
 * GET /boards/:boardId/items/:id
 * Get board item by ID. Contacts-type boards also embed the linked
 * contact under `contacts` so the chatroom CRM panel doesn't have to make
 * a separate /v1/contacts/:id call.
 */
boardItemController.get("/:boardId/items/:id", async (c) => {
  try {
    const db = c.get("db");
    const boardId = c.req.param("boardId");
    const id = c.req.param("id");

    const boardItemService = new BoardItemService({ db });
    const boardService = new BoardService({ db });
    const [item, board] = await Promise.all([
      boardItemService.getBoardItem(id, assigneeCtx(c)),
      boardService.getBoard(boardId).catch(() => null),
    ]);

    // Only Contacts boards carry a contact link; skip the lookup for every
    // other board type so we don't spend a round-trip per row. Try forward
    // (fields.contact_id) then reverse (contact.board_item_id) — dev/legacy
    // data only has the reverse pointer set.
    let contacts: any = undefined;
    if (board?.type === BoardType.CONTACTS) {
      contacts = await resolveContactForItem(c, item);
    }

    return c.json({
      data: { ...item, ...(contacts !== undefined ? { contacts } : {}) },
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error getting board item:", error);
    return c.json(
      {
        error: "Failed to get board item",
        message: (error as Error).message,
      },
      500,
    );
  }
});

/**
 * GET /boards/:boardId/items/by-contact/:contactId
 * Get board item by contact ID
 */
boardItemController.get("/:boardId/items/by-contact/:contactId", async (c) => {
  try {
    const db = c.get("db");
    const contactId = c.req.param("contactId");

    const boardItemService = new BoardItemService({ db });
    const item = await boardItemService.getBoardItemByContactId(contactId);

    if (!item) {
      return c.json({ error: "Board item not found" }, 404);
    }

    return c.json({ data: item });
  } catch (error) {
    logger.error("Error getting board item by contact:", error);
    return c.json(
      {
        error: "Failed to get board item",
        message: (error as Error).message,
      },
      500,
    );
  }
});

/**
 * POST /boards/:boardId/items
 * Create a new board item
 */
boardItemController.post(
  "/:boardId/items",
  zValidator("json", createBoardItemSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const userId = c.get("userId");
      const organizationId = c.get("organizationId");
      const boardId = c.req.param("boardId");
      const data = {
        ...c.req.valid("json"),
        board_id: boardId,
        ...(organizationId && !c.req.valid("json").organization_id && { organization_id: organizationId }),
      };

      const boardItemService = new BoardItemService({ db });
      const item = await boardItemService.createBoardItem(data, assigneeCtx(c));

      logger.info(`Board item created by user ${userId}: ${item.id}`);
      void emitBoardItemAudit({
        db, boardId, organizationId, userId,
        action: "create", itemId: item.id, before: null, after: item,
      });
      return c.json({ data: item }, 201);
    } catch (error) {
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof ConflictError) {
        return c.json({ error: error.message }, 409);
      }
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      logger.error("Error creating board item:", error);
      return c.json(
        {
          error: "Failed to create board item",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * POST /boards/:boardId/items/bulk
 * Create multiple board items
 */
boardItemController.post(
  "/:boardId/items/bulk",
  zValidator("json", bulkCreateBoardItemsSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const userId = c.get("userId");
      const boardId = c.req.param("boardId");
      const { items } = c.req.valid("json");

      const boardItemService = new BoardItemService({ db });
      const createdItems = await boardItemService.createMultipleBoardItems(
        boardId,
        items,
        assigneeCtx(c),
      );

      logger.info(
        `${createdItems.length} board items bulk created by user ${userId}`,
      );
      return c.json({ data: createdItems, count: createdItems.length }, 201);
    } catch (error) {
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof ConflictError) {
        return c.json({ error: error.message }, 409);
      }
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      logger.error("Error bulk creating board items:", error);
      return c.json(
        {
          error: "Failed to bulk create board items",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * PATCH /boards/:boardId/items/bulk-update
 * Update multiple board items (must be before /:id)
 */
boardItemController.patch(
  "/:boardId/items/bulk-update",
  zValidator("json", bulkUpdateBoardItemsSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const { ids, updates } = c.req.valid("json");

      const boardItemService = new BoardItemService({ db });
      const count = await boardItemService.updateMultipleBoardItems(
        ids,
        updates,
      );

      return c.json({ message: `${count} items updated`, count });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      logger.error("Error bulk updating board items:", error);
      return c.json(
        {
          error: "Failed to bulk update board items",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * PATCH /boards/:boardId/items/update-by-filter
 * Update board items by filter
 */
boardItemController.patch(
  "/:boardId/items/update-by-filter",
  zValidator("json", updateByFilterSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const boardId = c.req.param("boardId");
      const { filter, updates } = c.req.valid("json");

      const boardItemService = new BoardItemService({ db });
      const count = await boardItemService.updateBoardItemsByFilter(
        boardId,
        filter,
        updates,
      );

      return c.json({ message: `${count} items updated`, count });
    } catch (error) {
      logger.error("Error updating board items by filter:", error);
      return c.json(
        {
          error: "Failed to update board items",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * PATCH /boards/:boardId/items/:id
 * Update board item (after static routes to avoid shadowing)
 */
boardItemController.patch(
  "/:boardId/items/:id",
  zValidator("json", updateBoardItemSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const id = c.req.param("id");
      const boardId = c.req.param("boardId");
      const organizationId = c.get("organizationId");
      const userId = c.get("userId");
      const updates = c.req.valid("json");

      const boardItemService = new BoardItemService({ db });
      // capture before-state for the audit trail (non-fatal)
      let before: unknown = null;
      try { before = await boardItemService.getBoardItem(id); } catch { /* ignore */ }
      const item = await boardItemService.updateBoardItem(id, updates, assigneeCtx(c));

      void emitBoardItemAudit({
        db, boardId, organizationId, userId,
        action: "update", itemId: id, before, after: item,
      });
      void notifyCrmAssign({
        db, boardId, organizationId, userId, itemId: id, before, after: item,
      });
      return c.json({ data: item });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof ConflictError) {
        return c.json({ error: error.message }, 409);
      }
      logger.error("Error updating board item:", error);
      return c.json(
        {
          error: "Failed to update board item",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

// PUT /boards/:boardId/items/:id — backward-compat alias for PATCH
boardItemController.on(["PUT"], "/:boardId/items/:id", zValidator("json", updateBoardItemSchema), async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");
    const boardId = c.req.param("boardId");
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const updates = c.req.valid("json");
    const boardItemService = new BoardItemService({ db });
    // capture before-state for the audit trail (non-fatal). The DataBoard UI
    // edits records via PUT (not PATCH), so this is the path that actually
    // needs auditing for inline data-entry changes.
    let before: unknown = null;
    try { before = await boardItemService.getBoardItem(id); } catch { /* ignore */ }
    const item = await boardItemService.updateBoardItem(id, updates, assigneeCtx(c));
    void emitBoardItemAudit({
      db, boardId, organizationId, userId,
      action: "update", itemId: id, before, after: item,
    });
    return c.json({ data: item });
  } catch (error) {
    if (error instanceof NotFoundError) return c.json({ error: (error as Error).message }, 404);
    if (error instanceof ValidationError) return c.json({ error: (error as Error).message }, 400);
    if (error instanceof ConflictError) return c.json({ error: (error as Error).message }, 409);
    return c.json({ error: "Failed to update board item", message: (error as Error).message }, 500);
  }
});

/**
 * DELETE /boards/:boardId/items/bulk-delete
 * Delete multiple board items (must be before /:id).
 *
 * Accepts IDs in any of three shapes (zValidator can't handle repeated query
 * keys, so we parse manually):
 *   - Query bracket array  `?ids[]=a&ids[]=b`     (FE default)
 *   - Query repeated key   `?ids=a&ids=b`
 *   - Query CSV            `?ids=a,b,c`
 *   - JSON body            `{ "ids": ["a","b"] }` (legacy)
 */
boardItemController.delete("/:boardId/items/bulk-delete", async (c) => {
  try {
    const db = c.get("db");

    let ids: string[] = [];
    const bracket = c.req.queries("ids[]");
    if (bracket && bracket.length > 0) {
      ids = bracket;
    } else {
      const plain = c.req.queries("ids");
      if (plain && plain.length > 0) {
        ids = plain.length === 1 && plain[0].includes(",")
          ? plain[0].split(",").map((s) => s.trim()).filter(Boolean)
          : plain;
      } else {
        // Fall back to JSON body if query is empty
        const body = await c.req.json().catch(() => null);
        if (body && Array.isArray(body.ids)) ids = body.ids;
      }
    }

    if (ids.length === 0) {
      return c.json(
        { error: "At least one ID is required (query ?ids[]=... or JSON body)" },
        400,
      );
    }

    const boardItemService = new BoardItemService({ db });
    const count = await boardItemService.deleteMultipleBoardItems(ids);

    return c.json({ message: `${count} items deleted`, count });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error bulk deleting board items:", error);
    return c.json(
      {
        error: "Failed to bulk delete board items",
        message: (error as Error).message,
      },
      500,
    );
  }
});

/**
 * DELETE /boards/:boardId/items/delete-by-filter
 * Delete board items by filter
 */
boardItemController.delete(
  "/:boardId/items/delete-by-filter",
  zValidator("json", deleteByFilterSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const boardId = c.req.param("boardId");
      const { filter } = c.req.valid("json");

      const boardItemService = new BoardItemService({ db });
      const count = await boardItemService.deleteBoardItemsByFilter(
        boardId,
        filter,
      );

      return c.json({ message: `${count} items deleted`, count });
    } catch (error) {
      logger.error("Error deleting board items by filter:", error);
      return c.json(
        {
          error: "Failed to delete board items",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * DELETE /boards/:boardId/items/:id
 * Delete board item (after static routes to avoid shadowing)
 */
boardItemController.delete("/:boardId/items/:id", async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");
    const boardId = c.req.param("boardId");
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");

    const boardItemService = new BoardItemService({ db });
    let before: unknown = null;
    try { before = await boardItemService.getBoardItem(id); } catch { /* ignore */ }
    await boardItemService.deleteBoardItem(id);

    void emitBoardItemAudit({
      db, boardId, organizationId, userId,
      action: "delete", itemId: id, before, after: null,
    });
    return c.json({ message: "Board item deleted successfully" });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error deleting board item:", error);
    return c.json(
      {
        error: "Failed to delete board item",
        message: (error as Error).message,
      },
      500,
    );
  }
});

/**
 * POST /boards/:boardId/items/:id/related
 * Link related board items
 */
boardItemController.post(
  "/:boardId/items/:id/related",
  zValidator("json", linkRelatedItemsSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const itemId = c.req.param("id");
      const { relatedBoardId, relatedItemIds } = c.req.valid("json");

      const boardItemService = new BoardItemService({ db });
      await boardItemService.linkRelatedItems(
        itemId,
        relatedBoardId,
        relatedItemIds,
      );

      return c.json({
        message: `Linked ${relatedItemIds.length} related items`,
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      logger.error("Error linking related items:", error);
      return c.json(
        {
          error: "Failed to link related items",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * DELETE /boards/:boardId/items/:id/related
 * Unlink related board items
 */
boardItemController.delete(
  "/:boardId/items/:id/related",
  zValidator("json", unlinkRelatedItemsSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const itemId = c.req.param("id");
      const { relatedBoardId, relatedItemIds } = c.req.valid("json");

      const boardItemService = new BoardItemService({ db });
      await boardItemService.unlinkRelatedItems(
        itemId,
        relatedBoardId,
        relatedItemIds,
      );

      return c.json({
        message: `Unlinked ${relatedItemIds.length} related items`,
      });
    } catch (error) {
      logger.error("Error unlinking related items:", error);
      return c.json(
        {
          error: "Failed to unlink related items",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * GET /boards/:boardId/items/:id/related/:relatedBoardId
 * Get related board items.
 *
 * Honors the legacy query contract (see backend/src/controllers/board.js
 * getRelatedBoardItemList):
 *   - link  (bool)  "true"  → items already linked to this item
 *                   "false" → CANDIDATE items NOT linked (for "Add Existing")
 *   - name  (str)   filter by the related board's identifier field, or exact
 *                   id when prefixed `bi_`
 *   - skip / limit  pagination
 * Returns { data, count, total, has_more }.
 */
boardItemController.get(
  "/:boardId/items/:id/related/:relatedBoardId",
  async (c) => {
    try {
      const db = c.get("db");
      const itemId = c.req.param("id");
      const relatedBoardId = c.req.param("relatedBoardId");

      // `link` defaults to true (back-compat: bare calls returned linked set).
      const linkParam = c.req.query("link");
      const link = linkParam === undefined ? true : linkParam !== "false";
      const name = c.req.query("name") || undefined;
      const skipParam = Number(c.req.query("skip"));
      const limitParam = Number(c.req.query("limit"));
      const skip = Number.isFinite(skipParam) && skipParam >= 0 ? skipParam : 0;
      const limit =
        Number.isFinite(limitParam) && limitParam >= 0 ? limitParam : 20;

      const boardItemService = new BoardItemService({ db });
      const result = await boardItemService.getRelatedItemsPaginated(
        itemId,
        relatedBoardId,
        { link, name, skip, limit },
      );

      return c.json(result);
    } catch (error) {
      logger.error("Error getting related items:", error);
      return c.json(
        {
          error: "Failed to get related items",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

