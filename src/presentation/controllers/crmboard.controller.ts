/**
 * CRMBoard Controller — mirrors the IPS /v1/crmboard surface so the
 * frontend can switch the call target with no path or payload changes.
 * Auth is delegated to the gateway, which injects `x-user-id` /
 * `x-organization-id` headers.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { DatabaseClient } from "../../infrastructure/database/types";
import { CRMBoardRepository } from "../../infrastructure/database/repositories/crmboard.repository";
import { CRMBoardService } from "../../core/services/crmboard.service";
import {
  ValidationError,
  NotFoundError,
} from "../../domain/shared/errors";
import logger from "../../infrastructure/logging/logger";

interface CRMBoardContext {
  Variables: {
    db: DatabaseClient;
    userId?: string;
    organizationId?: string;
  };
}

export const crmboardController = new Hono<CRMBoardContext>();

const repo = (c: Context<CRMBoardContext>) =>
  new CRMBoardRepository(c.get("db"));
const service = (c: Context<CRMBoardContext>) =>
  new CRMBoardService(c.get("db"));

/** Resolve organization_id from gateway header (preferred) or body. */
function resolveOrgId(c: Context<CRMBoardContext>, body?: any): string | null {
  return (
    c.get("organizationId") ||
    c.req.header("x-organization-id") ||
    body?.organization_id ||
    null
  );
}

/** Map our domain errors to legacy IPS HTTP shapes. */
function mapErrorResponse(err: unknown): { status: 400 | 404 | 500; body: any } {
  if (err instanceof ValidationError) {
    return { status: 400, body: { message: err.message } };
  }
  if (err instanceof NotFoundError) {
    return { status: 404, body: { message: err.message } };
  }
  return {
    status: 500,
    body: { message: (err as Error)?.message || String(err) },
  };
}

// GET /crmboard/search?folder_id=...&board_id=...
crmboardController.get("/crmboard/search", async (c) => {
  try {
    const folder_id = c.req.query("folder_id");
    const board_id = c.req.query("board_id");
    if (!folder_id && !board_id) {
      return c.json(
        { message: "At least one of folder_id or board_id is required" },
        400,
      );
    }
    const rows = await repo(c).findByFolderIdOrBoardId(folder_id, board_id);
    if (!rows || rows.length === 0) {
      return c.json({ message: "CRMBoard not found" }, 404);
    }
    return c.json(rows);
  } catch (err) {
    logger.error("CRMBoard.search error:", err);
    return c.json(
      { message: "Error fetching CRMBoard by folder_id or board_id" },
      500,
    );
  }
});

// GET /crmboard/organization/board — list CRMBoards for current org.
crmboardController.get("/crmboard/organization/board", async (c) => {
  try {
    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ message: "x-organization-id header missing" }, 401);
    }
    const rows = await repo(c).findByOrganizationId(organizationId);
    if (!rows || rows.length === 0) {
      return c.json({ message: "CRMBoard not found" }, 404);
    }
    return c.json(rows);
  } catch (err) {
    logger.error("CRMBoard.byOrganization error:", err);
    return c.json({ message: "Error fetching CRMBoard by organization" }, 500);
  }
});

// GET /crmboard/board/:id — by primary key (id).
crmboardController.get("/crmboard/board/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const row = await repo(c).findById(id);
    if (!row) return c.json({ message: "CRMBoard not found" }, 404);
    return c.json(row);
  } catch (err) {
    logger.error("CRMBoard.byId error:", err);
    return c.json({ message: (err as Error).message }, 500);
  }
});

// GET /crmboard/field/:id — all CRMBoards whose field_id matches.
crmboardController.get("/crmboard/field/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const rows = await repo(c).findByFieldId(id);
    return c.json(rows);
  } catch (err) {
    logger.error("CRMBoard.byField error:", err);
    return c.json({ message: (err as Error).message }, 500);
  }
});

// GET /crmboard/workflow/:id — all CRMBoards bound to a workflow_id.
crmboardController.get("/crmboard/workflow/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const rows = await repo(c).findByWorkflowId(id);
    if (!rows || rows.length === 0) {
      return c.json(
        { message: "CRMBoard not found for the given workflow_id" },
        404,
      );
    }
    return c.json(rows);
  } catch (err) {
    logger.error("CRMBoard.byWorkflow error:", err);
    return c.json({ message: (err as Error).message }, 500);
  }
});

