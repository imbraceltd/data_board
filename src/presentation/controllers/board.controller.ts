/**
 * Board Controller
 * Hono endpoints for board management
 */

import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DatabaseClient } from "../../infrastructure/database/types";
import type * as boardSchema from "../../db/drizzle/schema";
import { BoardService } from "../../core/services/board.service";
import { OntologyService } from "../../core/services/ontology.service";
import {
  createBoardSchema,
  updateBoardSchema,
  createBoardFieldSchema,
  updateBoardFieldSchema,
  reorderFieldsSchema,
  reorderBoardsSchema,
  boardFiltersSchema,
  bulkFieldsSchema,
  aggregateSchema,
  attachChildSchema,
  detachChildSchema,
} from "../schemas/board.schema";
import { connectionsQuerySchema } from "../schemas/ontology.schema";
import { BoardItemService } from "../../core/services/board-item.service";
import { BoardItemRepository } from "../../infrastructure/database/repositories/board-item.repository";
import {
  publishAudit,
  buildBoardChanges,
} from "../../core/services/audit-publisher";
import {
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  AttachDetachError,
} from "../../domain/shared/errors";
import logger from "../../infrastructure/logging/logger";
import { getRedisClient } from "../../infrastructure/redis/client";
import config from "../../config";
import {
  parseExportCsvOptions,
  resolveDateRange,
  renderBoardCsv,
  buildExportFileName,
} from "../utils/csv-export";
import { sendEmail } from "../../infrastructure/mail/mailer";
// Public board files (CSV import/export, attachments) are persisted to the
// server's local disk via file-service instead of S3. Same signature/return as
// the old S3 helper — revert by swapping this back to `../../infrastructure/storage/s3`.
import { uploadPublicFile as s3UploadPublic } from "../../infrastructure/storage/public-upload";
import { BoardFieldType } from "../../domain/shared/board.types";
import type { BoardManager } from "../../domain/shared/board.types";
import { getFieldTypeInfo } from "../utils/board-field-type-info";

/**
 * Deployment-access team ids -> Board `managers`. Board access is enforced via
 * `managers` (see BoardService.hasAccess); the FE sends access as `team_ids`, so
 * each granted team becomes a full-access manager. An empty array yields `[]` =
 * no restriction (all teams). `teamName` is blank — only `teamId` drives access.
 */
function teamIdsToBoardManagers(teamIds: string[]): BoardManager[] {
  return (teamIds ?? [])
    .filter((id) => typeof id === "string" && id.trim() !== "")
    .map((teamId) => ({
      teamId,
      teamName: "",
      permissions: {
        read: true,
        write: true,
        delete: true,
        manageFields: true,
      },
    }));
}

/**
 * Reverse of `teamIdsToBoardManagers`: expose a derived `team_ids` field on the
 * board response (= managers' teamIds) for backward-compat with clients that
 * read `team_ids`. Access is still driven by `managers`; this is output-only.
 */
function boardToResponse<T extends { managers?: BoardManager[] }>(board: T) {
  return {
    ...board,
    team_ids: (board.managers ?? []).map((m) => m.teamId),
  };
}

// Context type for dependency injection
export interface BoardControllerContext {
  Variables: {
    db: DatabaseClient;
    userId?: string;
    organizationId?: string;
    businessUnitId?: string;
    accessToken?: string;
    teamIds?: string[];
    teamScopeResolved?: boolean;
  };
}

export const boardController = new Hono<BoardControllerContext>();

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
      (c.get("accessToken") as string | undefined),
  };
}

/**
 * Emit a board-entity audit event (fire-and-forget). Snapshots board metadata
 * for a readable before/after diff. Never throws — audit must not break the
 * mutation. Mirrors emitBoardItemAudit in board-item.controller.ts but for the
 * board itself (resource:"board") rather than its rows.
 */
function emitBoardAudit(args: {
  organizationId?: string;
  userId?: string;
  action: "create" | "update" | "delete";
  boardId: string;
  before: any;
  after: any;
}): void {
  const { organizationId, userId, action, boardId, before, after } = args;
  if (!organizationId) return;
  const built = buildBoardChanges(before, after);
  // Suppress no-op updates: a board save (or a /fields/bulk call that didn't
  // actually change anything we track) produces an empty diff — don't spam the
  // feed with "Updated" rows that show nothing. create/delete always emit.
  if (action === "update" && built.changes.fields.length === 0) return;
  publishAudit([
    {
      organizationId,
      userId,
      action,
      resource: "board",
      resourceId: boardId,
      resourceName: built.resourceName,
      changes: built.changes,
      metadata: { boardId, source: "board" },
    },
  ]);
}

/**
 * Capture the board's before-state, run a field-definition mutation, then emit a
 * board/update audit with the field diff (fire-and-forget). Field edits (add /
 * rename / retype / delete / reorder) all go through /boards/:id/fields* and
 * mutate board.fields — auditing them as a board update is what surfaces schema
 * changes (incl. the FE's PUT .../fields/bulk path) in the feed. Returns the
 * mutation result unchanged; never throws on the audit side.
 */
async function runBoardFieldMutation(
  c: any,
  boardId: string,
  svc: BoardService,
  run: () => Promise<any>,
): Promise<any> {
  let before: any = null;
  try {
    before = await svc.getBoard(boardId);
  } catch {
    /* ignore */
  }
  const result = await run();
  // The field endpoints return the updated board; fall back to a refetch if not.
  let after: any = result && Array.isArray(result.fields) ? result : null;
  if (!after) {
    try {
      after = await svc.getBoard(boardId);
    } catch {
      /* ignore */
    }
  }
  emitBoardAudit({
    organizationId: c.get("organizationId"),
    userId: c.get("userId"),
    action: "update",
    boardId,
    before,
    after,
  });
  return result;
}

// ---- CSV import helpers ------------------------------------------------
//
// The Mongo-era CSV export was malformed: header had only board field names
// (e.g. 6 cols) while data rows appended unlabeled `created_at` / `updated_at`
// timestamps (8 cols total). The PG export ([csv-export.ts:235-239]) now
// includes the canonical `Record Created On` / `Lasted Updated On` headers,
// but we still need to accept the legacy shape during the Mongo→PG cutover.

// Sentinel emitted by exportCsv() for field types that aren't representable
// in CSV (Attachment, etc — see csv-export.ts:278). On import we skip cells
// equal to this so the field stays null instead of inheriting the literal
// placeholder text (or being wrapped into a fake URL-attachment, the way
// legacy backend's handleFieldTypeValue did).
const EXPORT_UNSUPPORTED_PLACEHOLDER =
  "(the field format is not supported in export)";

const TIMESTAMP_HEADER_ALIASES: Record<string, "created_at" | "updated_at"> = {
  "record created on": "created_at",
  created_at: "created_at",
  "lasted updated on": "updated_at", // matches existing export typo
  "last updated on": "updated_at",
  updated_at: "updated_at",
};

