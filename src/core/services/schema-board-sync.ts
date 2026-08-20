/**
 * Schema → Board field propagation.
 *
 * When a Doc Schema's attributes change, every board listed in
 * `schema.databoard_ids` mirrors the change in its `fields` array. The id of
 * each schema attribute is the same id used when the board was provisioned
 * (see `toBoardField()` in doc-schema.service.ts), so matching is exact.
 *
 * Propagation is best-effort: a failure on one board (e.g. duplicate field
 * name from a manual edit) is logged and skipped, never thrown — the schema
 * mutation itself has already committed, and a half-propagated board is less
 * bad than a 500 the user can't easily recover from.
 *
 * Type changes on an existing field are NOT propagated — `UpdateBoardFieldDTO`
 * doesn't accept `type`, and silently changing a field's data type would
 * orphan existing rows that hold the old shape. Such cases are logged so an
 * operator can decide whether to delete-and-re-add manually.
 */

import { BoardService } from "./board.service";
import type { DatabaseClient } from "../../infrastructure/database/types";
import type {
  DocAttribute,
} from "../../domain/shared/doc-schema.types";
import type {
  CreateBoardFieldDTO,
  UpdateBoardFieldDTO,
} from "../../domain/shared/board.types";
import logger from "../../infrastructure/logging/logger";

/** Map an attribute patch onto a board-field patch. Skips fields the field
 *  DTO can't accept (type) and translates the rename (extractionPrompt → promptAI).
 *  Returns `null` if nothing maps — caller can skip the propagation call. */
function mapAttributePatchToFieldPatch(
  patch: Partial<DocAttribute>,
): UpdateBoardFieldDTO | null {
  const out: UpdateBoardFieldDTO = {};
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.description !== undefined) out.description = patch.description;
  if (patch.hidden !== undefined) out.hidden = patch.hidden;
  if (patch.hiddenOnRecord !== undefined) out.hiddenOnRecord = patch.hiddenOnRecord;
  if (patch.data !== undefined) out.data = patch.data;
  if (patch.settings !== undefined) out.settings = patch.settings;
  if (patch.extractionPrompt !== undefined) out.promptAI = patch.extractionPrompt;
  if (patch.role !== undefined) out.role = patch.role;
  return Object.keys(out).length > 0 ? out : null;
}

function mapAttributeToCreateField(a: DocAttribute): CreateBoardFieldDTO {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    type: a.type,
    isUniqueIdentifier: a.isUniqueIdentifier ?? false,
    hidden: a.hidden ?? false,
    hiddenOnRecord: a.hiddenOnRecord ?? false,
    contactField: a.contactField,
    isIdentifier: a.isIdentifier ?? false,
    data: a.data,
    settings: a.settings,
    promptAI: a.extractionPrompt,
    role: a.role,
  };
}

export async function syncAttributeUpdateToBoards(
  db: DatabaseClient,
  boardIds: string[],
  attributeId: string,
  patch: Partial<DocAttribute>,
  prevAttr?: DocAttribute,
): Promise<void> {
  if (!boardIds.length) return;
  const fieldPatch = mapAttributePatchToFieldPatch(patch);
  if (!fieldPatch) return;

  // Type changes can't ride through updateField — flag so an operator notices.
  if (patch.type !== undefined && prevAttr && patch.type !== prevAttr.type) {
    logger.warn(
      `[schema-sync] attribute ${attributeId} type changed (${prevAttr.type} → ${patch.type}); board fields NOT migrated automatically`,
      { boardIds },
    );
  }

  const boardService = new BoardService({ db });
  await Promise.all(
    boardIds.map(async (boardId) => {
      try {
        await boardService.updateField(boardId, attributeId, fieldPatch);
      } catch (err) {
        logger.warn(
          `[schema-sync] updateField failed for board ${boardId} field ${attributeId}`,
          { message: (err as Error).message },
        );
      }
    }),
  );
}