// POST /crmboard — create a CRMBoard automation. Handles
// `type=scheduled` (validates scheduler settings + provisions scheduler)
// and the regular create/update/delete trigger types (duplicate check
// then insert).
crmboardController.post("/crmboard", async (c) => {
  try {
    const body = await c.req.json();
    const organization_id = resolveOrgId(c, body);
    if (!organization_id) {
      return c.json({ message: "Unauthorize" }, 401);
    }
    const userId = c.get("userId") ?? null;
    const payload = {
      ...body,
      organization_id,
      ...(userId
        ? { created_by: userId, updated_by: userId }
        : {}),
    };
    const created = await service(c).create(payload);
    return c.json(created, 200);
  } catch (err) {
    logger.error("CRMBoard.create error:", err);
    const { status, body } = mapErrorResponse(err);
    return c.json(body, status);
  }
});

// PUT /crmboard/board/:id — update by primary key. Body must include
// `board_id` (IPS requirement preserved for compatibility).
crmboardController.put("/crmboard/board/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();
    const { board_id } = body || {};
    if (!board_id) {
      return c.json({ message: "BoardID is invalid or missing" }, 404);
    }
    const organization_id = resolveOrgId(c, body);
    const userId = c.get("userId") ?? null;
    const data = {
      ...body,
      _id: body._id ?? id,
      organization_id,
      updated_by: userId,
    };
    const updated = await service(c).update(id, data);
    return c.json(updated, 200);
  } catch (err) {
    logger.error("CRMBoard.update error:", err);
    const { status, body } = mapErrorResponse(err);
    return c.json(body, status);
  }
});

// DELETE /crmboard/board/:id — delete by primary key. Tears down the
// bound scheduler when the row is type=scheduled.
crmboardController.delete("/crmboard/board/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const ok = await service(c).delete(id);
    if (!ok) return c.json({ message: "CRMBoard not found" }, 404);
    return c.json({ message: "Delete successfully" }, 200);
  } catch (err) {
    logger.error("CRMBoard.delete error:", err);
    const { status, body } = mapErrorResponse(err);
    return c.json(body, status);
  }
});

// PUT /crmboard/field/:id — bulk detach automations that reference a
// field that's being removed. Sets field_id='' + is_paused=true.
crmboardController.put("/crmboard/field/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const existing = await repo(c).findByFieldId(id);
    if (existing.length === 0) {
      return c.json(
        { message: "CRMBoard not found for the given field_id" },
        404,
      );
    }
    const count = await service(c).clearFieldId(id);
    return c.json(
      {
        acknowledged: true,
        modifiedCount: count,
        matchedCount: existing.length,
        upsertedId: null,
        upsertedCount: 0,
      },
      200,
    );
  } catch (err) {
    logger.error("CRMBoard.updateByField error:", err);
    const { status, body } = mapErrorResponse(err);
    return c.json(body, status);
  }
});

// PUT /crmboard/workflow/:id — bulk detach automations bound to a
// workflow that's being removed. Sets workflow_id='' + is_paused=true.
crmboardController.put("/crmboard/workflow/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const existing = await repo(c).findByWorkflowId(id);
    if (existing.length === 0) {
      return c.json(
        { message: "CRMBoard not found for the given workflow_id" },
        404,
      );
    }
    const count = await service(c).clearWorkflowId(id);
    return c.json(
      {
        acknowledged: true,
        modifiedCount: count,
        matchedCount: existing.length,
        upsertedId: null,
        upsertedCount: 0,
      },
      200,
    );
  } catch (err) {
    logger.error("CRMBoard.updateByWorkflow error:", err);
    const { status, body } = mapErrorResponse(err);
    return c.json(body, status);
  }
});

// DELETE /crmboard/:boardid — bulk delete all automations bound to a
// board_id. Tears down schedulers for scheduled rows along the way.
crmboardController.delete("/crmboard/:boardid", async (c) => {
  try {
    const boardid = c.req.param("boardid");
    const count = await service(c).deleteByBoardId(boardid);
    if (count === 0) return c.json({ message: "CRMBoard not found" }, 404);
    return c.json({ message: "Delete successfully" }, 200);
  } catch (err) {
    logger.error("CRMBoard.deleteByBoardId error:", err);
    const { status, body } = mapErrorResponse(err);
    return c.json(body, status);
  }
});

// GET /crmboard/:boardid — all CRMBoards for a board_id (this is the
// hot path the frontend uses on the automations page).
crmboardController.get("/crmboard/:boardid", async (c) => {
  try {
    const boardid = c.req.param("boardid");
    const rows = await repo(c).findByBoardId(boardid);
    if (!rows) return c.json({ message: "CRMBoard not found" }, 404);
    return c.json(rows);
  } catch (err) {
    logger.error("CRMBoard.byBoardId error:", err);
    return c.json({ message: "Error fetching CRMBoard by board_id" }, 500);
  }
});