// Accepts the Mongo export format (MM/DD/YYYY HH:mm) and ISO 8601.
function parseImportTimestamp(raw: unknown): Date | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
  if (m) {
    const [, mm, dd, yyyy, hh, mi] = m;
    const d = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:00Z`);
    return isNaN(d.getTime()) ? undefined : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}

// If the first data row has exactly 2 more columns than the header, infer
// they're the trailing Mongo timestamps and inject matching headers so the
// mapper below can route them into created_at / updated_at.
function alignLegacyTimestampHeaders(
  csv: string,
  delimiter: string,
  parseCsv: (input: string, opts: any) => any,
): string {
  const newlineIdx = csv.search(/\r?\n/);
  if (newlineIdx === -1) return csv;
  let probe: string[][];
  try {
    probe = parseCsv(csv, {
      columns: false,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      delimiter,
      to_line: 2,
      relax_column_count: true,
    }) as string[][];
  } catch {
    return csv;
  }
  if (probe.length < 2) return csv;
  const headerCount = probe[0].length;
  const firstDataCount = probe[1].length;
  if (firstDataCount - headerCount !== 2) return csv;
  const headerLine = csv.slice(0, newlineIdx);
  const rest = csv.slice(newlineIdx);
  return `${headerLine}${delimiter}Record Created On${delimiter}Lasted Updated On${rest}`;
}

/**
 * GET /boards
 * List boards for organization
 */
boardController.get("/", zValidator("query", boardFiltersSchema), async (c) => {
  try {
    const db = c.get("db");
    const organizationId = c.get("organizationId");
    const teamIds = c.get("teamIds") || [];
    const teamScopeResolved = c.get("teamScopeResolved") === true;

    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }

    const boardService = new BoardService({ db });
    const filters = c.req.valid("query");

    // Team scoping. An explicit `teamIds` query param is treated as an
    // authoritative scope override. Otherwise use the scope resolved
    // server-side from the caller's identity (resolveTeamScope): when platform
    // couldn't answer (resolved=false) we fail open to the whole org.
    const teamScope = filters.teamIds
      ? { resolved: true, teamIds: filters.teamIds }
      : { resolved: teamScopeResolved, teamIds };

    // `total` = count of ALL boards matching the filters (search/category/type/
    // hidden) before limit/skip — the FE needs it to render pagination. `count`
    // (this page's size) is kept for backward compatibility.
    const { data: boards, total } = await boardService.listBoardsWithTotal(
      organizationId,
      filters,
      teamScope,
    );

    const itemsRepo = new BoardItemRepository(db);
    const ids = boards.map((b: any) => b._id ?? b.id).filter(Boolean);
    const countMap = await itemsRepo.countByBoardIds(ids);
    const data = boards.map((b: any) => ({
      ...boardToResponse(b),
      items_count: countMap.get(b._id ?? b.id) ?? 0,
    }));

    return c.json({ data, total, count: data.length });
  } catch (error) {
    logger.error("Error listing boards:", error);
    return c.json(
      { error: "Failed to list boards", message: (error as Error).message },
      500,
    );
  }
});

/**
 * GET /boards/model-schema
 * Returns the Board model schema definition + per-field-type metadata.
 * Ported from legacy backend GET /v1/board/model-schema. Response shape kept
 * identical so existing FE callers (and messagesuggestion's suggest-field-types
 * endpoint) work without changes.
 *
 */
boardController.get("/model-schema", (c) => {
  const fieldTypes = Object.values(BoardFieldType).map((value) => {
    const { text, has_data, settings, structure } = getFieldTypeInfo(value);
    return structure
      ? { value, text, has_data, settings, structure }
      : { value, text, has_data, settings };
  });

  return c.json({
    data: {
      board_field: {
        _id: { type: "String" },
        name: { type: "String" },
        description: { type: "String" },
        type: {
          type: "String",
          enum: Object.values(BoardFieldType),
          default: BoardFieldType.SHORT_TEXT,
        },
        data: {
          type: "Array",
          description:
            "Options list — used by SingleSelection, MultiSelection, Priority, MapToBoard, TableInTable",
          items: { _id: { type: "String" }, value: { type: "String" } },
        },
        settings: {
          type: "Object",
          description: "Per field-type config — see field_type_settings",
        },
      },
      field_types: fieldTypes,
    },
  });
});

/**
 * POST /boards/upload
 * Multi-file upload for board Attachment fields. Ported from legacy backend
 * /v1/board/upload (multipleUpload). FormData with one or more files appended
 * under the empty key `''`. Returns the legacy shape so existing FE callers
 * stay unchanged:
 *   [{ name, extension, url, key, uploader, user_id, sizeInBytes, uploadDate, error }]
 *
 * Registered ABOVE /:id routes so the literal "upload" segment wins.
 */
boardController.post("/upload", async (c) => {
  const FILE_MAXIMUM_LIMIT = 10;
  const SUPPORTED_IMAGE_TYPE = [
    "gif",
    "tiff",
    "tif",
    "svg",
    "jpg",
    "jpeg",
    "png",
  ];
  const SUPPORTED_FILE_TYPE = [
    "txt",
    "ai",
    "psd",
    "csv",
    "doc",
    "docx",
    "pdf",
    "ppt",
    "pptx",
    "xls",
    "xlsx",
    "mp4",
    "json",
  ];
  const SUPPORTED_TYPE = new Set([
    ...SUPPORTED_IMAGE_TYPE,
    ...SUPPORTED_FILE_TYPE,
  ]);

  try {
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }

    const body = await c.req.parseBody({ all: true });
    const files: File[] = [];
    for (const value of Object.values(body)) {
      if (value instanceof File) {
        files.push(value);
      } else if (Array.isArray(value)) {
        for (const v of value) {
          if (v instanceof File) files.push(v);
        }
      }
    }
    if (files.length === 0) {
      return c.json({ error: "No file uploaded" }, 400);
    }
    if (files.length > FILE_MAXIMUM_LIMIT) {
      return c.json(
        { error: `maximum ${FILE_MAXIMUM_LIMIT} files are allowed` },
        400,
      );
    }

    const results: Array<{
      user_id: string | null;
      uploader: string | null;
      name: string;
      extension: string;
      sizeInBytes: number;
      uploadDate: Date;
      url: string | null;
      key: string | null;
      error: string | null;
    }> = [];

    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const sizeInBytes = buffer.length;
      const mimetype = file.type || "application/octet-stream";
      const originalName = file.name || "file";
      const baseName = originalName.replace(/\.[^/.]+$/, "");
      const filenameExt = originalName.includes(".")
        ? originalName.split(".").pop()?.toLowerCase()
        : undefined;
      const extension =
        filenameExt || (mimetype.split("/").pop() || "bin").toLowerCase();
      const entry = {
        user_id: userId ?? null,
        uploader: userId ?? null,
        name: baseName,
        extension,
        sizeInBytes,
        uploadDate: new Date(),
        url: null as string | null,
        key: null as string | null,
        error: null as string | null,
      };

      if (!SUPPORTED_TYPE.has(extension)) {
        entry.error = `unsupported file type ${extension}`;
        results.push(entry);
        continue;
      }

      const key = `board/${organizationId}/file_${crypto
        .randomUUID()
        .replace(/-/g, "")
        .slice(0, 26)}.${extension}`;
      try {
        const { Location } = await s3UploadPublic(
          key,
          buffer,
          mimetype,
          `${baseName}.${extension}`,
        );
        entry.url = Location;
        entry.key = key;
      } catch (e) {
        logger.error("S3 upload failed for board file", e as Error);
        entry.error = "upload file to s3 error";
      }
      results.push(entry);
    }

    return c.json(results);
  } catch (error) {
    logger.error("Error in board multiple upload:", error);
    return c.json(
      {
        error: "Failed to upload files",
        message: (error as Error).message,
      },
      500,
    );
  }
});

/**
 * POST /boards/_fileupload
 * Upload an arbitrary file (usually a board import CSV) to S3 and return
 * its public URL. Ported from legacy backend /v1/board/_fileupload.
 * Response: { url: "https://<bucket>.s3.<region>.amazonaws.com/board/..." }
 *
 * Registered ABOVE /:id routes so the literal "_fileupload" segment wins.
 */
boardController.post("/_fileupload", async (c) => {
  try {
    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }

    const body = await c.req.parseBody();
    const file = Object.values(body).find((v) => v instanceof File) as
      | File
      | undefined;
    if (!file) {
      return c.json({ error: "No file uploaded" }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const mimetype = file.type || "application/octet-stream";
    const extension = (mimetype.split("/").pop() || "bin").toLowerCase();
    const key = `board/${organizationId}/file_${crypto.randomUUID().replace(/-/g, "")}.${extension}`;

    const { Location } = await s3UploadPublic(key, buffer, mimetype, file.name);
    return c.json({ url: Location });
  } catch (error) {
    logger.error("Error in board file upload:", error);
    return c.json(
      { error: "Failed to upload file", message: (error as Error).message },
      500,
    );
  }
});

/**
 * GET /boards/:id/import_progress
 * Get the Redis-backed import progress for a board
 */
boardController.get("/:id/import_progress", async (c) => {
  const boardId = c.req.param("id");
  const userId = c.get("userId");

  if (!userId) {
    return c.json({ error: "User ID required" }, 401);
  }

  try {
    const redis = getRedisClient();
    const progressKey = `import_progress:${boardId}:${userId}`;
    const raw = await redis.get(progressKey);

    if (!raw) {
      return c.json({ status: "not_found", message: "No active import found" });
    }

    const progress = JSON.parse(raw);

    if (progress.status === "completed") {
      await redis.del(progressKey);
    }

    return c.json(progress);
  } catch (error) {
    logger.error("Error fetching import progress:", error);
    return c.json(
      {
        error: "Failed to fetch import progress",
        message: (error as Error).message,
      },
      500,
    );
  }
});

/**
 * POST /boards/:id/import_csv
 * Body: { fileUrl: string, mappings: [{ csvHeader, boardFieldId, boardFieldName }] }
 * Downloads the CSV from S3, validates the mappings against board.fields,
 * parses rows, and bulk-creates board items.
 * Ported from legacy backend importBoardItemsFromCSV (scope trimmed — no
 * Redis progress, no websocket events).
 */
boardController.post("/:id/import_csv", async (c) => {
  try {
    const db = c.get("db");
    const boardId = c.req.param("id");
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const businessUnitId = c.get("businessUnitId");

    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }

    const body = await c.req.json();
    const { fileUrl, mappings } = body ?? {};
    if (!fileUrl || !Array.isArray(mappings) || mappings.length === 0) {
      return c.json(
        { status: "error", message: "fileUrl and mappings are required" },
        400,
      );
    }

    const boardService = new BoardService({ db });
    const board = await boardService.getBoard(boardId);
    const fields: any[] = Array.isArray((board as any).fields)
      ? (board as any).fields
      : [];

    // Validate mappings point at real fields with matching names.
    const invalid = mappings.filter((m: any) => {
      const f = fields.find((x) => (x.id ?? x._id) === m.boardFieldId);
      return !f || f.name !== m.boardFieldName;
    });
    if (invalid.length > 0) {
      return c.json(
        {
          status: "error",
          message: "Invalid field mappings",
          invalidMappings: invalid.map((m: any) => ({
            csvHeader: m.csvHeader,
            boardFieldName: m.boardFieldName,
          })),
        },
        400,
      );
    }

    // If the board has an identifier field, require it in the mappings.
    const identifier = fields.find((f) => f.isIdentifier || f.is_identifier);
    if (
      identifier &&
      !mappings.some(
        (m: any) => m.boardFieldId === (identifier.id ?? identifier._id),
      )
    ) {
      return c.json(
        {
          status: "error",
          message: "Identifier field is required in mappings",
          requiredField: {
            boardFieldId: identifier.id ?? identifier._id,
            boardFieldName: identifier.name,
          },
        },
        400,
      );
    }

    // Fetch the CSV. S3 objects were uploaded with public-read so a plain
    // fetch is enough — matches how legacy backend hits its own urls in dev.
    const res = await fetch(fileUrl);
    if (!res.ok) {
      return c.json(
        {
          status: "error",
          message: `Failed to fetch file: HTTP ${res.status}`,
        },
        400,
      );
    }
    const csvText = await res.text();

    // Sniff the delimiter from the header row. Excel exports from non-US
    // locales commonly use ';'; default ',' fails on those with a confusing
    // "Invalid Closing Quote" error.
    const firstLine = csvText.split(/\r?\n/, 1)[0] ?? "";
    const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0, "|": 0 };
    for (const ch of firstLine) {
      if (ch in counts) counts[ch]++;
    }
    const delimiter =
      Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ",";

    // csv-parse sync mode — fine for the MVP scope; swap to stream if we
    // start importing giant files. `relax_column_count` keeps us alive on
    // legacy Mongo CSVs whose data rows have more cols than the header.
    const { parse: parseCsv } = await import("csv-parse/sync");
    const normalizedCsv = alignLegacyTimestampHeaders(
      csvText,
      delimiter,
      parseCsv,
    );
    const rows = parseCsv(normalizedCsv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      delimiter,
      relax_column_count: true,
    }) as Record<string, string>[];

    // Header → fieldId lookup (strip BOM, trim).
    const headerToField: Record<string, { id: string; name: string }> = {};
    for (const m of mappings as any[]) {
      const key = String(m.csvHeader).replace(/^﻿/, "").trim();
      headerToField[key] = { id: m.boardFieldId, name: m.boardFieldName };
    }

    const items = rows.map((row) => {
      const fieldsPayload: Record<string, any> = {};
      let createdAt: Date | undefined;
      let updatedAt: Date | undefined;
      for (const [rawHeader, value] of Object.entries(row)) {
        const header = rawHeader.replace(/^﻿/, "").trim();
        const tsKind = TIMESTAMP_HEADER_ALIASES[header.toLowerCase()];
        if (tsKind) {
          const d = parseImportTimestamp(value);
          if (d) {
            if (tsKind === "created_at") createdAt = d;
            else updatedAt = d;
          }
          continue;
        }
        const mapping = headerToField[header];
        if (!mapping) continue;
        if (value === EXPORT_UNSUPPORTED_PLACEHOLDER) continue;
        fieldsPayload[mapping.id] = value;
      }
      return {
        board_id: boardId,
        organization_id: organizationId,
        business_unit_id: businessUnitId || "",
        created_by: userId,
        fields: fieldsPayload,
        ...(createdAt ? { created_at: createdAt } : {}),
        ...(updatedAt ? { updated_at: updatedAt } : {}),
      } as any;
    });

    // Redis-backed progress (read by GET /:id/import_progress). Keyed per
    // (board, user) so the UI can show its own progress without seeing
    // imports started by other sessions.
    const redis = getRedisClient();
    const progressKey = `import_progress:${boardId}:${userId ?? "system"}`;
    const writeProgress = async (p: Record<string, any>) => {
      try {
        await redis.set(progressKey, JSON.stringify(p), "EX", 3600);
      } catch (err) {
        logger.warn(
          `import_progress redis write failed: ${(err as Error).message}`,
        );
      }
    };

    if (items.length === 0) {
      await writeProgress({
        status: "completed",
        total: 0,
        processed: 0,
        success: 0,
        failed: 0,
        percentage: 100,
      });
      return c.json({
        status: "success",
        message: "CSV import completed",
        results: { total: 0, successful: 0, failed: 0, skipped: 0 },
      });
    }

    await writeProgress({
      status: "processing",
      total: rows.length,
      processed: 0,
      success: 0,
      failed: 0,
      percentage: 0,
    });

    const boardItemService = new BoardItemService({ db });
    const BATCH_SIZE = 500;
    let processed = 0;
    let success = 0;
    let failed = 0;
    const createdIds: string[] = [];

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      try {
        // Per-row validation: a single invalid row (e.g. a Size value that is
        // not a valid SingleSelection option) is skipped and counted as failed
        // instead of failing the whole batch — the valid rows still import.
        const rowErrors: { index: number; message: string }[] = [];
        const created = await boardItemService.createMultipleBoardItems(
          boardId,
          batch,
          undefined,
          { skipInvalid: true, errors: rowErrors },
        );
        success += created.length;
        failed += rowErrors.length;
        for (const row of created)
          createdIds.push((row as any).id ?? (row as any)._id);
        if (rowErrors.length) {
          logger.warn(
            `Import batch (rows ${i}-${i + batch.length - 1}): ${rowErrors.length} row(s) skipped, e.g. ${rowErrors[0].message}`,
          );
        }
      } catch (err) {
        // Non-validation failure (e.g. DB error) still fails the whole batch.
        failed += batch.length;
        logger.error(
          `Import batch (rows ${i}-${i + batch.length - 1}) failed: ${(err as Error).message}`,
        );
      }
      processed += batch.length;
      await writeProgress({
        status: "processing",
        total: items.length,
        processed,
        success,
        failed,
        percentage: Math.round((processed / items.length) * 100),
      });
    }

    await writeProgress({
      status: "completed",
      total: items.length,
      processed,
      success,
      failed,
      percentage: 100,
    });

    return c.json({
      status: "success",
      message: "CSV import completed",
      results: {
        total: rows.length,
        successful: success,
        failed,
        skipped: 0,
      },
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof ValidationError) {
      return c.json({ status: "error", message: error.message }, 400);
    }
    logger.error("Error importing CSV:", error);
    return c.json({ status: "error", message: (error as Error).message }, 500);
  }
});

/**
 * Shared tail of the row-based import pipeline (CSV / Excel): validate the
 * field mappings against the board, map each parsed row to a board item, then
 * batch-insert with Redis-backed progress. `rows` is an array of objects keyed
 * by the source column header (as produced by csv-parse or xlsx sheet_to_json).
 * Returns the JSON Response the handler should send.
 */
async function runBoardRowImport(
  c: any,
  boardId: string,
  rows: Record<string, any>[],
  mappings: any[],
  completedMessage: string,
): Promise<Response> {
  const db = c.get("db");
  const organizationId = c.get("organizationId");
  const userId = c.get("userId");
  const businessUnitId = c.get("businessUnitId");

  const boardService = new BoardService({ db });
  const board = await boardService.getBoard(boardId);
  const fields: any[] = Array.isArray((board as any).fields)
    ? (board as any).fields
    : [];

  // The import UI builds mappings for CSV; reuse the same shape for Excel and
  // accept the header under any of the common keys.
  const headerOf = (m: any): string =>
    String(m.csvHeader ?? m.excelHeader ?? m.header ?? m.columnName ?? "");

  // Validate mappings point at real fields with matching names.
  const invalid = mappings.filter((m: any) => {
    const f = fields.find((x) => (x.id ?? x._id) === m.boardFieldId);
    return !f || f.name !== m.boardFieldName;
  });
  if (invalid.length > 0) {
    return c.json(
      {
        status: "error",
        message: "Invalid field mappings",
        invalidMappings: invalid.map((m: any) => ({
          csvHeader: headerOf(m),
          boardFieldName: m.boardFieldName,
        })),
      },
      400,
    );
  }

  // If the board has an identifier field, require it in the mappings.
  const identifier = fields.find((f) => f.isIdentifier || f.is_identifier);
  if (
    identifier &&
    !mappings.some(
      (m: any) => m.boardFieldId === (identifier.id ?? identifier._id),
    )
  ) {
    return c.json(
      {
        status: "error",
        message: "Identifier field is required in mappings",
        requiredField: {
          boardFieldId: identifier.id ?? identifier._id,
          boardFieldName: identifier.name,
        },
      },
      400,
    );
  }

  // Header → fieldId lookup (strip BOM, trim).
  const headerToField: Record<string, { id: string; name: string }> = {};
  for (const m of mappings as any[]) {
    const key = headerOf(m).replace(/^﻿/, "").trim();
    headerToField[key] = { id: m.boardFieldId, name: m.boardFieldName };
  }

  const items = rows.map((row) => {
    const fieldsPayload: Record<string, any> = {};
    let createdAt: Date | undefined;
    let updatedAt: Date | undefined;
    for (const [rawHeader, value] of Object.entries(row)) {
      const header = rawHeader.replace(/^﻿/, "").trim();
      const tsKind = TIMESTAMP_HEADER_ALIASES[header.toLowerCase()];
      if (tsKind) {
        const d = parseImportTimestamp(value as string);
        if (d) {
          if (tsKind === "created_at") createdAt = d;
          else updatedAt = d;
        }
        continue;
      }
      const mapping = headerToField[header];
      if (!mapping) continue;
      if (value === EXPORT_UNSUPPORTED_PLACEHOLDER) continue;
      fieldsPayload[mapping.id] = value;
    }
    return {
      board_id: boardId,
      organization_id: organizationId,
      business_unit_id: businessUnitId || "",
      created_by: userId,
      fields: fieldsPayload,
      ...(createdAt ? { created_at: createdAt } : {}),
      ...(updatedAt ? { updated_at: updatedAt } : {}),
    } as any;
  });

  // Redis-backed progress (read by GET /:id/import_progress). Keyed per
  // (board, user) so the UI shows its own progress.
  const redis = getRedisClient();
  const progressKey = `import_progress:${boardId}:${userId ?? "system"}`;
  const writeProgress = async (p: Record<string, any>) => {
    try {
      await redis.set(progressKey, JSON.stringify(p), "EX", 3600);
    } catch (err) {
      logger.warn(
        `import_progress redis write failed: ${(err as Error).message}`,
      );
    }
  };

  if (items.length === 0) {
    await writeProgress({
      status: "completed",
      total: 0,
      processed: 0,
      success: 0,
      failed: 0,
      percentage: 100,
    });
    return c.json({
      status: "success",
      message: completedMessage,
      results: { total: 0, successful: 0, failed: 0, skipped: 0 },
    });
  }

  await writeProgress({
    status: "processing",
    total: rows.length,
    processed: 0,
    success: 0,
    failed: 0,
    percentage: 0,
  });

  const boardItemService = new BoardItemService({ db });
  const BATCH_SIZE = 500;
  let processed = 0;
  let success = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    try {
      // Per-row validation: invalid rows are skipped (counted as failed) rather
      // than failing the whole batch, so the valid rows still import.
      const rowErrors: { index: number; message: string }[] = [];
      const created = await boardItemService.createMultipleBoardItems(
        boardId,
        batch,
        undefined,
        { skipInvalid: true, errors: rowErrors },
      );
      success += created.length;
      failed += rowErrors.length;
      if (rowErrors.length) {
        logger.warn(
          `Import batch (rows ${i}-${i + batch.length - 1}): ${rowErrors.length} row(s) skipped, e.g. ${rowErrors[0].message}`,
        );
      }
    } catch (err) {
      failed += batch.length;
      logger.error(
        `Import batch (rows ${i}-${i + batch.length - 1}) failed: ${(err as Error).message}`,
      );
    }
    processed += batch.length;
    await writeProgress({
      status: "processing",
      total: items.length,
      processed,
      success,
      failed,
      percentage: Math.round((processed / items.length) * 100),
    });
  }

  await writeProgress({
    status: "completed",
    total: items.length,
    processed,
    success,
    failed,
    percentage: 100,
  });

  return c.json({
    status: "success",
    message: completedMessage,
    results: { total: rows.length, successful: success, failed, skipped: 0 },
  });
}

/**
 * POST /boards/:id/import_excel
 * Import board items from an uploaded Excel (.xlsx/.xls) workbook. Mirrors
 * import_csv: body carries the file URL and the field mappings. Optionally a
 * `sheetName` selects which worksheet to read (defaults to the first sheet).
 */
boardController.post("/:id/import_excel", async (c) => {
  try {
    const boardId = c.req.param("id");
    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }

    const body = await c.req.json();
    // Accept both the camelCase shape used by import_csv and the snake_case
    // shape from the API spec.
    const fileUrl = body?.fileUrl ?? body?.file_url;
    const mappings = body?.mappings ?? body?.mapping;
    const sheetName = body?.sheetName ?? body?.sheet_name;
    if (!fileUrl || !Array.isArray(mappings) || mappings.length === 0) {
      return c.json(
        { status: "error", message: "fileUrl and mappings are required" },
        400,
      );
    }

    const res = await fetch(fileUrl);
    if (!res.ok) {
      return c.json(
        {
          status: "error",
          message: `Failed to fetch file: HTTP ${res.status}`,
        },
        400,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());

    const XLSX = await import("xlsx");
    const wb = XLSX.read(buf, { type: "buffer" });
    const targetSheet =
      sheetName && wb.Sheets[sheetName] ? sheetName : wb.SheetNames[0];
    if (!targetSheet) {
      return c.json(
        { status: "error", message: "Workbook contains no sheets" },
        400,
      );
    }
    // raw:false renders dates/numbers to their displayed strings (matching CSV
    // behaviour); defval:"" keeps empty cells so column alignment is preserved.
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[targetSheet], {
      defval: "",
      raw: false,
    }) as Record<string, any>[];

    return await runBoardRowImport(
      c,
      boardId,
      rows,
      mappings,
      "Excel import completed",
    );
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof ValidationError) {
      return c.json({ status: "error", message: error.message }, 400);
    }
    logger.error("Error importing Excel:", error);
    return c.json({ status: "error", message: (error as Error).message }, 500);
  }
});

/**
 * Shared tail of the row-based import pipeline (CSV / Excel): validate the
 * field mappings against the board, map each parsed row to a board item, then
 * batch-insert with Redis-backed progress. `rows` is an array of objects keyed
 * by the source column header (as produced by csv-parse or xlsx sheet_to_json).
 * Returns the JSON Response the handler should send.
 */
async function runBoardRowImport(
  c: any,
  boardId: string,
  rows: Record<string, any>[],
  mappings: any[],
  completedMessage: string,
): Promise<Response> {
  const db = c.get("db");
  const organizationId = c.get("organizationId");
  const userId = c.get("userId");
  const businessUnitId = c.get("businessUnitId");

  const boardService = new BoardService({ db });
  const board = await boardService.getBoard(boardId);
  const fields: any[] = Array.isArray((board as any).fields)
    ? (board as any).fields
    : [];

  // The import UI builds mappings for CSV; reuse the same shape for Excel and
  // accept the header under any of the common keys.
  const headerOf = (m: any): string =>
    String(m.csvHeader ?? m.excelHeader ?? m.header ?? m.columnName ?? "");

  // Validate mappings point at real fields with matching names.
  const invalid = mappings.filter((m: any) => {
    const f = fields.find((x) => (x.id ?? x._id) === m.boardFieldId);
    return !f || f.name !== m.boardFieldName;
  });
  if (invalid.length > 0) {
    return c.json(
      {
        status: "error",
        message: "Invalid field mappings",
        invalidMappings: invalid.map((m: any) => ({
          csvHeader: headerOf(m),
          boardFieldName: m.boardFieldName,
        })),
      },
      400,
    );
  }

  // If the board has an identifier field, require it in the mappings.
  const identifier = fields.find((f) => f.isIdentifier || f.is_identifier);
  if (
    identifier &&
    !mappings.some(
      (m: any) => m.boardFieldId === (identifier.id ?? identifier._id),
    )
  ) {
    return c.json(
      {
        status: "error",
        message: "Identifier field is required in mappings",
        requiredField: {
          boardFieldId: identifier.id ?? identifier._id,
          boardFieldName: identifier.name,
        },
      },
      400,
    );
  }

  // Header → fieldId lookup (strip BOM, trim).
  const headerToField: Record<string, { id: string; name: string }> = {};
  for (const m of mappings as any[]) {
    const key = headerOf(m).replace(/^﻿/, "").trim();
    headerToField[key] = { id: m.boardFieldId, name: m.boardFieldName };
  }

  const items = rows.map((row) => {
    const fieldsPayload: Record<string, any> = {};
    let createdAt: Date | undefined;
    let updatedAt: Date | undefined;
    for (const [rawHeader, value] of Object.entries(row)) {
      const header = rawHeader.replace(/^﻿/, "").trim();
      const tsKind = TIMESTAMP_HEADER_ALIASES[header.toLowerCase()];
      if (tsKind) {
        const d = parseImportTimestamp(value as string);
        if (d) {
          if (tsKind === "created_at") createdAt = d;
          else updatedAt = d;
        }
        continue;
      }
      const mapping = headerToField[header];
      if (!mapping) continue;
      if (value === EXPORT_UNSUPPORTED_PLACEHOLDER) continue;
      fieldsPayload[mapping.id] = value;
    }
    return {
      board_id: boardId,
      organization_id: organizationId,
      business_unit_id: businessUnitId || "",
      created_by: userId,
      fields: fieldsPayload,
      ...(createdAt ? { created_at: createdAt } : {}),
      ...(updatedAt ? { updated_at: updatedAt } : {}),
    } as any;
  });

  // Redis-backed progress (read by GET /:id/import_progress). Keyed per
  // (board, user) so the UI shows its own progress.
  const redis = getRedisClient();
  const progressKey = `import_progress:${boardId}:${userId ?? "system"}`;
  const writeProgress = async (p: Record<string, any>) => {
    try {
      await redis.set(progressKey, JSON.stringify(p), "EX", 3600);
    } catch (err) {
      logger.warn(`import_progress redis write failed: ${(err as Error).message}`);
    }
  };

  if (items.length === 0) {
    await writeProgress({
      status: "completed",
      total: 0,
      processed: 0,
      success: 0,
      failed: 0,
      percentage: 100,
    });
    return c.json({
      status: "success",
      message: completedMessage,
      results: { total: 0, successful: 0, failed: 0, skipped: 0 },
    });
  }

  await writeProgress({
    status: "processing",
    total: rows.length,
    processed: 0,
    success: 0,
    failed: 0,
    percentage: 0,
  });

  const boardItemService = new BoardItemService({ db });
  const BATCH_SIZE = 500;
  let processed = 0;
  let success = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    try {
      const created = await boardItemService.createMultipleBoardItems(
        boardId,
        batch,
      );
      success += created.length;
    } catch (err) {
      failed += batch.length;
      logger.error(
        `Import batch (rows ${i}-${i + batch.length - 1}) failed: ${(err as Error).message}`,
      );
    }
    processed += batch.length;
    await writeProgress({
      status: "processing",
      total: items.length,
      processed,
      success,
      failed,
      percentage: Math.round((processed / items.length) * 100),
    });
  }

  await writeProgress({
    status: "completed",
    total: items.length,
    processed,
    success,
    failed,
    percentage: 100,
  });

  return c.json({
    status: "success",
    message: completedMessage,
    results: { total: rows.length, successful: success, failed, skipped: 0 },
  });
}

/**
 * POST /boards/:id/import_excel
 * Import board items from an uploaded Excel (.xlsx/.xls) workbook. Mirrors
 * import_csv: body carries the file URL and the field mappings. Optionally a
 * `sheetName` selects which worksheet to read (defaults to the first sheet).
 */
boardController.post("/:id/import_excel", async (c) => {
  try {
    const boardId = c.req.param("id");
    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }

    const body = await c.req.json();
    // Accept both the camelCase shape used by import_csv and the snake_case
    // shape from the API spec.
    const fileUrl = body?.fileUrl ?? body?.file_url;
    const mappings = body?.mappings ?? body?.mapping;
    const sheetName = body?.sheetName ?? body?.sheet_name;
    if (!fileUrl || !Array.isArray(mappings) || mappings.length === 0) {
      return c.json(
        { status: "error", message: "fileUrl and mappings are required" },
        400,
      );
    }

    const res = await fetch(fileUrl);
    if (!res.ok) {
      return c.json(
        { status: "error", message: `Failed to fetch file: HTTP ${res.status}` },
        400,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());

    const XLSX = await import("xlsx");
    const wb = XLSX.read(buf, { type: "buffer" });
    const targetSheet =
      sheetName && wb.Sheets[sheetName] ? sheetName : wb.SheetNames[0];
    if (!targetSheet) {
      return c.json(
        { status: "error", message: "Workbook contains no sheets" },
        400,
      );
    }
    // raw:false renders dates/numbers to their displayed strings (matching CSV
    // behaviour); defval:"" keeps empty cells so column alignment is preserved.
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[targetSheet], {
      defval: "",
      raw: false,
    }) as Record<string, any>[];

    return await runBoardRowImport(c, boardId, rows, mappings, "Excel import completed");
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof ValidationError) {
      return c.json({ status: "error", message: error.message }, 400);
    }
    logger.error("Error importing Excel:", error);
    return c.json({ status: "error", message: (error as Error).message }, 500);
  }
});

/**
 * Shared CSV generation pipeline used by GET and POST export_csv handlers.
 * Returns the rendered CSV, the filename, and the resolved board.
 */
async function buildBoardExportCsv(
  db: DatabaseClient,
  boardId: string,
  q: Record<string, string | undefined>,
  ctx?: { organizationId?: string; userId?: string; accessToken?: string },
): Promise<{ csv: string; fileName: string; board: any }> {
  const opts = parseExportCsvOptions(q);
  const boardService = new BoardService({ db });
  const board = await boardService.getBoard(boardId);

  const now = new Date();
  const range = resolveDateRange(opts, now);

  const dateField = opts.by === "updated" ? "updated_at" : "created_at";
  const filter: Record<string, any> = {};
  if (!opts.all && (range.fromDate || range.toDate)) {
    const r: Record<string, any> = {};
    if (range.fromDate) r.$gte = range.fromDate;
    if (range.toDate) r.$lte = range.toDate;
    filter[dateField] = r;
  }

  // Parse sort: "-created_at" → {created_at: -1}; "created_at" → {created_at: 1}
  const sort: Record<string, 1 | -1> = {};
  if (opts.sort) {
    for (const token of opts.sort.split(",")) {
      const t = token.trim();
      if (!t) continue;
      if (t.startsWith("-")) sort[t.slice(1)] = -1;
      else sort[t] = 1;
    }
  }

  const boardItemService = new BoardItemService({ db });
  const { data: items } = await boardItemService.getBoardItems(
    boardId,
    {
      skip: 0,
      limit: 1_000_000,
      filter: Object.keys(filter).length ? filter : undefined,
      sort: Object.keys(sort).length ? sort : undefined,
    },
    ctx,
  );

  const csv = renderBoardCsv(board as any, items as any, opts.tz);
  const fileName = buildExportFileName(board as any, range, opts, now);
  return { csv, fileName, board };
}

/**
 * GET /boards/:id/export_csv
 * Export board items as CSV inline (attachment download).
 * Ported from legacy backend exportCsv. Supports quick_range,
 * start_date/end_date, by=creation|updated, sort, all=true.
 */
boardController.get("/:id/export_csv", async (c) => {
  try {
    const db = c.get("db");
    const boardId = c.req.param("id");
    const { csv, fileName } = await buildBoardExportCsv(
      db,
      boardId,
      c.req.query(),
      assigneeCtx(c),
    );
    const encodedFileName = encodeURIComponent(fileName);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodedFileName}`,
      },
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error exporting board CSV:", error);
    return c.json(
      { error: "Failed to export CSV", message: (error as Error).message },
      500,
    );
  }
});