export async function syncAttributeDeleteToBoards(
  db: DatabaseClient,
  boardIds: string[],
  attributeId: string,
): Promise<void> {
  if (!boardIds.length) return;
  const boardService = new BoardService({ db });
  await Promise.all(
    boardIds.map(async (boardId) => {
      try {
        await boardService.deleteField(boardId, attributeId);
      } catch (err) {
        logger.warn(
          `[schema-sync] deleteField failed for board ${boardId} field ${attributeId}`,
          { message: (err as Error).message },
        );
      }
    }),
  );
}

export async function syncAttributeAddToBoards(
  db: DatabaseClient,
  boardIds: string[],
  attribute: DocAttribute,
): Promise<void> {
  if (!boardIds.length) return;
  const boardService = new BoardService({ db });
  const fieldData = mapAttributeToCreateField(attribute);
  await Promise.all(
    boardIds.map(async (boardId) => {
      try {
        await boardService.addField(boardId, fieldData);
      } catch (err) {
        logger.warn(
          `[schema-sync] addField failed for board ${boardId} attr ${attribute.id}`,
          { message: (err as Error).message },
        );
      }
    }),
  );
}

/**
 * Diff old vs new attribute lists and apply add/update/delete to each board.
 * Used by the full-schema `update()` path where the caller posts a fresh
 * attributes array instead of touching one attribute at a time.
 */
export async function syncAttributesDiffToBoards(
  db: DatabaseClient,
  boardIds: string[],
  prevAttrs: DocAttribute[],
  nextAttrs: DocAttribute[],
): Promise<void> {
  if (!boardIds.length) return;

  const prevById = new Map(prevAttrs.map((a) => [a.id, a] as const));
  const nextById = new Map(nextAttrs.map((a) => [a.id, a] as const));

  const added: DocAttribute[] = [];
  const removedIds: string[] = [];
  const updated: Array<{ id: string; patch: Partial<DocAttribute>; prev: DocAttribute }> = [];

  for (const [id, attr] of nextById) {
    if (!prevById.has(id)) {
      added.push(attr);
    } else {
      const prev = prevById.get(id)!;
      const patch = diffAttribute(prev, attr);
      if (patch) updated.push({ id, patch, prev });
    }
  }
  for (const id of prevById.keys()) {
    if (!nextById.has(id)) removedIds.push(id);
  }

  // Order: remove → update → add. Removing first frees up names/identifiers
  // so adds or renames don't trip the duplicate-name guard on board fields.
  for (const id of removedIds) {
    await syncAttributeDeleteToBoards(db, boardIds, id);
  }
  for (const { id, patch, prev } of updated) {
    await syncAttributeUpdateToBoards(db, boardIds, id, patch, prev);
  }
  for (const attr of added) {
    await syncAttributeAddToBoards(db, boardIds, attr);
  }
}

/** Shallow diff of fields the board-field DTO cares about. Returns null if
 *  nothing relevant changed (avoids a no-op call to updateField). */
function diffAttribute(
  prev: DocAttribute,
  next: DocAttribute,
): Partial<DocAttribute> | null {
  const patch: Partial<DocAttribute> = {};
  if (prev.name !== next.name) patch.name = next.name;
  if (prev.description !== next.description) patch.description = next.description;
  if (prev.type !== next.type) patch.type = next.type;
  if (prev.hidden !== next.hidden) patch.hidden = next.hidden;
  if (prev.hiddenOnRecord !== next.hiddenOnRecord) patch.hiddenOnRecord = next.hiddenOnRecord;
  if (prev.extractionPrompt !== next.extractionPrompt) {
    patch.extractionPrompt = next.extractionPrompt;
  }
  if (prev.role !== next.role) patch.role = next.role;
  // data/settings are objects — JSON-compare for cheap deep-equal check
  if (JSON.stringify(prev.data) !== JSON.stringify(next.data)) {
    patch.data = next.data;
  }
  if (JSON.stringify(prev.settings) !== JSON.stringify(next.settings)) {
    patch.settings = next.settings;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
