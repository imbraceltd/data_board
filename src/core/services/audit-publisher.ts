/**
 * Audit publisher — fire-and-forget POST of audit events to platform-service.
 *
 * data-board is the publisher; platform-service (`/v1/internal/audit-logs`) is
 * the receiver that persists them. Failures are NON-FATAL — we never block or
 * fail a user's data-entry/upload because the audit sink hiccuped; we log and
 * move on. Same `.lan` vhost + non-fatal philosophy as platform-account.client.
 */
import axios from "axios";
import config from "../../config";
import logger from "../../infrastructure/logging/logger";
import { getRequestId, getContext } from "../../infrastructure/logging/request-context";

export type AuditAction = "create" | "update" | "delete" | "upload";
export type AuditResource = "board_item" | "file";

export interface AuditEvent {
  organizationId: string;
  userId?: string | null;
  actor?: { name?: string; email?: string };
  action: AuditAction;
  resource: AuditResource;
  resourceId?: string | null;
  resourceName?: string | null;
  changes?: { before?: unknown; after?: unknown } | null;
  metadata?: Record<string, unknown>;
}

/**
 * Diff two board metadata objects (name, description, etc.) for audit trail.
 * Returns resourceName (the board name) and a changes object with only the
 * fields that actually changed.
 */
export function buildBoardChanges(
  before: any,
  after: any,
): {
  resourceName: string | null;
  changes: {
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    fields: Array<{ field: string; fieldId: string; before: unknown; after: unknown }>;
  };
} {
  const TRACKED = ["name", "description", "show_id", "category", "team_ids"];
  const resourceName: string | null = (after?.name ?? before?.name) || null;
  const diff: Array<{ field: string; fieldId: string; before: unknown; after: unknown }> = [];
  const lblBefore: Record<string, unknown> = {};
  const lblAfter: Record<string, unknown> = {};
  for (const key of TRACKED) {
    const b = before?.[key] ?? null;
    const a = after?.[key] ?? null;
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      diff.push({ field: key, fieldId: key, before: b, after: a });
      lblBefore[key] = b;
      lblAfter[key] = a;
    }
  }
  return {
    resourceName,
    changes: {
      before: before == null ? null : lblBefore,
      after: after == null ? null : lblAfter,
      fields: diff,
    },
  };
}

/**
 * Turn raw before/after board items into a human-readable audit shape using the
 * board's field definitions: resourceName from the identifier field, and a
 * label-keyed before/after + per-field diff (only changed fields). Falls back
 * gracefully when the board/fields are unavailable.
 */
export function buildBoardItemChanges(
  board: { fields?: Array<{ id: string; name: string; isIdentifier?: boolean; is_identifier?: boolean }> } | null | undefined,
  before: any,
  after: any,
): {
  resourceName: string | null;
  changes: {
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    fields: Array<{ field: string; fieldId: string; before: unknown; after: unknown }>;
  };
} {
  const fields = board?.fields ?? [];
  const nameById = new Map(fields.map((f) => [f.id, f.name]));
  // Mongo-migrated fields carry `is_identifier` (snake); in-service-created
  // fields carry `isIdentifier` (camel). Accept both.
  const identifier = fields.find((f) => f.isIdentifier ?? f.is_identifier);
  const beforeF: Record<string, unknown> = (before?.fields ?? {}) as any;
  const afterF: Record<string, unknown> = (after?.fields ?? {}) as any;

  let resourceName: string | null = null;
  if (identifier) {
    const idVal = afterF[identifier.id] ?? beforeF[identifier.id];
    resourceName = typeof idVal === "string" ? idVal : idVal != null ? String(idVal) : null;
  }

  const ids = new Set([...Object.keys(beforeF), ...Object.keys(afterF)]);
  const diff: Array<{ field: string; fieldId: string; before: unknown; after: unknown }> = [];
  const lblBefore: Record<string, unknown> = {};
  const lblAfter: Record<string, unknown> = {};
  for (const fid of ids) {
    const label = nameById.get(fid);
    if (!label) continue;
    const b = beforeF[fid] ?? null;
    const a = afterF[fid] ?? null;
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      diff.push({ field: label, fieldId: fid, before: b, after: a });
      lblBefore[label] = b;
      lblAfter[label] = a;
    }
  }

  return {
    resourceName,
    changes: {
      before: before == null ? null : lblBefore,
      after: after == null ? null : lblAfter,
      fields: diff,
    },
  };
}

/**
 * Map file records (knowledge drive/board) to audit events. `action` is
 * "upload" for new files or "delete". Skips records missing an org.
 */
export function fileAuditEvents(action: "upload" | "delete", files: any[], userId?: string): AuditEvent[] {
  return (files || [])
    .filter((f) => f && f.organization_id)
    .map((f) => {
      // For DELETE we snapshot the FULL restorable record (incl. the S3 `key`)
      // so revert can recreate the row — deleteMultipleFiles drops the DB row +
      // embeddings but leaves the S3 object, so a delete is reversible. For
      // UPLOAD the compact display snapshot is enough.
      const restorable = {
        name: f.name,
        folder_id: f.folder_id ?? null,
        folderId: f.folder_id ?? null, // display alias
        sizeBytes: f.file_size ?? null,
        organization_id: f.organization_id,
        business_unit_id: f.business_unit_id ?? undefined,
        source_type: f.source_type ?? "local",
        key: f.key ?? undefined,
        file_type: f.file_type ?? undefined,
        file_size: f.file_size ?? undefined,
        tags: f.tags ?? undefined,
        remarks: f.remarks ?? undefined,
        external_id: f.external_id ?? undefined,
        external_source: f.external_source ?? undefined,
      };
      const uploadSnapshot = { name: f.name, folderId: f.folder_id ?? null, sizeBytes: f.file_size ?? null };
      return {
        organizationId: f.organization_id,
        userId,
        action,
        resource: "file" as const,
        resourceId: (f.id ?? f._id) ?? null,
        resourceName: f.name ?? null,
        changes:
          action === "upload"
            ? { before: null, after: uploadSnapshot }
            : { before: restorable, after: null },
        metadata: { folderId: f.folder_id ?? undefined, source: "knowledge_drive" },
      };
    });
}

/** Fire-and-forget. Returns immediately; never throws. */
export function publishAudit(events: AuditEvent[]): void {
  if (!events.length) return;
  if (!config.platformServiceHost) {
    logger.warn("audit: PLATFORM_SERVICE_HOST not configured — skipping audit publish");
    return;
  }
  const url = `${config.platformServiceHost.replace(/\/$/, "")}/v1/internal/audit-logs`;

  // Enrich metadata with request correlation (ip + request_id) when available.
  const ctx = getContext();
  const enriched = events.map((e) => ({
    ...e,
    metadata: {
      ...(e.metadata ?? {}),
      ...(ctx?.ip ? { ip: ctx.ip } : {}),
      ...(getRequestId() ? { requestId: getRequestId() } : {}),
    },
  }));

  void axios
    .post(url, { events: enriched }, { timeout: 5000, headers: { "Content-Type": "application/json" } })
    .catch((err) => logger.warn(`audit publish failed: ${err?.message ?? err}`));
}