/**
 * POST /boards/:id/export_csv
 * Generate the CSV, upload to file-service for a public download URL,
 * and optionally email the link to one or more recipients.
 * Body: { sendEmail?: boolean, email?: string | string[] }
 */
boardController.post("/:id/export_csv", async (c) => {
  try {
    const db = c.get("db");
    const boardId = c.req.param("id");
    const q = c.req.query();

    let body: { sendEmail?: boolean; email?: string | string[] } = {};
    try {
      body = (await c.req.json()) ?? {};
    } catch {
      // no body — treat as plain "upload and return URL"
    }

    const { csv, fileName, board } = await buildBoardExportCsv(
      db,
      boardId,
      q,
      assigneeCtx(c),
    );
    const organizationId =
      c.get("organizationId") ?? (board as any).organization_id ?? "";

    // Prepend BOM so Excel opens UTF-8 correctly.
    const csvBuffer = Buffer.concat([
      Buffer.from("﻿", "utf8"),
      Buffer.from(csv, "utf8"),
    ]);
    const s3Key = `board/${organizationId || "unknown"}/board_items/${fileName}`;
    const { Location: downloadUrl } = await s3UploadPublic(
      s3Key,
      csvBuffer,
      "text/csv; charset=utf-8",
      fileName,
      true,
    );

    const emailList = body.sendEmail
      ? Array.isArray(body.email)
        ? body.email
        : body.email
          ? [body.email]
          : []
      : [];

    const sentEmails: string[] = [];
    const failedEmails: string[] = [];
    for (const to of emailList) {
      try {
        await sendEmail({
          to,
          subject: `Your CSV export for board "${(board as any).name}" is ready`,
          html: `
            <p>Your CSV export <b>${fileName}</b> is ready.</p>
            <p><a href="${downloadUrl}">Download CSV</a></p>`,
        });
        sentEmails.push(to);
      } catch (err) {
        logger.error(`Failed to send export email to ${to}:`, err as any);
        failedEmails.push(to);
      }
    }

    return c.json({
      message:
        sentEmails.length > 0
          ? `Export started. Email sent to: ${sentEmails.join(", ")}`
          : "Export completed. Download link is ready.",
      file_name: fileName,
      download_url: downloadUrl,
      email_sent: sentEmails.length > 0,
      sent_emails: sentEmails,
      failed_emails: failedEmails,
    });
  } catch (error: any) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    const msg = error?.response?.data
      ? `${error.message} — ${JSON.stringify(error.response.data)}`
      : (error?.message ?? String(error));
    logger.error(`Error exporting board CSV (POST): ${msg}`);
    return c.json({ error: "Failed to export CSV", message: msg }, 500);
  }
});

