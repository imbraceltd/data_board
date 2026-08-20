/**
 * Internal audit-revert command endpoint.
 *
 * The standard interface every auditable service implements so the platform
 * audit service can dispatch a revert without knowing this domain's payloads:
 *   POST /internal/audit/apply-revert  { action, resource, resourceId, boardId?, changes }
 *
 * Applies the INVERSE of the original action using the service layer directly
 * (NOT the audited controller path), so it does not emit its own audit event —
 * the platform records the single action:"revert" entry. Trusted internal call.
 */
import { Hono } from "hono";
import { databaseMiddleware, extractUserContext } from "../middleware";
import { BoardItemService } from "../../core/services/board-item.service";
import fileService from "../../core/services/file.service";
import logger from "../../infrastructure/logging/logger";

const auditInternalRouter = new Hono();

auditInternalRouter.use("*", databaseMiddleware);
auditInternalRouter.use("*", extractUserContext());

/**
 * Prepare a deleted board item's captured fields for re-creation.
 *
 * Table-in-Table (TIT) child rows are cascade-deleted with their parent, and
 * the audit snapshot stored them HYDRATED — either a `{count,sum,data:[...]}`
 * read shape or a plain array, where each child is `{ _id, ...childFields }`.
 * createBoardItem/splitInlineTitFields would see that `_id` and treat the entry
 * as a ref / in-place update to an EXISTING child — a no-op now that the child
 * is gone, leaving the restored TIT field empty. Stripping the child id keys
 * routes each entry through the new-child branch instead, so the children are
 * re-inserted fresh (with new edges). Non-TIT field values pass through
 * untouched (string/primitive arrays, scalars).
 */
function rebuildTitChildrenForRestore(fields: Record<string, any>): Record<string, any> {
  const stripId = (e: any) => {
    if (e && typeof e === "object" && !Array.isArray(e)) {
      const { _id, id, board_item_id, ...rest } = e;
      return rest;
    }
    return e; // string ref / primitive — leave as-is
  };
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      out[k] = v.some((e) => e && typeof e === "object" && !Array.isArray(e)) ? v.map(stripId) : v;
    } else if (v && typeof v === "object" && Array.isArray((v as any).data)) {
      // Hydrated read shape { count, sum, data:[...] }. UNWRAP to a plain array:
      // createBoardItem's processFieldValue only passes through arrays for a TIT
      // field and drops any other shape (incl. {count,sum,data}) to [] before
      // splitInlineTitFields ever runs, so the wrapper must be removed here.
      out[k] = (v as any).data.map(stripId);
    } else {
      out[k] = v;
    }
  }
  return out;
}

auditInternalRouter.post("/internal/audit/apply-revert", async (c) => {
  try {
    const db = c.get("db");
    const organizationId = c.get("organizationId");
    const body = await c.req.json<{
      action?: string;
      resource?: string;
      resourceId?: string;
      boardId?: string;
      changes?: {
        before?: any;
        after?: any;
        fields?: Array<{ fieldId: string; before: any; after: any }>;
      };
    }>();
    const { action, resource, resourceId, boardId, changes } = body;
    if (!action || !resource || !resourceId) {
      return c.json({ error: "action, resource, resourceId are required" }, 400);
    }

    if (resource === "board_item") {
      const svc = new BoardItemService({ db });
      if (action === "update") {
        // re-apply the original "before" values (field-id keyed)
        const fields: Record<string, unknown> = {};
        for (const f of changes?.fields ?? []) fields[f.fieldId] = f.before;
        await svc.updateBoardItem(resourceId, { fields } as any);
        return c.json({ success: true, restoredResourceId: resourceId });
      }
      if (action === "create") {
        await svc.deleteBoardItem(resourceId);
        return c.json({ success: true, restoredResourceId: resourceId });
      }
      if (action === "delete") {
        if (!boardId) return c.json({ error: "boardId required to recreate the item" }, 400);
        // createBoardItem (the service, not the HTTP schema) expects a
        // field-id-keyed RECORD, not the [{board_field_id,value}] array the
        // controller's zod transform produces. Passing an array here makes
        // validateAndProcessFields read fields[fieldId]===undefined for every
        // field → the item comes back EMPTY. Build the record directly.
        const fields: Record<string, unknown> = {};
        for (const f of changes?.fields ?? []) fields[f.fieldId] = f.before;
        // TIT child rows were cascade-deleted with the parent — strip their ids
        // so they're re-inserted rather than treated as (now-missing) refs.
        const restoreFields = rebuildTitChildrenForRestore(fields);
        const item = await svc.createBoardItem({ board_id: boardId, organization_id: organizationId, fields: restoreFields } as any);
        return c.json({ success: true, restoredResourceId: item.id });
      }
      return c.json({ error: `cannot revert board_item action "${action}"` }, 400);
    }

    if (resource === "file") {
      if (action === "upload") {
        await fileService.deleteMultipleFiles([resourceId]);
        return c.json({ success: true, restoredResourceId: resourceId });
      }
      if (action === "delete") {
        // deleteMultipleFiles removes the DB row + embeddings but NOT the S3
        // object, so a delete is reversible: recreate the file record pointing
        // at the still-present S3 key. Needs the full snapshot captured at
        // delete time (key/file_type/etc) — see fileAuditEvents.
        const snap = (changes?.before ?? {}) as any;
        if (!snap || !snap.key) {
          return c.json(
            { error: "cannot revert: original file storage key missing from the audit record (deleted before restore support)" },
            400,
          );
        }
        const restored = await fileService.createFile({
          name: snap.name,
          folder_id: snap.folder_id,
          organization_id: organizationId ?? snap.organization_id,
          business_unit_id: snap.business_unit_id,
          source_type: snap.source_type ?? "local",
          key: snap.key,
          file_type: snap.file_type,
          file_size: snap.file_size,
          tags: snap.tags,
          remarks: snap.remarks,
          external_id: snap.external_id,
          external_source: snap.external_source,
        } as any);
        return c.json({ success: true, restoredResourceId: (restored as any)?.id ?? (restored as any)?._id });
      }
      return c.json({ error: `cannot revert file action "${action}"` }, 400);
    }

    return c.json({ error: `unsupported resource "${resource}"` }, 400);
  } catch (err) {
    logger.error("apply-revert failed:", err);
    return c.json({ error: "apply-revert failed", message: (err as Error).message }, 500);
  }
});

export default auditInternalRouter;