/**
 * GET /boards/:id/export
 *
 * Legacy contract used by marketplace's template-export flow
 * (`marketplace/src/core/repositories/boards.repository.ts:457`). Mirrors the
 * legacy backend's `exportBoardItems` JSON shape — NOT the CSV-as-attachment
 * shape served by `/:id/export_csv`. Both modes:
 *   ?return_content=true → {message, content: "<csv>", record_count}
 *   default              → {message, file_name, download_url, record_count}
 */
boardController.get("/:id/export", async (c) => {
  try {
    const db = c.get("db");
    const boardId = c.req.param("id");
    const q = c.req.query();
    const returnContent =
      q.return_content === "true" || (q as any).return_content === true;

    const { csv, fileName, board } = await buildBoardExportCsv(
      db,
      boardId,
      q,
      assigneeCtx(c),
    );
    const recordCount = csv ? csv.split("\n").length - 1 : 0;

    if (returnContent) {
      return c.json({
        message: "Export successful",
        content: csv,
        record_count: recordCount,
      });
    }

    const organizationId =
      c.get("organizationId") ?? (board as any).organization_id ?? "";
    const csvBuffer = Buffer.concat([
      Buffer.from("﻿", "utf8"),
      Buffer.from(csv, "utf8"),
    ]);
    const s3Key = `board/${organizationId || "unknown"}/board_items/${fileName}`;
    const { Location: downloadUrl } = await s3UploadPublic(
      s3Key,
      csvBuffer,
      "text/csv; charset=utf-8",
      fileName,
      true,
    );
    return c.json({
      message: "Export successful",
      file_name: fileName,
      download_url: downloadUrl,
      record_count: recordCount,
    });
  } catch (error: any) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    const msg = error?.message ?? String(error);
    logger.error(`Error exporting board (/:id/export): ${msg}`);
    return c.json({ error: "Failed to export board", message: msg }, 500);
  }
});

/**
 * POST /boards/:id/import
 *
 * Legacy contract used by marketplace's template-install flow
 * (`marketplace/src/core/repositories/boards.repository.ts:488`). Mirrors
 * the legacy backend `importExportedBoardItems` shape — inline CSV in the
 * request body, no S3 round-trip, no field-id mappings (CSV headers match
 * board.fields[].name). Used to repopulate a freshly cloned board with
 * the items exported from the template's source board.
 *
 * Body: { csvContent: string, format?: "csv" }
 *
 * Scope intentionally tighter than `/:id/import_csv`:
 *   - No Redis progress (callers run this inline during install).
 *   - No mapping validation (headers ARE field names from /:id/export).
 *   - No identifier-field requirement: a fresh cloned board may not have
 *     one configured yet, and skipping all rows would defeat the purpose
 *     of cloning items.
 */
boardController.post("/:id/import", async (c) => {
  try {
    const db = c.get("db");
    const boardId = c.req.param("id");
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const businessUnitId = c.get("businessUnitId");

    const body = await c.req.json().catch(() => ({}));
    const { csvContent, format = "csv" } = (body ?? {}) as {
      csvContent?: string;
      format?: string;
    };

    if (!csvContent || typeof csvContent !== "string") {
      return c.json(
        { status: "error", message: "csvContent is required" },
        400,
      );
    }
    if (format !== "csv") {
      return c.json(
        { status: "error", message: `Unsupported format: ${format}` },
        400,
      );
    }

    const boardService = new BoardService({ db });
    const board = await boardService.getBoard(boardId);
    const fields: any[] = Array.isArray((board as any).fields)
      ? (board as any).fields
      : [];

    // Header (field name) → field id. Drop BOM and trim so Excel/legacy
    // exports parse the same as plain UTF-8.
    const fieldNameToId: Record<string, string> = {};
    for (const f of fields) {
      if (f?.name) fieldNameToId[String(f.name).trim()] = f.id ?? f._id;
    }

    // Sniff delimiter from header row — same heuristic as /:id/import_csv.
    const firstLine = csvContent.split(/\r?\n/, 1)[0] ?? "";
    const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0, "|": 0 };
    for (const ch of firstLine) {
      if (ch in counts) counts[ch]++;
    }
    const delimiter =
      Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ",";

    const { parse: parseCsv } = await import("csv-parse/sync");
    const normalizedCsv = alignLegacyTimestampHeaders(
      csvContent,
      delimiter,
      parseCsv,
    );
    const rows = parseCsv(normalizedCsv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      delimiter,
      relax_column_count: true,
    }) as Record<string, string>[];

    const items = rows.map((row) => {
      const fieldsPayload: Record<string, any> = {};
      let createdAt: Date | undefined;
      let updatedAt: Date | undefined;
      for (const [rawHeader, value] of Object.entries(row)) {
        const header = rawHeader.replace(/^﻿/, "").trim();
        const tsKind = TIMESTAMP_HEADER_ALIASES[header.toLowerCase()];
        if (tsKind) {
          const d = parseImportTimestamp(value);
          if (d) {
            if (tsKind === "created_at") createdAt = d;
            else updatedAt = d;
          }
          continue;
        }
        const fieldId = fieldNameToId[header];
        if (!fieldId) continue;
        if (value === EXPORT_UNSUPPORTED_PLACEHOLDER) continue;
        fieldsPayload[fieldId] = value;
      }
      return {
        board_id: boardId,
        organization_id: organizationId ?? (board as any).organization_id ?? "",
        business_unit_id: businessUnitId || "",
        created_by: userId,
        fields: fieldsPayload,
        ...(createdAt ? { created_at: createdAt } : {}),
        ...(updatedAt ? { updated_at: updatedAt } : {}),
      } as any;
    });

    if (items.length === 0) {
      return c.json({
        status: "success",
        message: "Import completed",
        results: { total: 0, success: 0, errors: 0, error_details: [] },
      });
    }

    const boardItemService = new BoardItemService({ db });
    const BATCH_SIZE = 500;
    let success = 0;
    let failed = 0;
    const errorDetails: string[] = [];

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      try {
        // Per-row validation: invalid rows are skipped (counted as failed and
        // reported in error_details) instead of failing the whole batch.
        const rowErrors: { index: number; message: string }[] = [];
        const created = await boardItemService.createMultipleBoardItems(
          boardId,
          batch,
          undefined,
          { skipInvalid: true, errors: rowErrors },
        );
        success += created.length;
        failed += rowErrors.length;
        for (const e of rowErrors) {
          errorDetails.push(`row ${i + e.index}: ${e.message}`);
        }
      } catch (err) {
        failed += batch.length;
        const msg = (err as Error).message;
        errorDetails.push(`rows ${i}-${i + batch.length - 1}: ${msg}`);
        logger.error(`Import batch failed: ${msg}`);
      }
    }

    return c.json({
      status: "success",
      message: "Import completed",
      results: {
        total: items.length,
        success,
        errors: failed,
        error_details: errorDetails.slice(0, 10),
      },
    });
  } catch (error: any) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof ValidationError) {
      return c.json({ status: "error", message: error.message }, 400);
    }
    const msg = error?.message ?? String(error);
    logger.error(`Error importing board (/:id/import): ${msg}`);
    return c.json(
      { status: "error", message: "Failed to import board", error: msg },
      500,
    );
  }
});

/**
 * GET /boards/by-contact/:contactId
 * Resolve the board_item (with its board nested) for a given contact.
 * Ported from the legacy backend's /v1/board/contact/:id which used
 * Mongoose `contact.populate('board_item')` and returned the full row.
 *
 * The chatroom CRM panel (`BasicInformation/index.tsx`) reads
 * `data._id`, `data.board`, `data.fields`, `data.created_type` — i.e. it
 * expects a board_item, not just a board. After the Mongo→PG migration
 * `contacts.board_item_id` was dropped and this endpoint had to fall
 * back to returning the board alone, which broke that panel. Now that
 * the column is restored + backfilled, we follow the link again.
 *
 * Registered ABOVE the /:id route so the literal path wins over the param.
 */
boardController.get("/by-contact/:contactId", async (c) => {
  try {
    const db = c.get("db");
    const contactId = c.req.param("contactId");

    // Fetch contact from channel-service. Forward identity headers — both
    // services are private and rely on x-organization-id / x-user-id scoping.
    const headers: Record<string, string> = {};
    const orgId = c.req.header("x-organization-id") ?? c.get("organizationId");
    const userId = c.req.header("x-user-id") ?? c.get("userId");
    if (orgId) headers["x-organization-id"] = orgId;
    if (userId) headers["x-user-id"] = userId;

    const res = await fetch(
      `${config.channelServiceUrl}/v1/contacts/${encodeURIComponent(contactId)}`,
      { headers },
    );
    if (res.status === 404) return c.json({ error: "Contact not found" }, 404);
    if (!res.ok) {
      return c.json(
        { error: "Failed to fetch contact", status: res.status },
        502,
      );
    }
    const payload: any = await res.json();
    const contact = payload?.data ?? payload;
    const boardItemId: string | undefined = contact?.board_item_id;
    const boardId: string | undefined = contact?.board_id;
    if (!boardItemId && !boardId) {
      return c.json({ error: "Contact has no board" }, 404);
    }

    const boardService = new BoardService({ db });

    // Legacy contract (mirrors backend getOneBoardItemByContactId): return
    // the bare board_item with `board` nested — NOT wrapped in `{data: …}`.
    // BasicInformation/index.tsx reads `data._id` / `data.board` straight
    // off the axios response body; wrapping it would surface as undefined.

    // Preferred path: contact has a direct link to its board_item.
    if (boardItemId) {
      const boardItemService = new BoardItemService({ db });
      try {
        const item = await boardItemService.getBoardItem(
          boardItemId,
          assigneeCtx(c),
        );
        const board = await boardService
          .getBoard(item.board_id)
          .catch(() => null);
        return c.json({ ...item, board });
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
        // Stale link (board_item deleted) — fall through to board-only
        // response below so the panel at least renders the board schema.
        logger.warn(
          `by-contact: contact=${contactId} references missing board_item=${boardItemId}; returning board only`,
        );
      }
    }

    // Fallback: contact.board_item_id is null (PG-native contact created
    // after migration with no Mongo source) or pointed at a deleted item.
    // Return the board alone — the frontend will degrade gracefully.
    const board = await boardService.getBoard(boardId!);
    return c.json(board);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error in /boards/by-contact/:contactId:", error);
    return c.json(
      {
        error: "Failed to resolve board for contact",
        message: (error as Error).message,
      },
      500,
    );
  }
});

/**
 * GET /boards/:boardId/connections
 * Flat BFS list of boards transitively connected to :boardId via TableInTable.
 * Postgres-only — Mongo deployments get 501.
 *
 * Registered before GET /:id so the /:boardId/connections segment is reached
 * even if the trie tries the broader /:id handler first.
 */
boardController.get(
  "/:boardId/connections",
  zValidator("query", connectionsQuerySchema),
  async (c) => {
    if (config.dbType !== "postgres") {
      return c.json(
        {
          error: "Board connections require PostgreSQL",
          message: "Set DB_TYPE=postgres to enable /boards/:id/connections.",
        },
        501,
      );
    }

    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }

    try {
      const db = c.get("db");
      const drizzleDb = db.getRawClient() as NodePgDatabase<typeof boardSchema>;
      const boardId = c.req.param("boardId");
      const query = c.req.valid("query");

      const ontologyService = new OntologyService({ db, drizzleDb });
      const result = await ontologyService.getConnections(boardId, query, {
        organizationId,
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message, code: "BOARD_NOT_FOUND" }, 404);
      }
      logger.error("Error fetching board connections:", error);
      return c.json(
        {
          error: "Failed to load connections",
          code: "CONNECTIONS_FAILED",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * POST /boards/:parentId/attach-child
 * Wrap an existing board as a TableInTable child of :parentId. Postgres-only.
 *
 * Body: { child_board_id, field_name, item_mapping[] }
 * Returns: { parent_board_id, child_board_id, new_field_id, field_name,
 *            mapped_items, inserted_edges }
 *
 * Error codes (in body): MISSING_BOARD_IDS, MISSING_FIELD_NAME, SAME_BOARD,
 * PARENT_BOARD_NOT_FOUND, CHILD_BOARD_NOT_FOUND, CHILD_ALREADY_NESTED,
 * DIFFERENT_BU, FIELD_NAME_TAKEN, ALREADY_ATTACHED, INVALID_MAPPING,
 * INVALID_MAPPING_ENTRY, DUPLICATE_CHILD_ASSIGNMENT, INVALID_PARENT_ITEM,
 * INVALID_CHILD_ITEM, UNMAPPED_CHILD_ITEMS, ATTACH_FAILED.
 */
boardController.post(
  "/:parentId/attach-child",
  zValidator("json", attachChildSchema),
  async (c) => {
    if (config.dbType !== "postgres") {
      return c.json(
        {
          error: "attach-child requires PostgreSQL",
          message: "Set DB_TYPE=postgres to enable this endpoint.",
        },
        501,
      );
    }
    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }
    try {
      const db = c.get("db");
      const userId = c.get("userId");
      const parentId = c.req.param("parentId");
      const body = c.req.valid("json");

      const boardService = new BoardService({ db });
      const result = await boardService.attachChild({
        parentBoardId: parentId,
        childBoardId: body.child_board_id,
        fieldName: body.field_name,
        itemMapping: body.item_mapping,
        organizationId,
        userId,
      });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof AttachDetachError) {
        return c.json(
          {
            code: error.code,
            message: error.message,
            ...(error.details ?? {}),
          },
          error.statusCode as any,
        );
      }
      logger.error("Error in attachChild:", error);
      return c.json(
        { code: "ATTACH_FAILED", message: (error as Error).message },
        500,
      );
    }
  },
);

/**
 * POST /boards/:parentId/detach-child/:childId
 * Reverse of attach-child. Marks the parent's TIT field deprecated, drops the
 * table_in_columns edges, clears related_board_item_id on child items, and
 * (by default) restores the child as an independent board.
 *
 * Body: { restore_as_independent?: boolean }  (default true)
 * Returns: { parent_board_id, child_board_id, deprecated_field_id,
 *            deprecated_field_name, deleted_edges, restored_as_independent }
 *
 * Error codes: MISSING_BOARD_IDS, PARENT_BOARD_NOT_FOUND,
 * CHILD_BOARD_NOT_FOUND, CHILD_NOT_NESTED, NOT_ATTACHED, DETACH_FAILED.
 */
boardController.post(
  "/:parentId/detach-child/:childId",
  zValidator("json", detachChildSchema),
  async (c) => {
    if (config.dbType !== "postgres") {
      return c.json(
        {
          error: "detach-child requires PostgreSQL",
          message: "Set DB_TYPE=postgres to enable this endpoint.",
        },
        501,
      );
    }
    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }
    try {
      const db = c.get("db");
      const parentId = c.req.param("parentId");
      const childId = c.req.param("childId");
      const body = c.req.valid("json");

      const boardService = new BoardService({ db });
      const result = await boardService.detachChild({
        parentBoardId: parentId,
        childBoardId: childId,
        organizationId,
        restoreAsIndependent: body.restore_as_independent,
      });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof AttachDetachError) {
        return c.json(
          {
            code: error.code,
            message: error.message,
            ...(error.details ?? {}),
          },
          error.statusCode as any,
        );
      }
      logger.error("Error in detachChild:", error);
      return c.json(
        { code: "DETACH_FAILED", message: (error as Error).message },
        500,
      );
    }
  },
);

/**
 * GET /boards/:id
 * Get board by ID
 */
boardController.get("/:id", async (c) => {
  try {
    const db = c.get("db");
    const teamIds = c.get("teamIds") || [];
    const id = c.req.param("id");

    const boardService = new BoardService({ db });
    const board = await boardService.getBoard(id);

    // Check access if teamIds available
    if (teamIds.length > 0) {
      const hasAccess = await boardService.hasAccess(id, teamIds);
      if (!hasAccess) {
        return c.json({ error: "Access denied" }, 403);
      }
    }

    return c.json({ data: boardToResponse(board) });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error getting board:", error);
    return c.json(
      { error: "Failed to get board", message: (error as Error).message },
      500,
    );
  }
});

/**
 * POST /boards
 * Create a new board
 */
/**
 * POST /boards/_seed_default
 * Internal-only — called by platform-service from CreateOrganization to
 * provision the 6 default CRM boards on a fresh org. No auth (relies on
 * internal network), idempotent (skips if the org already has any boards).
 * Body: { organization_id, business_unit_id }
 */
boardController.post("/_seed_default", async (c) => {
  try {
    const db = c.get("db");
    const body = await c.req.json().catch(() => ({}) as any);
    const organizationId: string | undefined =
      body?.organization_id ?? body?.organizationId;
    const businessUnitId: string | undefined =
      body?.business_unit_id ?? body?.businessUnitId;

    if (!organizationId || !businessUnitId) {
      return c.json(
        { error: "organization_id and business_unit_id are required" },
        400,
      );
    }

    const boardService = new BoardService({ db });
    const result = await boardService.seedDefaults(
      organizationId,
      businessUnitId,
    );
    return c.json(result, 201);
  } catch (error) {
    logger.error("Error seeding default boards:", error);
    return c.json(
      {
        error: "Failed to seed default boards",
        message: (error as Error).message,
      },
      500,
    );
  }
});

boardController.post("/", zValidator("json", createBoardSchema), async (c) => {
  try {
    const db = c.get("db");
    const userId = c.get("userId");
    const organizationId = c.get("organizationId");
    const businessUnitId = c.get("businessUnitId");
    const data = c.req.valid("json");

    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }

    // Map request data to DTO — recursive to handle TABLE_IN_TABLE nested fields
    const mapField = (field: any): any => ({
      ...field,
      id: crypto.randomUUID(),
      hidden: false,
      hiddenOnRecord: false,
      isIdentifier: field.isUniqueIdentifier || false,
      isDeprecated: false,
      fields: field.fields?.map(mapField),
    });

    const createDto: any = {
      ...data,
      organization_id: organizationId,
      business_unit_id: businessUnitId || "",
      fields: data.fields?.map(mapField),
      managers: data.managers?.map((manager) => ({
        ...manager,
        permissions: {
          ...manager.permissions,
          delete: manager.permissions.delete ?? false,
          manageFields: manager.permissions.write, // Default manageFields to write permission
        },
      })),
    };

    // FE sends the category as `category` (id string, or null); the model stores it
    // as `category_id`. Mirrors the /schemas convention.
    if ("category" in data) {
      createDto.category_id = (data as any).category ?? null;
      delete createDto.category;
    }

    const boardService = new BoardService({ db });
    const board = await boardService.createBoard(createDto);

    logger.info(`Board created by user ${userId}: ${board.id}`);
    emitBoardAudit({
      organizationId,
      userId,
      action: "create",
      boardId: board.id,
      before: null,
      after: board,
    });
    return c.json({ data: boardToResponse(board) }, 201);
  } catch (error) {
    if (error instanceof ValidationError) {
      return c.json({ error: error.message }, 400);
    }
    logger.error("Error creating board:", error);
    return c.json(
      { error: "Failed to create board", message: (error as Error).message },
      500,
    );
  }
});

/**
 * PATCH /boards/:id
 * Update board
 */
boardController.patch(
  "/:id",
  zValidator("json", updateBoardSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const teamIds = c.get("teamIds") || [];
      const organizationId = c.get("organizationId");
      const userId = c.get("userId");
      const id = c.req.param("id");
      const updates = c.req.valid("json");

      const boardService = new BoardService({ db });

      // Check access
      if (teamIds.length > 0) {
        const hasAccess = await boardService.hasAccess(id, teamIds);
        if (!hasAccess) {
          return c.json({ error: "Access denied" }, 403);
        }
      }

      const updateDto: any = {
        ...updates,
      };

      // FE writes the category as `category` (id string, or null to clear); the model
      // stores it as `category_id`. Only touch it when the client sent it.
      if ("category" in updates) {
        updateDto.category_id = (updates as any).category ?? null;
        delete updateDto.category;
      }

      if (updates.managers) {
        updateDto.managers = updates.managers.map((manager) => ({
          ...manager,
          permissions: {
            ...manager.permissions,
            delete: manager.permissions.delete ?? false,
            manageFields: manager.permissions.write,
          },
        }));
      } else if (Array.isArray((updates as any).team_ids)) {
        // Deployment access sent as `team_ids` (the /databoards + Document-AI board
        // sync contract). Board access is stored as `managers`, so convert each team
        // id into a full-access manager. An empty array clears the restriction (= all
        // teams). Only applied when the caller didn't send an explicit managers array.
        updateDto.managers = teamIdsToBoardManagers((updates as any).team_ids);
      }
      // `team_ids` is not a board column — never let it reach the repository.
      delete updateDto.team_ids;

      // capture before-state for the audit trail (non-fatal)
      let before: unknown = null;
      try {
        before = await boardService.getBoard(id);
      } catch {
        /* ignore */
      }
      const board = await boardService.updateBoard(id, updateDto);
      emitBoardAudit({
        organizationId,
        userId,
        action: "update",
        boardId: id,
        before,
        after: board,
      });
      return c.json({ data: boardToResponse(board) });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      logger.error("Error updating board:", error);
      return c.json(
        { error: "Failed to update board", message: (error as Error).message },
        500,
      );
    }
  },
);

// PUT /boards/:id — backward-compat alias for PATCH
boardController.on(
  ["PUT"],
  "/:id",
  zValidator("json", updateBoardSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const teamIds = c.get("teamIds") || [];
      const organizationId = c.get("organizationId");
      const userId = c.get("userId");
      const id = c.req.param("id");
      const updates = c.req.valid("json");
      const boardService = new BoardService({ db });
      if (teamIds.length > 0) {
        const hasAccess = await boardService.hasAccess(id, teamIds);
        if (!hasAccess) return c.json({ error: "Access denied" }, 403);
      }
      const updateDto: any = { ...updates };
      if ("category" in updates) {
        updateDto.category_id = (updates as any).category ?? null;
        delete updateDto.category;
      }
      if (updates.managers) {
        updateDto.managers = updates.managers.map((manager: any) => ({
          ...manager,
          permissions: {
            ...manager.permissions,
            delete: manager.permissions.delete ?? false,
            manageFields: manager.permissions.write,
          },
        }));
      } else if (Array.isArray((updates as any).team_ids)) {
        // See the PATCH handler above: `team_ids` deployment access → board `managers`.
        updateDto.managers = teamIdsToBoardManagers((updates as any).team_ids);
      }
      // `team_ids` is not a board column — never let it reach the repository.
      delete updateDto.team_ids;
      let before: unknown = null;
      try {
        before = await boardService.getBoard(id);
      } catch {
        /* ignore */
      }
      const board = await boardService.updateBoard(id, updateDto);
      emitBoardAudit({
        organizationId,
        userId,
        action: "update",
        boardId: id,
        before,
        after: board,
      });
      return c.json({ data: boardToResponse(board) });
    } catch (error) {
      if (error instanceof NotFoundError)
        return c.json({ error: (error as Error).message }, 404);
      if (error instanceof ValidationError)
        return c.json({ error: (error as Error).message }, 400);
      return c.json(
        { error: "Failed to update board", message: (error as Error).message },
        500,
      );
    }
  },
);

/**
 * DELETE /boards/:id
 * Delete board
 */
boardController.delete("/:id", async (c) => {
  try {
    const db = c.get("db");
    const teamIds = c.get("teamIds") || [];
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const id = c.req.param("id");

    const boardService = new BoardService({ db });

    // Check access
    if (teamIds.length > 0) {
      const hasAccess = await boardService.hasAccess(id, teamIds);
      if (!hasAccess) {
        return c.json({ error: "Access denied" }, 403);
      }
    }

    let before: unknown = null;
    try {
      before = await boardService.getBoard(id);
    } catch {
      /* ignore */
    }
    await boardService.deleteBoard(id);
    emitBoardAudit({
      organizationId,
      userId,
      action: "delete",
      boardId: id,
      before,
      after: null,
    });
    return c.json({ message: "Board deleted successfully" });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error deleting board:", error);
    return c.json(
      { error: "Failed to delete board", message: (error as Error).message },
      500,
    );
  }
});

/**
 * POST /boards/:id/fields
 * Add field to board
 */
boardController.post(
  "/:id/fields",
  zValidator("json", createBoardFieldSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const teamIds = c.get("teamIds") || [];
      const boardId = c.req.param("id");
      const fieldData = c.req.valid("json");

      const boardService = new BoardService({ db });

      // Check access
      if (teamIds.length > 0) {
        const hasAccess = await boardService.hasAccess(boardId, teamIds);
        if (!hasAccess) {
          return c.json({ error: "Access denied" }, 403);
        }
      }

      const board = await runBoardFieldMutation(c, boardId, boardService, () =>
        boardService.addField(boardId, fieldData),
      );
      return c.json({ data: boardToResponse(board) }, 201);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      logger.error("Error adding field:", error);
      return c.json(
        { error: "Failed to add field", message: (error as Error).message },
        500,
      );
    }
  },
);

/**
 * PATCH /boards/:boardId/fields/bulk
 * Bulk create or update multiple fields
 * If field_id is empty/missing → create new field
 * If field_id is provided → update existing field
 * Equivalent to backend's PUT /v1/board/:boardId/:orgId/multiple_board_fields
 * NOTE: Must be registered before /:id/fields/:fieldId to avoid param capture
 */
boardController.patch(
  "/:boardId/fields/bulk",
  zValidator("json", bulkFieldsSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const boardId = c.req.param("boardId");
      const { fields } = c.req.valid("json");

      const boardService = new BoardService({ db });

      // capture before-state for the field-diff audit (independent fetch so the
      // loop's reassignments below don't mutate it)
      const auditBefore = await boardService
        .getBoard(boardId)
        .catch(() => null);
      let board = await boardService.getBoard(boardId);

      for (const field of fields) {
        const hasFieldId = field.field_id && field.field_id.trim() !== "";

        if (hasFieldId) {
          // Update existing field
          board = await boardService.updateField(boardId, field.field_id!, {
            name: field.name,
            description: field.description,
            hidden: field.hidden,
            hiddenOnRecord: field.hidden_on_record,
            data: field.data as any,
            // Settings carry sampleData / default_country_code / … — only include the key
            // when the client sent it, otherwise the repository's spread would wipe the
            // stored settings (e.g. a TIT field's childBoardId).
            ...(field.settings !== undefined
              ? { settings: field.settings as any }
              : {}),
          });
        } else {
          // Create new field — map external snake_case to internal camelCase DTO.
          // For TABLE_IN_TABLE, forward child_board_name + nested fields so the
          // service can auto-create the child board and link it.
          board = await boardService.addField(boardId, {
            name: field.name,
            description: field.description,
            type: field.type as any,
            isUniqueIdentifier: field.is_unique_identifier,
            hidden: field.hidden,
            hiddenOnRecord: field.hidden_on_record,
            data: field.data as any,
            fields: field.fields as any,
            settings:
              field.settings || field.child_board_name
                ? {
                    ...(field.settings ?? {}),
                    ...(field.child_board_name
                      ? { childBoardName: field.child_board_name }
                      : {}),
                  }
                : undefined,
          });
        }
      }

      emitBoardAudit({
        organizationId: c.get("organizationId"),
        userId: c.get("userId"),
        action: "update",
        boardId,
        before: auditBefore,
        after: board,
      });
      return c.json({ data: boardToResponse(board) });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      logger.error("Error bulk updating fields:", error);
      return c.json(
        {
          error: "Failed to bulk update fields",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * PATCH /boards/:id/fields/:fieldId
 * Update board field
 */
boardController.patch(
  "/:id/fields/:fieldId",
  zValidator("json", updateBoardFieldSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const teamIds = c.get("teamIds") || [];
      const boardId = c.req.param("id");
      const fieldId = c.req.param("fieldId");
      const updates = c.req.valid("json");

      const boardService = new BoardService({ db });

      // Check access
      if (teamIds.length > 0) {
        const hasAccess = await boardService.hasAccess(boardId, teamIds);
        if (!hasAccess) {
          return c.json({ error: "Access denied" }, 403);
        }
      }

      const board = await runBoardFieldMutation(c, boardId, boardService, () =>
        boardService.updateField(boardId, fieldId, updates),
      );
      return c.json({ data: boardToResponse(board) });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      logger.error("Error updating field:", error);
      return c.json(
        { error: "Failed to update field", message: (error as Error).message },
        500,
      );
    }
  },
);

// PUT /boards/:boardId/fields/bulk — backward-compat alias for PATCH
boardController.on(
  ["PUT"],
  "/:boardId/fields/bulk",
  zValidator("json", bulkFieldsSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const boardId = c.req.param("boardId");
      const { fields } = c.req.valid("json");
      const boardService = new BoardService({ db });
      // capture before-state for the field-diff audit (independent of the loop var)
      const auditBefore = await boardService
        .getBoard(boardId)
        .catch(() => null);
      let board = await boardService.getBoard(boardId);
      for (const field of fields) {
        const hasFieldId = field.field_id && field.field_id.trim() !== "";
        if (hasFieldId) {
          board = await boardService.updateField(boardId, field.field_id!, {
            name: field.name,
            description: field.description,
            hidden: field.hidden,
            hiddenOnRecord: field.hidden_on_record,
            data: field.data as any,
            ...(field.settings !== undefined
              ? { settings: field.settings as any }
              : {}),
          });
        } else {
          board = await boardService.addField(boardId, {
            name: field.name,
            description: field.description,
            type: field.type as any,
            isUniqueIdentifier: field.is_unique_identifier,
            hidden: field.hidden,
            hiddenOnRecord: field.hidden_on_record,
            data: field.data as any,
            fields: field.fields as any,
            settings:
              field.settings || field.child_board_name
                ? {
                    ...(field.settings ?? {}),
                    ...(field.child_board_name
                      ? { childBoardName: field.child_board_name }
                      : {}),
                  }
                : undefined,
          });
        }
      }
      emitBoardAudit({
        organizationId: c.get("organizationId"),
        userId: c.get("userId"),
        action: "update",
        boardId,
        before: auditBefore,
        after: board,
      });
      return c.json({ data: boardToResponse(board) });
    } catch (error) {
      if (error instanceof NotFoundError)
        return c.json({ error: (error as Error).message }, 404);
      if (error instanceof ValidationError)
        return c.json({ error: (error as Error).message }, 400);
      return c.json(
        {
          error: "Failed to bulk update fields",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

// PUT /boards/:id/fields/:fieldId — backward-compat alias for PATCH
boardController.on(
  ["PUT"],
  "/:id/fields/:fieldId",
  zValidator("json", updateBoardFieldSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const teamIds = c.get("teamIds") || [];
      const boardId = c.req.param("id");
      const fieldId = c.req.param("fieldId");
      const updates = c.req.valid("json");
      const boardService = new BoardService({ db });
      if (teamIds.length > 0) {
        const hasAccess = await boardService.hasAccess(boardId, teamIds);
        if (!hasAccess) return c.json({ error: "Access denied" }, 403);
      }
      const board = await runBoardFieldMutation(c, boardId, boardService, () =>
        boardService.updateField(boardId, fieldId, updates),
      );
      return c.json({ data: boardToResponse(board) });
    } catch (error) {
      if (error instanceof NotFoundError)
        return c.json({ error: (error as Error).message }, 404);
      if (error instanceof ValidationError)
        return c.json({ error: (error as Error).message }, 400);
      return c.json(
        { error: "Failed to update field", message: (error as Error).message },
        500,
      );
    }
  },
);

/**
 * DELETE /boards/:id/fields/:fieldId
 * Delete board field
 */
boardController.delete("/:id/fields/:fieldId", async (c) => {
  try {
    const db = c.get("db");
    const teamIds = c.get("teamIds") || [];
    const boardId = c.req.param("id");
    const fieldId = c.req.param("fieldId");

    const boardService = new BoardService({ db });

    // Check access
    if (teamIds.length > 0) {
      const hasAccess = await boardService.hasAccess(boardId, teamIds);
      if (!hasAccess) {
        return c.json({ error: "Access denied" }, 403);
      }
    }

    const board = await runBoardFieldMutation(c, boardId, boardService, () =>
      boardService.deleteField(boardId, fieldId),
    );
    return c.json({ data: boardToResponse(board) });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof ValidationError) {
      return c.json({ error: error.message }, 400);
    }
    logger.error("Error deleting field:", error);
    return c.json(
      { error: "Failed to delete field", message: (error as Error).message },
      500,
    );
  }
});

/**
 * POST /boards/:id/fields/reorder
 * Reorder board fields
 */
boardController.post(
  "/:id/fields/reorder",
  zValidator("json", reorderFieldsSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const teamIds = c.get("teamIds") || [];
      const boardId = c.req.param("id");
      const { fieldIds } = c.req.valid("json");

      const boardService = new BoardService({ db });

      // Check access
      if (teamIds.length > 0) {
        const hasAccess = await boardService.hasAccess(boardId, teamIds);
        if (!hasAccess) {
          return c.json({ error: "Access denied" }, 403);
        }
      }

      const board = await runBoardFieldMutation(c, boardId, boardService, () =>
        boardService.reorderFields(boardId, fieldIds),
      );
      return c.json({ data: boardToResponse(board) });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      logger.error("Error reordering fields:", error);
      return c.json(
        {
          error: "Failed to reorder fields",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * POST /boards/reorder
 * Reorder boards
 */
boardController.post(
  "/reorder",
  zValidator("json", reorderBoardsSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const { boardIds } = c.req.valid("json");

      const boardService = new BoardService({ db });
      await boardService.reorderBoards(boardIds);

      return c.json({ message: "Boards reordered successfully" });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      logger.error("Error reordering boards:", error);
      return c.json(
        {
          error: "Failed to reorder boards",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * GET /boards/:id/fields/:fieldId
 * Get specific field
 */
boardController.get("/:id/fields/:fieldId", async (c) => {
  try {
    const db = c.get("db");
    const boardId = c.req.param("id");
    const fieldId = c.req.param("fieldId");

    const boardService = new BoardService({ db });
    const field = await boardService.getField(boardId, fieldId);

    return c.json({ data: field });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error getting field:", error);
    return c.json(
      { error: "Failed to get field", message: (error as Error).message },
      500,
    );
  }
});

/**
 * GET /boards/:boardId/schema
 * Return board schema + first board item
 * Equivalent to backend's /v1/organization/:orgId/boards/:boardId/boardSchema
 */
boardController.get("/:boardId/schema", async (c) => {
  try {
    const db = c.get("db");
    const boardId = c.req.param("boardId");

    const boardService = new BoardService({ db });
    const boardItemService = new BoardItemService({ db });

    const board = await boardService.getBoard(boardId);

    // Fetch first item for sample data
    const itemsResult = await boardItemService.getBoardItems(
      boardId,
      {
        limit: 1,
        skip: 0,
      },
      assigneeCtx(c),
    );
    const boardData =
      itemsResult.data && itemsResult.data.length > 0
        ? itemsResult.data[0]
        : null;

    return c.json({ boardSchema: board, boardData });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error getting board schema:", error);
    return c.json(
      {
        error: "Failed to get board schema",
        message: (error as Error).message,
      },
      500,
    );
  }
});

/**
 * POST /boards/:boardId/aggregate
 * Execute a filtered query / aggregation on board items
 * Equivalent to backend's POST /v1/organization/:orgId/boards/:boardId/aggregate
 * Body: { "query": [] | { filters, limit, skip } }
 */
boardController.post(
  "/:boardId/aggregate",
  zValidator("json", aggregateSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const boardId = c.req.param("boardId");
      const { query } = c.req.valid("json");

      const boardItemService = new BoardItemService({ db });

      // Normalise query into QueryOptions
      let filter: Record<string, any> | undefined;
      let limit = 100;
      let skip = 0;

      if (Array.isArray(query)) {
        // Treat as raw filter array (pass-through)
        filter = query.length > 0 ? { $pipeline: query } : undefined;
      } else if (query && typeof query === "object") {
        filter = query.filters ?? query.filter;
        limit = query.limit ?? limit;
        skip = query.skip ?? skip;
      }

      const result = filter
        ? await boardItemService.getBoardItemsByFilter(
            boardId,
            filter,
            { limit, skip },
            assigneeCtx(c),
          )
        : await boardItemService.getBoardItems(
            boardId,
            { limit, skip },
            assigneeCtx(c),
          );

      return c.json({ data: result.data, count: result.count });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      logger.error("Error running aggregate:", error);
      return c.json(
        {
          error: "Failed to run aggregate",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * POST /boards/:boardId/export-embedding
 * Export board data for embedding jobs
 * Returns record count + placeholder download_url
 */
boardController.post("/:boardId/export-embedding", async (c) => {
  try {
    const db = c.get("db");
    const boardId = c.req.param("boardId");

    const boardService = new BoardService({ db });
    const boardItemService = new BoardItemService({ db });

    const board = await boardService.getBoard(boardId);

    // Get all items (large limit) to count them
    const result = await boardItemService.getBoardItems(boardId, {
      limit: 10000,
      skip: 0,
    });

    const recordCount = result.count ?? result.data?.length ?? 0;
    const boardName = board.name;
    const fileName = `${boardName.replace(/\s+/g, "_").toLowerCase()}_export.jsonl`;

    return c.json({
      download_url: `/api/boards/${boardId}/export-embedding/download`,
      record_count: recordCount,
      board_name: boardName,
      file_name: fileName,
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error exporting board for embedding:", error);
    return c.json(
      {
        error: "Failed to export board for embedding",
        message: (error as Error).message,
      },
      500,
    );
  }
});
