/**
 * BoardItem Service
 * Business logic for board item management with field validation
 */

import type { DatabaseClient } from "../../infrastructure/database/types";
import { BoardItemRepository } from "../../infrastructure/database/repositories/board-item.repository";
import { BoardRepository } from "../../infrastructure/database/repositories/board.repository";
import { CreateType } from "../../domain/shared/board-item.types";
import type {
  BoardItem,
  PaginatedResult,
  QueryOptions,
  CreateBoardItemDTO,
  UpdateBoardItemDTO,
} from "../../domain/shared/board-item.types";
import type { Board, BoardField } from "../../domain/shared/board.types";
import { BoardFieldType } from "../../domain/shared/board.types";
import {
  ValidationError,
  NotFoundError,
  ConflictError,
} from "../../domain/shared/errors";
import {
  // validateFieldValue,  // temporarily disabled — see validateAndProcessFields
  validateRequired,
  validateSelectOption,
  validateMultiSelectOptions,
  sanitizeText,
  formatPhoneNumber,
} from "../validation/field-validators";
import * as countriesAndTimezones from "countries-and-timezones";
import logger from "../../infrastructure/logging/logger";
import aiService from "./ai.service";
import { BoardType } from "../../domain/shared/board.types";
import { eq, and, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../db/drizzle/schema";
import KafkaAutomation from "../../infrastructure/messaging/kafka-automation";
import config from "../../config";
import { CRMBoardRepository } from "../../infrastructure/database/repositories/crmboard.repository";
import type { CRMBoard } from "../../domain/shared/crmboard.types";
import { fetchOrgUserMap, type AssigneeSummary } from "./platform-users.client";

const AP_CRM_EVENT_TOPIC = "AP_OUTGOING_CRM_EVENT";

/**
 * Request context needed to hydrate assignee/people field values from
 * platform-service. All optional — when absent, assignee hydration is a no-op
 * and values are returned id-only (graceful degrade). Threaded down from
 * controllers (gateway headers → `c.get(...)`).
 */
export interface AssigneeHydrationContext {
  organizationId?: string;
  userId?: string;
  accessToken?: string;
}
type CrmEventType = "create" | "update" | "delete";

/** workflow_id values that are non-numeric strings belong to Workflow. */
function isApWorkflowId(workflowId: string | undefined | null): boolean {
  if (!workflowId) return false;
  return !/^\d+$/.test(String(workflowId));
}

/**
 * Shape of an entry inside a TIT field array as it comes off the wire.
 * - `string` — ref to an existing child item id
 * - `{ _id|board_item_id|id }` with ≤ 2 keys — also a ref
 * - everything else — a new child item to create (its keys are the child's fields)
 */
type TitEntry = string | Record<string, any>;

interface SplitNewChild {
  newId: string;
  childBoardId: string;
  parentFieldId: string;
  fields: Record<string, any>;
}

interface SplitEdge {
  parent_board_field_id: string;
  child_board_id: string;
  child_board_item_id: string;
}

interface SplitRef {
  id: string;
  expectedChildBoardId: string;
}

interface SplitChildUpdate {
  id: string;
  childBoardId: string;
  fields: Record<string, any>;
}

interface SplitResult {
  /** Parent fields with every TIT array replaced by a string[] of child ids. */
  trimmedFields: Record<string, any>;
  /** New child items to insert in the child board. */
  newChildItems: SplitNewChild[];
  /** Edges to insert into table_in_columns (parent_board_item_id filled in by caller). */
  edges: SplitEdge[];
  /** Existing child item ids referenced by the payload — caller must validate they exist + belong to expectedChildBoardId. */
  refs: SplitRef[];
  /** In-place updates to apply to existing child items (entries that carry `_id`/`id`/`board_item_id` plus extra field keys). */
  childUpdates: SplitChildUpdate[];
  /** TIT field ids that the payload actually touched (used by update path to scope edge rewrites). */
  touchedFieldIds: string[];
}

export interface BoardItemServiceConfig {
  db: DatabaseClient;
}

export class BoardItemService {
  private itemRepository: BoardItemRepository;
  private boardRepository: BoardRepository;
  private db: DatabaseClient;

  constructor(config: BoardItemServiceConfig) {
    this.itemRepository = new BoardItemRepository(config.db);
    this.boardRepository = new BoardRepository(config.db);
    this.db = config.db;
  }

  /**
   * Raw Drizzle handle for transactional TIT writes. Throws if the adapter
   * isn't Postgres/Drizzle — TIT splitting needs `table_in_columns` and
   * `tx.transaction(...)`, neither of which the Mongo adapter implements.
   */
  private getDrizzle(): NodePgDatabase<typeof schema> {
    const raw = this.db.getRawClient?.();
    if (!raw || typeof (raw as any).transaction !== "function") {
      throw new ValidationError(
        "Inline TIT writes require Postgres (Drizzle). Set DB_TYPE=postgres.",
      );
    }
    return raw as NodePgDatabase<typeof schema>;
  }

  /**
   * Get board item by ID. TIT field id arrays are hydrated to full child
   * objects so the FE sees the same shape as a parent item read.
   */
  async getBoardItem(
    id: string,
    ctx?: AssigneeHydrationContext,
  ): Promise<BoardItem> {
    const item = await this.itemRepository.findById(id);
    if (!item) {
      throw new NotFoundError(`Board item ${id} not found`);
    }
    const board = await this.boardRepository
      .findById(item.board_id)
      .catch(() => null);
    if (board) {
      await this.hydrateTitFields([item], board);
      this.resolveSelectionLabels([item], board);
      await this.hydrateAssigneeFields([item], board, ctx);
    }
    return item;
  }

  /**
   * Get a board item with its field map rewritten so keys are the
   * human-readable field names (instead of the internal field IDs).
   *
   * Returned shape — `{ data: [<row>], count: 1 }` — replays the legacy
   * `GET /:id/board_item_details/:item` contract from the pre-migration
   * backend so consumers built against it keep working unchanged.
   * `null`-valued fields are dropped, mirroring the legacy filter.
   */
  async getBoardItemDetails(
    id: string,
  ): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
    const item = await this.getBoardItem(id);
    const board = await this.boardRepository
      .findById(item.board_id)
      .catch(() => null);

    const fieldIdToName: Record<string, string> = {};
    if (board?.fields) {
      for (const f of board.fields) {
        if (f.id && f.name) fieldIdToName[f.id] = f.name;
      }
    }

    const renamed: Record<string, unknown> = {};
    const raw = item.fields || {};
    for (const [fieldId, value] of Object.entries(raw)) {
      if (value === null || value === undefined) continue;
      renamed[fieldIdToName[fieldId] || fieldId] = value;
    }

    return { data: [renamed], count: 1 };
  }

  /**
   * Get board items with pagination and filtering. TIT id arrays are batch-
   * hydrated (1 query per child board, regardless of page size).
   */
  async getBoardItems(
    boardId: string,
    options: QueryOptions,
    ctx?: AssigneeHydrationContext,
  ): Promise<PaginatedResult<BoardItem>> {
    const result = await this.itemRepository.findByBoard(boardId, options);
    const board = await this.boardRepository
      .findById(boardId)
      .catch(() => null);
    if (board) {
      await this.hydrateTitFields(result.data, board);
      this.resolveSelectionLabels(result.data, board);
      await this.hydrateAssigneeFields(result.data, board, ctx);
    }
    return result;
  }

  /**
   * Hydrate TableInTable fields on an externally-sourced list of items
   * (e.g. search hits) so they match the `/items` read shape. Fetches the
   * board once, then batch-hydrates in place. No-op if the list is empty
   * or the board can't be resolved.
   */
  async hydrateTitForBoard(boardId: string, items: BoardItem[]): Promise<void> {
    if (items.length === 0) return;
    const board = await this.boardRepository
      .findById(boardId)
      .catch(() => null);
    if (board) {
      await this.hydrateTitFields(items, board);
    }
  }

  /**
   * Attach TIT parent info to each item in-place: `parent_board_item_id`,
   * `parent_board_item_name`, `parent_board_item_created_at`. No-op for items
   * that have no TIT parent, or when the adapter isn't Postgres/Drizzle
   * (Mongo adapter doesn't expose `table_in_columns`).
   *
   * "Name" picks the parent board's primary text field by precedence:
   * isUniqueIdentifier → isIdentifier → first non-deprecated field.
   */
  async enrichWithParents(items: BoardItem[]): Promise<void> {
    if (items.length === 0) return;
    let drizzleDb: NodePgDatabase<typeof schema>;
    try {
      drizzleDb = this.getDrizzle();
    } catch {
      return;
    }

    const childIds = items
      .map((i) => i.id || i._id)
      .filter((id): id is string => Boolean(id));
    if (childIds.length === 0) return;

    const edges = await drizzleDb
      .select()
      .from(schema.tableInColumns)
      .where(inArray(schema.tableInColumns.child_board_item_id, childIds));
    if (edges.length === 0) return;

    // First edge wins if a child somehow has multiple parents.
    const childToParent = new Map<
      string,
      { parent_board_item_id: string; parent_board_id: string }
    >();
    for (const e of edges) {
      if (!childToParent.has(e.child_board_item_id)) {
        childToParent.set(e.child_board_item_id, {
          parent_board_item_id: e.parent_board_item_id,
          parent_board_id: e.parent_board_id,
        });
      }
    }

    const parentItemIds = [
      ...new Set(
        [...childToParent.values()].map((p) => p.parent_board_item_id),
      ),
    ];
    const parentBoardIds = [
      ...new Set([...childToParent.values()].map((p) => p.parent_board_id)),
    ];

    const [parentRows, parentBoards] = await Promise.all([
      drizzleDb
        .select()
        .from(schema.boardItems)
        .where(inArray(schema.boardItems.id, parentItemIds)),
      drizzleDb
        .select()
        .from(schema.boards)
        .where(inArray(schema.boards.id, parentBoardIds)),
    ]);

    const parentById = new Map(parentRows.map((p) => [p.id, p]));
    // BoardField data is dual-shape: code/types use camelCase + `id`, but
    // legacy data migrated from Mongo stores snake_case + `_id`. See
    // board.controller.ts:230 for the same dual-shape handling.
    const fieldId = (f: any): string | undefined => f?.id ?? f?._id;
    const isDeprecated = (f: any) =>
      Boolean(f?.isDeprecated ?? f?.is_deprecated);
    const isUniq = (f: any) =>
      Boolean(f?.isUniqueIdentifier ?? f?.is_unique_identifier);
    const isIdent = (f: any) => Boolean(f?.isIdentifier ?? f?.is_identifier);

    const nameFieldByBoard = new Map<string, string>();
    for (const b of parentBoards) {
      const fields = (b.fields || []) as Array<
        BoardField & Record<string, any>
      >;
      const picked =
        fields.find((f) => isUniq(f) && !isDeprecated(f) && fieldId(f)) ||
        fields.find((f) => isIdent(f) && !isDeprecated(f) && fieldId(f)) ||
        fields.find((f) => !isDeprecated(f) && fieldId(f));
      const id = picked ? fieldId(picked) : undefined;
      if (id) nameFieldByBoard.set(b.id, id);
    }

    for (const item of items) {
      const childId = item.id || item._id;
      if (!childId) continue;
      const ref = childToParent.get(childId);
      if (!ref) continue;
      const parent = parentById.get(ref.parent_board_item_id);
      if (!parent) continue;

      const nameFieldId = nameFieldByBoard.get(ref.parent_board_id);
      const name =
        nameFieldId && parent.fields
          ? (parent.fields as Record<string, any>)[nameFieldId]
          : null;

      (item as any).parent_board_item_id = parent.id;
      (item as any).parent_board_item_name = name ?? null;
      (item as any).parent_board_item_created_at = parent.created_at;
    }
  }

  /**
   * Get board items by filter (also hydrates TIT fields).
   */
  async getBoardItemsByFilter(
    boardId: string,
    filter: Record<string, any>,
    options: QueryOptions,
    ctx?: AssigneeHydrationContext,
  ): Promise<PaginatedResult<BoardItem>> {
    const result = await this.itemRepository.findByFilter(
      boardId,
      filter,
      options,
    );
    const board = await this.boardRepository
      .findById(boardId)
      .catch(() => null);
    if (board) {
      await this.hydrateTitFields(result.data, board);
      this.resolveSelectionLabels(result.data, board);
      await this.hydrateAssigneeFields(result.data, board, ctx);
    }
    return result;
  }

  /**
   * Get board item by contact ID
   */
  async getBoardItemByContactId(contactId: string): Promise<BoardItem | null> {
    return this.itemRepository.findByContactId(contactId);
  }

  /**
   * Create a new board item.
   *
   * If the payload has nested objects under any TIT field id, the inline data
   * is split off into separate child items (in the TIT's child board) plus
   * `table_in_columns` edges, and the parent's TIT field stores only id refs.
   * That whole splice runs in a single Drizzle transaction so a failure mid-
   * way (e.g. a bad ref, unique-constraint violation on a child) rolls back
   * the parent insert too.
   */
  async createBoardItem(
    data: CreateBoardItemDTO,
    ctx?: AssigneeHydrationContext,
  ): Promise<BoardItem> {
    const board = await this.boardRepository.findById(data.board_id);
    if (!board) {
      throw new NotFoundError(`Board ${data.board_id} not found`);
    }

    const validatedFields = await this.validateAndProcessFields(
      board,
      data.fields,
      "create",
    );
    await this.checkUniqueIdentifier(board, validatedFields);

    const split = this.splitInlineTitFields(board, validatedFields);
    const hasTit = split.refs.length > 0 || split.newChildItems.length > 0;

    let item: BoardItem;
    if (!hasTit) {
      item = await this.itemRepository.create({
        ...data,
        fields: validatedFields,
        organization_id: data.organization_id || board.organization_id,
        business_unit_id: data.business_unit_id || board.business_unit_id || "",
      });
    } else {
      const drizzleDb = this.getDrizzle();
      const parentId = crypto.randomUUID();
      const actor = data.created_by || "System";
      const now = new Date();

      const inserted = await drizzleDb.transaction(async (tx) => {
        const [parentRow] = await tx
          .insert(schema.boardItems)
          .values({
            id: parentId,
            business_unit_id:
              data.business_unit_id || board.business_unit_id || "",
            organization_id: data.organization_id || board.organization_id,
            board_id: data.board_id,
            created_by: actor,
            created_type: data.created_type || CreateType.MANUAL,
            fields: split.trimmedFields,
            related_board_item_id: data.related_board_item_id ?? null,
            related_board_item_list: data.related_board_item_list || [],
            conversation_ids: data.conversation_ids || [],
            logo_url: data.logo_url ?? null,
            created_at: now,
            updated_at: now,
          } as any)
          .returning();
        await this.writeTitEdges(
          tx,
          data.board_id,
          parentId,
          board,
          split,
          actor,
        );
        return parentRow;
      });
      item = {
        ...inserted,
        _id: inserted.id,
        id: inserted.id,
        board_item_id: inserted.id,
      } as BoardItem;
    }

    logger.info(`Board item created: ${item.id} in board ${data.board_id}`);

    if (board.type === BoardType.KNOWLEDGE_HUB) {
      aiService
        .updateBoardItemEmbedding([{ ...item, fields_data: board.fields }])
        .catch((err) => logger.error("Failed to update embedding:", err));
    }

    await this.publishApCrmEvents("create", item, board);

    // Match the read path: the response must expose selection labels, not the
    // stored option ids (publish already resolves on its own clone above).
    this.resolveSelectionLabels([item], board);
    await this.hydrateAssigneeFields([item], board, ctx);

    return item;
  }

  /**
   * Create multiple board items.
   *
   * If any item carries inline TIT data, the whole batch runs in a single
   * Drizzle transaction: parents + child items + edges all-or-nothing.
   * Parent ids are pre-allocated so children's `related_board_item_id` can be
   * stamped without a second pass.
   */
  async createMultipleBoardItems(
    boardId: string,
    items: CreateBoardItemDTO[],
    ctx?: AssigneeHydrationContext,
    opts?: {
      // When set, a single item that fails validation does NOT reject the whole
      // call. The offending item is dropped and an entry is pushed to
      // `opts.errors` instead, so the remaining valid items still get inserted.
      // Used by the CSV/Excel import paths where one bad row (e.g. a free-text
      // value that isn't a valid SingleSelection option) must not fail the
      // entire batch. Callers that omit this (e.g. POST /items/bulk) keep the
      // all-or-nothing behaviour and rely on the throw to return 400.
      skipInvalid?: boolean;
      errors?: { index: number; message: string }[];
    },
  ): Promise<BoardItem[]> {
    const board = await this.boardRepository.findById(boardId);
    if (!board) {
      throw new NotFoundError(`Board ${boardId} not found`);
    }

    const validationResults = await Promise.all(
      items.map(async (item, index) => {
        try {
          const validatedFields = await this.validateAndProcessFields(
            board,
            item.fields,
            "create",
          );
          return {
            ...item,
            board_id: boardId,
            fields: validatedFields,
            organization_id: item.organization_id || board.organization_id,
            business_unit_id:
              item.business_unit_id || board.business_unit_id || "",
          };
        } catch (err) {
          if (!opts?.skipInvalid) throw err;
          opts.errors?.push({ index, message: (err as Error).message });
          return null;
        }
      }),
    );
    const validatedItems = validationResults.filter(
      (it): it is NonNullable<typeof it> => it !== null,
    );

    // Nothing survived validation (or empty input) — skip the insert path.
    if (validatedItems.length === 0) {
      return [];
    }

    const uniqueField = board.fields.find((f) => f.isUniqueIdentifier);
    if (uniqueField) {
      const uniqueValues = validatedItems
        .map((item) => item.fields[uniqueField.id])
        .filter((v) => v !== null && v !== undefined);
      const duplicates = uniqueValues.filter(
        (val, index) => uniqueValues.indexOf(val) !== index,
      );
      if (duplicates.length > 0) {
        throw new ValidationError(
          `Duplicate unique identifiers in batch: ${duplicates.join(", ")}`,
        );
      }
    }

    // Pre-compute splits so we know whether the batch needs the tx path.
    const perItem = validatedItems.map((vi) => ({
      vi,
      parentId: crypto.randomUUID(),
      split: this.splitInlineTitFields(board, vi.fields),
    }));
    const anyTit = perItem.some(
      (p) => p.split.refs.length > 0 || p.split.newChildItems.length > 0,
    );

    if (!anyTit) {
      const createdItems =
        await this.itemRepository.createMultiple(validatedItems);
      logger.info(
        `${createdItems.length} board items created in board ${boardId}`,
      );
      for (const it of createdItems) {
        await this.publishApCrmEvents("create", it, board);
      }
      this.resolveSelectionLabels(createdItems, board);
      await this.hydrateAssigneeFields(createdItems, board, ctx);
      return createdItems;
    }

    const drizzleDb = this.getDrizzle();
    const now = new Date();

    const inserted = await drizzleDb.transaction(async (tx) => {
      const parentRows = perItem.map(({ vi, parentId, split }) => {
        const createdAt = vi.created_at ? new Date(vi.created_at as any) : now;
        const updatedAt = vi.updated_at
          ? new Date(vi.updated_at as any)
          : createdAt;
        return {
          id: parentId,
          business_unit_id: vi.business_unit_id,
          organization_id: vi.organization_id,
          board_id: vi.board_id,
          created_by: vi.created_by || "System",
          created_type: vi.created_type || CreateType.MANUAL,
          fields: split.trimmedFields,
          related_board_item_id: vi.related_board_item_id ?? null,
          related_board_item_list: vi.related_board_item_list || [],
          conversation_ids: vi.conversation_ids || [],
          logo_url: vi.logo_url ?? null,
          created_at: createdAt,
          updated_at: updatedAt,
        };
      });
      const insertedParents = await tx
        .insert(schema.boardItems)
        .values(parentRows as any)
        .returning();

      // writeTitEdges runs per-parent; the per-call cost is one validate-refs
      // SELECT + one bulk children insert + one bulk edges insert. For very
      // large batches we could fold them into single global inserts, but the
      // current shape keeps the function reusable and the queries small.
      for (const { parentId, split } of perItem) {
        await this.writeTitEdges(
          tx,
          boardId,
          parentId,
          board,
          split,
          perItem.find((p) => p.parentId === parentId)?.vi.created_by ||
            "System",
        );
      }
      return insertedParents;
    });

    const createdItems = inserted.map(
      (row) =>
        ({
          ...row,
          _id: row.id,
          id: row.id,
          board_item_id: row.id,
        }) as BoardItem,
    );
    logger.info(
      `${createdItems.length} board items created in board ${boardId} (with inline TIT split)`,
    );
    for (const it of createdItems) {
      await this.publishApCrmEvents("create", it, board);
    }
    this.resolveSelectionLabels(createdItems, board);
    await this.hydrateAssigneeFields(createdItems, board, ctx);
    return createdItems;
  }

  /**
   * Update board item.
   *
   * If the update payload touches a TIT field with inline objects, the
   * existing edges for that (parent, field) pair are dropped and rewritten
   * inside a Drizzle transaction. TIT fields NOT in the payload are left
   * untouched (partial-update semantics). Orphan child items from the dropped
   * edges are intentionally retained — see `rewriteTitEdges`.
   */
  async updateBoardItem(
    id: string,
    updates: UpdateBoardItemDTO,
    ctx?: AssigneeHydrationContext,
  ): Promise<BoardItem> {
    const existingItem = await this.getBoardItem(id, ctx);

    let item: BoardItem;
    if (!updates.fields) {
      item = await this.itemRepository.update(id, updates);
    } else {
      const board = await this.boardRepository.findById(existingItem.board_id);
      if (!board) {
        throw new NotFoundError(`Board ${existingItem.board_id} not found`);
      }

      // Validate/process ONLY the fields the caller actually sent. Untouched
      // fields are carried over verbatim from the existing item — we must NOT
      // re-validate them, otherwise a pre-existing bad value rejects every
      // future edit of the record. Concretely: the default sample rows seed
      // the placeholder string "default first option" into the MultipleSelection
      // Tags field, which fails validateMultiSelectOptions; before this change,
      // merging + re-validating that untouched value made the sample Contact
      // un-editable (400 "Field 'Tags': Invalid options selected"). This mirrors
      // the "anything goes for existing data" stance the per-type validation
      // TODO above already takes.
      const incomingValidated = await this.validateAndProcessFields(
        board,
        updates.fields,
        "update",
        id,
      );
      const validatedFields = { ...existingItem.fields, ...incomingValidated };
      await this.checkUniqueIdentifier(board, validatedFields, id);

      // Split only the fields the caller actually sent (so untouched TIT
      // fields keep their edges and stored ids).
      const split = this.splitInlineTitFields(board, incomingValidated);
      const titTouched = split.touchedFieldIds.length > 0;

      if (!titTouched) {
        item = await this.itemRepository.update(id, {
          ...updates,
          fields: validatedFields,
        });
      } else {
        const drizzleDb = this.getDrizzle();
        const actor = (existingItem.created_by as string) || "System";
        const now = new Date();
        // Re-merge with split.trimmedFields so TIT fields end up as id arrays.
        const finalFields = { ...validatedFields, ...split.trimmedFields };

        const updated = await drizzleDb.transaction(async (tx) => {
          const [parentRow] = await tx
            .update(schema.boardItems)
            .set({
              fields: finalFields,
              ...(updates.related_board_item_id !== undefined && {
                related_board_item_id: updates.related_board_item_id,
              }),
              ...(updates.related_board_item_list !== undefined && {
                related_board_item_list: updates.related_board_item_list,
              }),
              ...(updates.conversation_ids !== undefined && {
                conversation_ids: updates.conversation_ids,
              }),
              ...(updates.logo_url !== undefined && {
                logo_url: updates.logo_url,
              }),
              updated_at: now,
            })
            .where(
              and(
                eq(schema.boardItems.id, id),
                eq(schema.boardItems.board_id, existingItem.board_id),
              ),
            )
            .returning();
          if (!parentRow) {
            throw new NotFoundError(`Board item ${id} not found`);
          }
          await this.rewriteTitEdges(
            tx,
            existingItem.board_id,
            id,
            board,
            split,
            actor,
          );
          return parentRow;
        });
        item = {
          ...updated,
          _id: updated.id,
          id: updated.id,
          board_item_id: updated.id,
        } as BoardItem;
      }
    }
    logger.info(`Board item updated: ${id}`);

    const boardForEmbedding = await this.boardRepository
      .findById(existingItem.board_id)
      .catch(() => null);
    if (
      boardForEmbedding &&
      boardForEmbedding.type === BoardType.KNOWLEDGE_HUB
    ) {
      aiService
        .updateBoardItemEmbedding([
          { ...item, fields_data: boardForEmbedding.fields },
        ])
        .catch((err) => logger.error("Failed to update embedding:", err));
    }

    const touchedKeys = updates.fields ? Object.keys(updates.fields) : [];
    const updateData = this.buildUpdateData(
      boardForEmbedding,
      existingItem.fields,
      item.fields,
      touchedKeys,
    );
    await this.publishApCrmEvents(
      "update",
      item,
      boardForEmbedding,
      updateData,
    );

    // Match the read path: the response must expose selection labels, not the
    // stored option ids (publish already resolves on its own clone above).
    if (boardForEmbedding) {
      this.resolveSelectionLabels([item], boardForEmbedding);
      await this.hydrateAssigneeFields([item], boardForEmbedding, ctx);
    }

    return item;
  }

  /**
   * Update multiple board items
   */
  async updateMultipleBoardItems(
    ids: string[],
    updates: Record<string, any>,
  ): Promise<number> {
    // Validate that all items exist and belong to same board
    if (ids.length === 0) {
      throw new ValidationError("No item IDs provided");
    }

    const items = await Promise.all(ids.map((id) => this.getBoardItem(id)));
    const boardIds = new Set(items.map((item) => item.board_id));
    if (boardIds.size > 1) {
      throw new ValidationError(
        "Cannot bulk update items from different boards",
      );
    }

    const count = await this.itemRepository.updateMultiple(ids, updates);
    logger.info(`${count} board items updated`);

    const board = await this.boardRepository
      .findById(items[0].board_id)
      .catch(() => null);
    const touchedKeys = updates?.fields ? Object.keys(updates.fields) : [];
    for (const oldItem of items) {
      const newFields = updates?.fields
        ? { ...oldItem.fields, ...updates.fields }
        : oldItem.fields;
      const mergedItem = {
        ...oldItem,
        ...updates,
        fields: newFields,
      } as BoardItem;
      const updateData = this.buildUpdateData(
        board,
        oldItem.fields,
        newFields,
        touchedKeys,
      );
      await this.publishApCrmEvents("update", mergedItem, board, updateData);
    }

    return count;
  }

  /**
   * Update board items by filter
   */
  async updateBoardItemsByFilter(
    boardId: string,
    filter: Record<string, any>,
    updates: Record<string, any>,
  ): Promise<number> {
    const affectedPage = await this.itemRepository
      .findByFilter(boardId, filter, { skip: 0, limit: 10000 })
      .catch(() => ({ data: [] as BoardItem[] }) as any);
    const affectedItems: BoardItem[] = affectedPage?.data ?? [];

    const count = await this.itemRepository.updateByFilter(
      boardId,
      filter,
      updates,
    );
    logger.info(`Updated board items by filter in board ${boardId}`);

    if (affectedItems.length > 0) {
      const board = await this.boardRepository
        .findById(boardId)
        .catch(() => null);
      const touchedKeys = updates?.fields ? Object.keys(updates.fields) : [];
      for (const oldItem of affectedItems) {
        const newFields = updates?.fields
          ? { ...oldItem.fields, ...updates.fields }
          : oldItem.fields;
        const mergedItem = {
          ...oldItem,
          ...updates,
          fields: newFields,
        } as BoardItem;
        const updateData = this.buildUpdateData(
          board,
          oldItem.fields,
          newFields,
          touchedKeys,
        );
        await this.publishApCrmEvents("update", mergedItem, board, updateData);
      }
    }

    return count;
  }

  /**
   * Delete board item.
   *
   * When the storage is Postgres/Drizzle, this also cascades into the
   * TIT tree: every child item the parent referenced via `table_in_columns`
   * gets removed too, recursively, unless another parent still references it.
   * Falls back to the legacy single-row delete on the Mongo adapter
   * (no edges table there).
   */
  async deleteBoardItem(id: string): Promise<void> {
    const boardItem = await this.getBoardItem(id);
    const board = await this.boardRepository
      .findById(boardItem.board_id)
      .catch(() => null);

    const drizzleDb = this.tryGetDrizzle();
    if (drizzleDb) {
      await drizzleDb.transaction(async (tx) => {
        await this.cascadeDeleteWithTit(tx, [id]);
      });
    } else {
      await this.itemRepository.delete(id);
    }
    logger.info(`Board item deleted: ${id}`);

    await this.publishApCrmEvents("delete", boardItem, board);
  }

  /**
   * Delete multiple board items (TIT-cascading on Postgres).
   */
  async deleteMultipleBoardItems(ids: string[]): Promise<number> {
    const items = await Promise.all(ids.map((id) => this.getBoardItem(id)));

    const drizzleDb = this.tryGetDrizzle();
    let count: number;
    if (drizzleDb) {
      await drizzleDb.transaction(async (tx) => {
        await this.cascadeDeleteWithTit(tx, ids);
      });
      count = ids.length;
    } else {
      count = await this.itemRepository.deleteMultiple(ids);
    }
    logger.info(`${count} board items deleted`);

    const boardByIdCache = new Map<string, Board | null>();
    for (const it of items) {
      let board = boardByIdCache.get(it.board_id);
      if (board === undefined) {
        board = await this.boardRepository
          .findById(it.board_id)
          .catch(() => null);
        boardByIdCache.set(it.board_id, board);
      }
      await this.publishApCrmEvents("delete", it, board);
    }

    return count;
  }

  /**
   * Delete board items by filter (TIT-cascading on Postgres).
   */
  async deleteBoardItemsByFilter(
    boardId: string,
    filter: Record<string, any>,
  ): Promise<number> {
    const affectedPage = await this.itemRepository
      .findByFilter(boardId, filter, { skip: 0, limit: 10000 })
      .catch(() => ({ data: [] as BoardItem[] }) as any);
    const affectedItems: BoardItem[] = affectedPage?.data ?? [];

    const drizzleDb = this.tryGetDrizzle();
    let count: number;
    if (drizzleDb && affectedItems.length > 0) {
      const ids = affectedItems
        .map((it) => it.id || it._id)
        .filter((x): x is string => Boolean(x));
      await drizzleDb.transaction(async (tx) => {
        await this.cascadeDeleteWithTit(tx, ids);
      });
      count = ids.length;
    } else {
      count = await this.itemRepository.deleteByFilter(boardId, filter);
    }
    logger.info(`Deleted board items by filter in board ${boardId}`);

    if (affectedItems.length > 0) {
      const board = await this.boardRepository
        .findById(boardId)
        .catch(() => null);
      for (const it of affectedItems) {
        await this.publishApCrmEvents("delete", it, board);
      }
    }

    return count;
  }

  /** Non-throwing variant of `getDrizzle` for adapters where TIT cascading
   *  simply isn't applicable (Mongo). Returns null instead of throwing. */
  private tryGetDrizzle(): NodePgDatabase<typeof schema> | null {
    const raw = this.db.getRawClient?.();
    if (!raw || typeof (raw as any).transaction !== "function") return null;
    return raw as NodePgDatabase<typeof schema>;
  }

  /**
   * BFS-cascade delete a set of board items along with their TIT subtree.
   *
   * For every layer of ids being removed: (1) collect the child ids referenced
   * via `table_in_columns` (these are the next-layer candidates), (2) drop all
   * edges touching the layer — both directions, so the layer can't dangle as a
   * parent or as a child of some unrelated parent, (3) compute which child
   * candidates are now orphans (no remaining edge references them) and queue
   * them for the next layer. Finally, bulk-delete every collected board_item
   * row in one statement.
   *
   * Why both directions in step 2: if item X was someone else's TIT child,
   * deleting X without dropping that edge leaves a dangling reference in the
   * other parent's `fields[tit]` id list. Hydrate already skips missing
   * children silently, so the list itself is fine to leave alone — but the
   * edge row must go to avoid FK weirdness if a constraint is ever added.
   */
  private async cascadeDeleteWithTit(
    tx: NodePgDatabase<typeof schema>,
    initialIds: string[],
  ): Promise<void> {
    if (initialIds.length === 0) return;

    const allDeleted = new Set<string>();
    let frontier = Array.from(new Set(initialIds));

    while (frontier.length > 0) {
      frontier = frontier.filter((id) => !allDeleted.has(id));
      if (frontier.length === 0) break;
      for (const id of frontier) allDeleted.add(id);

      const childEdges = await tx
        .select({ childId: schema.tableInColumns.child_board_item_id })
        .from(schema.tableInColumns)
        .where(inArray(schema.tableInColumns.parent_board_item_id, frontier));
      const childIds = Array.from(new Set(childEdges.map((e) => e.childId)));

      await tx
        .delete(schema.tableInColumns)
        .where(inArray(schema.tableInColumns.parent_board_item_id, frontier));
      await tx
        .delete(schema.tableInColumns)
        .where(inArray(schema.tableInColumns.child_board_item_id, frontier));

      const nextFrontier: string[] = [];
      if (childIds.length > 0) {
        const stillReferenced = await tx
          .select({ childId: schema.tableInColumns.child_board_item_id })
          .from(schema.tableInColumns)
          .where(inArray(schema.tableInColumns.child_board_item_id, childIds));
        const referenced = new Set(stillReferenced.map((r) => r.childId));
        for (const id of childIds) {
          if (!referenced.has(id) && !allDeleted.has(id)) {
            nextFrontier.push(id);
          }
        }
      }
      frontier = nextFrontier;
    }

    const allIds = Array.from(allDeleted);
    if (allIds.length > 0) {
      await tx
        .delete(schema.boardItems)
        .where(inArray(schema.boardItems.id, allIds));
      logger.info(
        `cascadeDeleteWithTit: removed ${allIds.length} item(s) total (initial=${initialIds.length}, cascaded=${allIds.length - initialIds.length})`,
      );
    }
  }

  /**
   * Link related board items
   */
  async linkRelatedItems(
    itemId: string,
    relatedBoardId: string,
    relatedItemIds: string[],
  ): Promise<void> {
    // Validate items exist
    await this.getBoardItem(itemId);
    await Promise.all(relatedItemIds.map((id) => this.getBoardItem(id)));

    await this.itemRepository.linkRelatedItems(
      itemId,
      relatedBoardId,
      relatedItemIds,
    );
    logger.info(`Linked ${relatedItemIds.length} items to ${itemId}`);
  }

  /**
   * Unlink related board items
   */
  async unlinkRelatedItems(
    itemId: string,
    relatedBoardId: string,
    relatedItemIds: string[],
  ): Promise<void> {
    await this.itemRepository.unlinkRelatedItems(
      itemId,
      relatedBoardId,
      relatedItemIds,
    );
    logger.info(`Unlinked ${relatedItemIds.length} items from ${itemId}`);
  }

  /**
   * Get related board items
   */
  async getRelatedItems(
    itemId: string,
    relatedBoardId: string,
  ): Promise<BoardItem[]> {
    return this.itemRepository.getRelatedItems(itemId, relatedBoardId);
  }

  /**
   * Get related board items with link/name/skip/limit, mirroring the legacy
   * monolith `getRelatedBoardItemList` (backend/src/controllers/board.js).
   *
   * A link between item A and item B is bidirectional: it exists if A's
   * `related_board_item_list` contains B's id, OR B's list contains A's id.
   *
   * - `link=true`  → items in `relatedBoardId` that ARE linked to `itemId`.
   * - `link=false` → CANDIDATE items in `relatedBoardId` that are NOT linked
   *   to `itemId` in either direction (used by the "Add Existing" picker).
   *
   * `name` filters by the related board's identifier field (case-insensitive
   * regex on the `fields.<id>` JSONB value), or by exact id when prefixed
   * `bi_`. Postgres-only (Drizzle); throws ValidationError on Mongo adapters.
   */
  async getRelatedItemsPaginated(
    itemId: string,
    relatedBoardId: string,
    opts: { link: boolean; name?: string; skip?: number; limit?: number },
  ): Promise<{
    data: BoardItem[];
    count: number;
    total: number;
    has_more: boolean;
  }> {
    const { link, name } = opts;
    const skip = Math.max(0, opts.skip ?? 0);
    const limit = Math.max(0, opts.limit ?? 20);

    const item = await this.itemRepository.findById(itemId);
    if (!item) {
      throw new NotFoundError(`Board item ${itemId} not found`);
    }

    const relatedBoard = await this.boardRepository
      .findById(relatedBoardId)
      .catch(() => null);
    if (!relatedBoard) {
      throw new NotFoundError(`Board ${relatedBoardId} not found`);
    }

    const drizzleDb = this.getDrizzle();
    const bi = schema.boardItems;

    // Forward link: this item references the candidate.
    // `related_board_item_list` is a JSONB array of id strings.
    const forwardLinked =
      (item.related_board_item_list?.length ?? 0) > 0
        ? sql`${bi.id} = ANY(ARRAY[${sql.join(
            item.related_board_item_list.map((id) => sql`${id}`),
            sql`, `,
          )}])`
        : sql`false`;

    // Reverse link: the candidate references this item.
    const reverseLinked = sql`${bi.related_board_item_list} @> ${JSON.stringify(
      [itemId],
    )}::jsonb`;

    const linkedCond = sql`(${forwardLinked} OR ${reverseLinked})`;
    const conditions = [
      eq(bi.board_id, relatedBoardId),
      link ? linkedCond : sql`NOT ${linkedCond}`,
    ];

    // Name / id filter on the related board's identifier field.
    if (name) {
      if (name.startsWith("bi_")) {
        conditions.push(eq(bi.id, name));
      } else {
        const fieldId = (f: any): string | undefined => f?.id ?? f?._id;
        const isDeprecated = (f: any) =>
          Boolean(f?.isDeprecated ?? f?.is_deprecated);
        const isUniq = (f: any) =>
          Boolean(f?.isUniqueIdentifier ?? f?.is_unique_identifier);
        const isIdent = (f: any) =>
          Boolean(f?.isIdentifier ?? f?.is_identifier);
        const fields = (relatedBoard.fields || []) as Array<
          BoardField & Record<string, any>
        >;
        const picked =
          fields.find((f) => isUniq(f) && !isDeprecated(f) && fieldId(f)) ||
          fields.find((f) => isIdent(f) && !isDeprecated(f) && fieldId(f)) ||
          fields.find((f) => !isDeprecated(f) && fieldId(f));
        const idFieldId = picked ? fieldId(picked) : undefined;
        if (idFieldId) {
          // Case-insensitive substring match. `~*` is a POSIX regex, so escape
          // regex metacharacters in the user term (the legacy monolith wrapped
          // the raw term with escapeRegExp before building its RegExp).
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          conditions.push(sql`${bi.fields}->>${idFieldId} ~* ${escaped}`);
        }
      }
    }

    const whereCond = and(...conditions);

    const countRows = await drizzleDb
      .select({ count: sql<number>`count(*)::int` })
      .from(bi)
      .where(whereCond);
    const total = countRows[0]?.count ?? 0;

    let rowsQuery = drizzleDb
      .select()
      .from(bi)
      .where(whereCond)
      .orderBy(sql`${bi.created_at} DESC`)
      .offset(skip) as any;
    if (limit > 0) rowsQuery = rowsQuery.limit(limit);
    const rows = await rowsQuery;

    const data = (rows as any[]).map((r) => this.itemRepository.toEntity(r));

    return {
      data,
      count: data.length,
      total,
      has_more: skip + data.length < total,
    };
  }

  /**
   * Count board items
   */
  async count(boardId: string, filter?: Record<string, any>): Promise<number> {
    return this.itemRepository.count(boardId, filter);
  }

  /**
   * Check if board item exists
   */
  async exists(id: string): Promise<boolean> {
    return this.itemRepository.exists(id);
  }

  /**
   * Dispatch AP workflows directly from data_board. Mirrors IPS's
   * CRMIncomingMessageController dispatch logic so we can run both code
   * paths during cut-over, then drop the IPS round-trip. Looks up the local
   * crmboards table (migrated from IPS) for automations that match the
   * (board, type[, field]) tuple, skips paused rows, then publishes one
   * AP_OUTGOING_CRM_EVENT per non-numeric workflow_id.
   *
   * Non-blocking: any failure is logged and does not affect the HTTP
   * response or the legacy IPS publish.
   */
  private async publishApCrmEvents(
    type: CrmEventType,
    boardItem: BoardItem,
    board: Board | null,
    updateData?: Record<string, any>,
  ): Promise<void> {
    if (!config.kafka.enabled) {
      logger.info(
        `[kafka:${AP_CRM_EVENT_TOPIC}] skipped (kafka disabled) type=${type}`,
      );
      return;
    }
    const boardId = boardItem.board_id;
    const boardItemId = (boardItem as any).id || (boardItem as any)._id;
    let candidatesFound = 0;
    let pausedSkipped = 0;
    let nonApSkipped = 0;
    let published = 0;

    try {
      const repo = new CRMBoardRepository(this.db);

      if (type === "update") {
        // One AP event per touched field: each field can have its own
        // automation (matched by field_id). Mirrors IPS update loop.
        const fieldIds = updateData ? Object.keys(updateData) : [];
        for (const fieldId of fieldIds) {
          const rows = await repo.findByBoardIdTypeAndFieldId(
            boardId,
            "update",
            fieldId,
          );
          candidatesFound += rows.length;
          for (const r of rows) {
            if (r.is_paused) {
              pausedSkipped++;
              continue;
            }
            if (!isApWorkflowId(r.workflow_id)) {
              nonApSkipped++;
              continue;
            }
            await this.publishOneApCrmEvent(
              type,
              boardItem,
              board,
              r,
              updateData ? updateData[fieldId] : undefined,
            );
            published++;
          }
        }
      } else {
        const candidates = await repo.findByBoardIdAndType(boardId, type);
        candidatesFound = candidates.length;
        for (const r of candidates) {
          if (r.is_paused) {
            pausedSkipped++;
            continue;
          }
          if (!isApWorkflowId(r.workflow_id)) {
            nonApSkipped++;
            continue;
          }
          await this.publishOneApCrmEvent(type, boardItem, board, r);
          published++;
        }
      }

      // Always emit a summary so an operator can tell apart "no AP event
      // because no CRMBoard row matched" from "no AP event because Kafka
      // never ran". The detailed publish lines (publishOneApCrmEvent) still
      // log each successful publish individually.
      logger.info(
        `[kafka:${AP_CRM_EVENT_TOPIC}] dispatch summary type=${type} board_id=${boardId} board_item_id=${boardItemId} candidates=${candidatesFound} published=${published} paused_skipped=${pausedSkipped} non_ap_skipped=${nonApSkipped}`,
      );
    } catch (err) {
      // Catches both "table missing" (relation does not exist) and any
      // other repo/PG fault. We log loudly and swallow — a failure here
      // must not break the board-item HTTP response, even though it
      // means the matching AP workflow won't fire for this op. Operators
      // alert on `table_missing=true` lines from this log.
      const msg = (err as Error).message || String(err);
      const tableMissing =
        /relation .* does not exist/i.test(msg) ||
        /Table .* not found in Drizzle schema map/i.test(msg);
      logger.error(
        `[kafka:${AP_CRM_EVENT_TOPIC}] AP dispatch failed type=${type} board_id=${boardId} board_item_id=${boardItemId} table_missing=${tableMissing} candidates_seen=${candidatesFound}: ${msg}`,
      );
    }
  }

  /**
   * Publish a single AP_OUTGOING_CRM_EVENT. Only emits when the matched
   * CRMBoard's workflow_id is non-numeric (i.e. a Workflow flow ID);
   * numeric workflow_ids are IPS-internal and still handled by IPS.
   */
  private async publishOneApCrmEvent(
    type: CrmEventType,
    boardItem: BoardItem,
    board: Board | null,
    crmboard: CRMBoard,
    perFieldUpdate?: any,
  ): Promise<void> {
    if (!isApWorkflowId(crmboard.workflow_id)) {
      logger.info(
        `[kafka:${AP_CRM_EVENT_TOPIC}] skip non-AP workflow workflow_id=${crmboard.workflow_id} crmboard_id=${crmboard.id}`,
      );
      return;
    }

    const resolvedFields = this.cloneFieldsWithResolvedLabels(
      boardItem.fields,
      board,
    );
    const publishedItem =
      resolvedFields === boardItem.fields
        ? boardItem
        : ({ ...boardItem, fields: resolvedFields } as BoardItem);
    const message: Record<string, any> = {
      board_item: publishedItem,
      board,
      type,
      workflow_id: crmboard.workflow_id,
    };
    if (perFieldUpdate) message.updateData = perFieldUpdate;

    const partition = 0;
    const boardItemId = (boardItem as any).id || (boardItem as any)._id;

    logger.info(
      `[kafka:${AP_CRM_EVENT_TOPIC}] publishing AP CRM event type=${type} board_id=${boardItem.board_id} board_item_id=${boardItemId} workflow_id=${crmboard.workflow_id} crmboard_id=${crmboard.id} partition=${partition}`,
      {
        topic: AP_CRM_EVENT_TOPIC,
        partition,
        type,
        board_id: boardItem.board_id,
        board_item_id: boardItemId,
        workflow_id: crmboard.workflow_id,
        crmboard_id: crmboard.id,
        organization_id: (boardItem as any).organization_id,
        is_paused: crmboard.is_paused,
      },
    );

    try {
      await KafkaAutomation.getInstance().publish(
        AP_CRM_EVENT_TOPIC,
        message,
        partition,
      );
      logger.info(
        `[kafka:${AP_CRM_EVENT_TOPIC}] publish ok type=${type} workflow_id=${crmboard.workflow_id} board_item_id=${boardItemId}`,
      );
    } catch (err) {
      logger.error(
        `[kafka:${AP_CRM_EVENT_TOPIC}] publish failed type=${type} workflow_id=${crmboard.workflow_id}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Build the per-field diff that backend attaches to 'update' events.
   * Shape mirrors backend (src/controllers/board.js:~4300): each entry is keyed
   * by boardField.id and carries fieldID/fieldName/oldData/newData.
   */
  private buildUpdateData(
    board: Board | null,
    oldFields: Record<string, any> | undefined,
    newFields: Record<string, any> | undefined,
    touchedKeys: string[],
  ): Record<string, any> | undefined {
    if (!board || touchedKeys.length === 0) return undefined;
    const fieldById = new Map(board.fields.map((f) => [f.id, f]));
    const idToLabelByField = this.buildSelectionLabelMap(board);
    const resolveValue = (fieldId: string, v: any): any => {
      const map = idToLabelByField.get(fieldId);
      if (!map || v == null) return v;
      if (typeof v === "string") return map.has(v) ? map.get(v) : v;
      if (Array.isArray(v)) {
        return v.map((el) =>
          typeof el === "string" && map.has(el) ? map.get(el) : el,
        );
      }
      return v;
    };
    const updateData: Record<string, any> = {};
    for (const key of touchedKeys) {
      const bf = fieldById.get(key);
      if (!bf) continue;
      updateData[key] = {
        fieldID: bf.id,
        fieldName: (bf as any).name,
        oldData: { value: resolveValue(key, oldFields?.[key]) },
        newData: { value: resolveValue(key, newFields?.[key]) },
      };
    }
    return Object.keys(updateData).length > 0 ? updateData : undefined;
  }

  /**
   * Validate and process field values
   */
  private async validateAndProcessFields(
    board: Board,
    fields: Record<string, any>,
    operation: "create" | "update",
    itemId?: string,
  ): Promise<Record<string, any>> {
    const processedFields: Record<string, any> = {};

    // Validate each field against board schema
    for (const boardField of board.fields) {
      const bf = boardField as BoardField & Record<string, any>;
      // BoardField is dual-shape: code/types use camelCase + `id`, legacy
      // Mongo-migrated boards store snake_case + `_id`. See
      // enrichWithParents above for the same handling.
      const fieldId = bf.id ?? bf._id;
      const fieldValue = fields[fieldId];

      // Required only for the primary record identifier (the "Name"
      // column). `isDefault` just marks the board template's default
      // columns — it must NOT imply required, otherwise every default
      // field (22 on a CRM board) becomes mandatory on create.
      const isIdentifierField = Boolean(bf.isIdentifier ?? bf.is_identifier);
      if (operation === "create" && isIdentifierField) {
        if (!validateRequired(fieldValue)) {
          throw new ValidationError(`Field '${boardField.name}' is required`);
        }
      }

      // Skip validation if field not provided in update
      if (
        operation === "update" &&
        (fieldValue === undefined || fieldValue === null)
      ) {
        continue;
      }

      // TODO: re-enable per-type value validation once existing data is
      // backfilled. The switch in `validateFieldValue` was broken (enum
      // mismatch) and used to silently pass everything; turning it on now
      // would reject older items with malformed Email/Phone/URL/Date/Time/
      // Number/Currency values on update. Keep the call commented to preserve
      // the previous "anything goes" behaviour for board items.
      //
      // const validation = validateFieldValue(boardField.type, fieldValue);
      // if (!validation.valid) {
      //   throw new ValidationError(
      //     `Field '${boardField.name}': ${validation.error}`,
      //   );
      // }

      // Type-specific validation
      if (boardField.type === BoardFieldType.SINGLE_SELECTION && fieldValue) {
        if (
          boardField.data &&
          !validateSelectOption(fieldValue, boardField.data)
        ) {
          throw new ValidationError(
            `Field '${boardField.name}': Invalid option selected`,
          );
        }
      }

      if (boardField.type === BoardFieldType.MULTI_SELECTION && fieldValue) {
        if (
          boardField.data &&
          !validateMultiSelectOptions(fieldValue, boardField.data)
        ) {
          throw new ValidationError(
            `Field '${boardField.name}': Invalid options selected`,
          );
        }
      }

      // Process and sanitize values
      processedFields[fieldId] = this.processFieldValue(boardField, fieldValue);
    }

    // Allow extra fields not in schema (for flexibility)
    // They will be stored but not validated
    for (const [key, value] of Object.entries(fields)) {
      if (processedFields[key] === undefined) {
        processedFields[key] = value;
      }
    }

    return processedFields;
  }

  /**
   * Process field value based on type
   */
  private processFieldValue(field: BoardField, value: any): any {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    switch (field.type) {
      case BoardFieldType.SHORT_TEXT:
      case BoardFieldType.LONG_TEXT:
      case BoardFieldType.NOTES:
        return sanitizeText(String(value));

      case BoardFieldType.EMAIL:
        return String(value).toLowerCase().trim();

      case BoardFieldType.PHONE: {
        // Phone fields are stored as a rich object:
        //   { phone, country_code, national_number, country_calling_code,
        //     calling_code_with_number }
        // The webapp and the AP automate-data-board piece send this object,
        // and search matches on `.calling_code_with_number`. Running it through
        // String() gives "[object Object]", which formatPhoneNumber then strips
        // of all non-digits and returns as "+" — that is how a saved number
        // turned into "+". Preserve the object as-is; only string-format the
        // legacy bare-string shape.
        if (typeof value === "object" && !Array.isArray(value)) {
          return value;
        }
        const countryCode = field.settings?.countryCode;
        return formatPhoneNumber(String(value), countryCode);
      }

      case BoardFieldType.NUMBER:
        return parseFloat(value);

      case BoardFieldType.COUNTRY: {
        // Legacy shape (backend/src/controllers/board.js:1833-1840):
        // { country_code, country_name }. FE typically sends the code as a
        // string ("AT"); legacy expanded via countries-and-timezones.
        if (value === null || value === undefined || value === "") return null;
        if (typeof value === "object" && !Array.isArray(value)) {
          const v = value as { country_code?: string; country_name?: string };
          const code = v.country_code;
          if (!code) return null;
          const name =
            v.country_name ??
            countriesAndTimezones.getCountry(code)?.name ??
            null;
          return { country_code: code, country_name: name };
        }
        const code = String(value);
        const name = countriesAndTimezones.getCountry(code)?.name ?? null;
        return { country_code: code, country_name: name };
      }

      case BoardFieldType.CURRENCY: {
        // Legacy shape (backend/src/controllers/board.js:1962): object with
        // { amounts, currency_code }. The FE may also send just
        // { currency_code } (user picked a currency before entering an
        // amount), or a bare number (legacy import). Normalise to the
        // object shape so reads stay consistent.
        if (typeof value === "object" && !Array.isArray(value)) {
          const v = value as { amounts?: unknown; currency_code?: unknown };
          const out: Record<string, unknown> = { ...v };
          if (v.amounts !== undefined && v.amounts !== null) {
            const n = +(v.amounts as any);
            if (isNaN(n)) return null;
            out.amounts = n;
          }
          if (out.amounts === undefined && !out.currency_code) return null;
          return out;
        }
        const n = +value;
        if (isNaN(n)) return null;
        return {
          amounts: n,
          currency_code: (field.settings as any)?.default_currency_code ?? null,
        };
      }

      case BoardFieldType.CHECKBOX:
        return value === true || value === "true";

      case BoardFieldType.DATE:
      case BoardFieldType.DATETIME:
        // Store as ISO string
        return new Date(value).toISOString();

      case BoardFieldType.LINK:
        return String(value).trim();

      case BoardFieldType.ATTACHMENT: {
        // Canonical shape (legacy handleFieldTypeValue,
        // backend/src/controllers/board.js:3105-3158): an array of
        // { type: "url" | "file", data: { name, url, key, … } }. CSV import
        // hands us a bare URL string (or ";"-separated URLs); the normal UI
        // upload flow already sends the structured array. Normalise both into
        // the array shape so the FE always renders consistently.
        const deriveName = (url: string) =>
          (url.includes("/") ? url.split("/").pop()! : url) || url;
        const deriveExt = (name: string) => {
          const m = name.match(/\.([A-Za-z0-9]{1,8})(?:[?#].*)?$/);
          return m ? m[1].toLowerCase() : undefined;
        };
        const makeUrlAttachment = (rawUrl: string) => {
          const url = rawUrl.trim();
          if (!url) return null;
          const name = deriveName(url);
          const ext = deriveExt(name);
          return {
            type: "url",
            data: {
              name,
              url,
              key: url,
              uploader: null,
              user_id: null,
              uploadDate: new Date().toISOString(),
              ...(ext ? { extension: ext } : {}),
            },
          };
        };
        // Flat upload-endpoint shape ({ name, url, key, … } with no
        // type/data wrapper) → wrap as one "file" attachment, preserving
        // any metadata present.
        const makeFileAttachment = (o: any) => {
          if (!o || typeof o.url !== "string") return null;
          return {
            type: "file",
            data: {
              name: o.name ?? deriveName(o.url),
              url: o.url,
              key: o.key ?? o.name ?? deriveName(o.url),
              uploader: o.uploader ?? null,
              user_id: o.user_id ?? null,
              uploadDate: o.uploadDate ?? new Date().toISOString(),
              ...(o.extension ? { extension: o.extension } : {}),
              ...(o.sizeInBytes ? { sizeInBytes: o.sizeInBytes } : {}),
            },
          };
        };
        // Normalise a single array entry without dropping data: keep
        // already-valid { type, data:{url} } objects as-is, wrap flat upload
        // objects, wrap bare URL strings.
        const normalizeEntry = (a: any) => {
          if (typeof a === "string") return makeUrlAttachment(a);
          if (a && ["file", "url"].includes(a.type) && a?.data?.url) return a;
          if (a && typeof a.url === "string") return makeFileAttachment(a);
          return null;
        };

        // Already-an-array (normal UI write, or a list of URLs/upload objects).
        if (Array.isArray(value)) {
          const normalized = value.map(normalizeEntry).filter(Boolean);
          return normalized.length > 0 ? normalized : null;
        }
        // Single upload-shaped object → wrap as one file attachment.
        if (
          typeof value === "object" &&
          value !== null &&
          typeof value.url === "string"
        ) {
          return [makeFileAttachment(value)];
        }
        // String (CSV import) → one or more url attachments.
        if (typeof value === "string") {
          const attachments = value
            .split(/[;\n]/)
            .map(makeUrlAttachment)
            .filter(Boolean);
          return attachments.length > 0 ? attachments : null;
        }
        return null;
      }

      case BoardFieldType.TABLE_IN_TABLE: {
        // Inline-JSON CSV format (sandbox exporter inlines child rows as a
        // JSON array keyed by child-field name) is the cross-env contract.
        // splitTitFields' object-entry branch (board-item.service.ts ~1517)
        // creates new child items from each object — name→id translation is
        // done later there with the child board schema in hand.
        if (Array.isArray(value)) return value;
        if (typeof value === "string") {
          const trimmed = value.trim();
          if (trimmed.startsWith("[")) {
            try {
              const parsed = JSON.parse(trimmed);
              if (Array.isArray(parsed)) return parsed;
            } catch {
              // Malformed JSON falls through to "drop column to []" so the
              // parent row still imports; the bad TIT data is just lost.
            }
          }
          return [];
        }
        return [];
      }

      default:
        return value;
    }
  }

  /**
   * Check unique identifier constraint
   */
  private async checkUniqueIdentifier(
    board: Board,
    fields: Record<string, any>,
    excludeItemId?: string,
  ): Promise<void> {
    const uniqueField = board.fields.find((f) => f.isUniqueIdentifier);
    if (!uniqueField) return;

    const uniqueValue = fields[uniqueField.id];
    if (!uniqueValue) return;

    // Check if value already exists. Field values live in the `fields` JSONB
    // column, so the filter must be keyed `fields.<id>` — a bare field id is not
    // a real column and the Drizzle adapter silently drops it (matching every
    // row on the board and producing a false-positive conflict).
    const filter: Record<string, any> = {};
    filter[`fields.${uniqueField.id}`] = uniqueValue;

    const existingItems = await this.itemRepository.findByFilter(
      board.id!,
      filter,
      { skip: 0, limit: 1 },
    );

    if (existingItems.data.length > 0) {
      const existingItem = existingItems.data[0];
      // Allow updating same item
      if (!excludeItemId || existingItem.id !== excludeItemId) {
        throw new ConflictError(
          `Value '${uniqueValue}' already exists for unique field '${uniqueField.name}'`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // TableInTable (TIT) splitting — port of legacy Mongo behavior.
  //
  // When a parent payload includes nested objects under a TIT field id, those
  // objects belong in the child board, not inline on the parent. These helpers
  // split inline data into (a) parent fields stripped to id arrays, (b) new
  // child item rows to insert, (c) `table_in_columns` edges to write.
  //
  // Mirrors `BoardService.attachChild` (see [src/core/services/board.service.ts](src/core/services/board.service.ts))
  // which uses the same pattern for attach-existing-board flows.
  // ---------------------------------------------------------------------------

  /**
   * Pure (no IO). Walks the parent board's TIT fields and rewrites their
   * payload entries from inline objects into id refs.
   *
   * Per-entry rules:
   *  - `string`                       → ref to existing child item
   *  - `{ _id|board_item_id|id }` with ≤ 2 keys → ref to existing child item
   *  - object with > 2 keys, or no id → create new child item with the entry
   *                                     as its `fields`
   *  - anything else                  → ValidationError
   *
   * Depth = 1: nested TIT inside a new child's payload is left inline.
   * Callers should issue a second API call to split deeper levels.
   */
  private splitInlineTitFields(
    parentBoard: Board,
    fieldsPayload: Record<string, any>,
  ): SplitResult {
    const trimmedFields: Record<string, any> = { ...fieldsPayload };
    const newChildItems: SplitNewChild[] = [];
    const edges: SplitEdge[] = [];
    const refs: SplitRef[] = [];
    const childUpdates: SplitChildUpdate[] = [];
    const touchedFieldIds: string[] = [];

    for (const boardField of parentBoard.fields) {
      if (boardField.type !== BoardFieldType.TABLE_IN_TABLE) continue;
      if (!(boardField.id in fieldsPayload)) continue; // not touched

      let raw = fieldsPayload[boardField.id];
      if (raw === null || raw === undefined) {
        touchedFieldIds.push(boardField.id);
        trimmedFields[boardField.id] = [];
        continue;
      }
      // Tolerate round-trips of the hydrated read shape `{ count, sum, data }`
      // — FE may PATCH back what it just GETted without unwrapping.
      if (
        !Array.isArray(raw) &&
        typeof raw === "object" &&
        Array.isArray((raw as any).data)
      ) {
        raw = (raw as any).data;
      }
      if (!Array.isArray(raw)) {
        throw new ValidationError(
          `TIT field '${boardField.name}' must be an array`,
        );
      }

      // Prefer `settings.childBoardId`, falling back to the legacy `data[0].id`
      // shape (migrated/pre-cutover TIT fields store the child board id there
      // and never got a `settings.childBoardId`). Mirrors the read-path
      // `titChildBoardId` fallback in board.service.ts so legacy fields split.
      const childBoardId =
        boardField.settings?.childBoardId ??
        ((boardField as any).data?.[0]?.id as string | undefined);
      if (!childBoardId) {
        logger.warn(
          `TIT field '${boardField.name}' has no childBoardId (settings or data[0]) — skipping split`,
        );
        continue;
      }

      touchedFieldIds.push(boardField.id);
      const finalIds: string[] = [];

      for (const entry of raw as TitEntry[]) {
        if (typeof entry === "string") {
          finalIds.push(entry);
          refs.push({ id: entry, expectedChildBoardId: childBoardId });
          edges.push({
            parent_board_field_id: boardField.id,
            child_board_id: childBoardId,
            child_board_item_id: entry,
          });
        } else if (
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry)
        ) {
          const e = entry as any;
          const refId = e._id ?? e.board_item_id ?? e.id;
          const { _id, board_item_id, id, ...rest } = e;
          if (refId) {
            // Always treat as a ref when an id is present (regardless of how
            // many extra field keys come along). Extra keys are applied as an
            // in-place update to the existing child so a GET → PUT round-trip
            // doesn't duplicate rows in the child board.
            finalIds.push(refId);
            refs.push({ id: refId, expectedChildBoardId: childBoardId });
            edges.push({
              parent_board_field_id: boardField.id,
              child_board_id: childBoardId,
              child_board_item_id: refId,
            });
            if (Object.keys(rest).length > 0) {
              childUpdates.push({
                id: refId,
                childBoardId,
                fields: rest,
              });
            }
          } else {
            const newId = crypto.randomUUID();
            newChildItems.push({
              newId,
              childBoardId,
              parentFieldId: boardField.id,
              fields: rest,
            });
            edges.push({
              parent_board_field_id: boardField.id,
              child_board_id: childBoardId,
              child_board_item_id: newId,
            });
            finalIds.push(newId);
          }
        } else {
          throw new ValidationError(
            `TIT field '${boardField.name}' entries must be string or object`,
          );
        }
      }

      trimmedFields[boardField.id] = finalIds;
    }

    return {
      trimmedFields,
      newChildItems,
      edges,
      refs,
      childUpdates,
      touchedFieldIds,
    };
  }

  /**
   * Inside a transaction: validate ref existence + correct child board, insert
   * new child items (with `related_board_item_id` set to the parent), then
   * bulk-insert `table_in_columns` edges. No-op if `split` has nothing to do.
   */
  private async writeTitEdges(
    tx: NodePgDatabase<typeof schema>,
    parentBoardId: string,
    parentItemId: string,
    parentBoard: Board,
    split: SplitResult,
    actor: string,
  ): Promise<void> {
    if (
      split.refs.length === 0 &&
      split.newChildItems.length === 0 &&
      split.childUpdates.length === 0
    )
      return;

    // Validate refs in a single query — must all exist AND live in the right child board.
    if (split.refs.length > 0) {
      const refIds = Array.from(new Set(split.refs.map((r) => r.id)));
      const rows = await tx
        .select({
          id: schema.boardItems.id,
          board_id: schema.boardItems.board_id,
        })
        .from(schema.boardItems)
        .where(inArray(schema.boardItems.id, refIds));
      const byId = new Map(rows.map((r) => [r.id, r.board_id]));
      for (const ref of split.refs) {
        const actualBoard = byId.get(ref.id);
        if (actualBoard === undefined) {
          throw new NotFoundError(`Child item ${ref.id} not found`);
        }
        if (actualBoard !== ref.expectedChildBoardId) {
          throw new ValidationError(
            `Child item ${ref.id} belongs to board ${actualBoard}, expected ${ref.expectedChildBoardId}`,
          );
        }
      }
    }

    // Insert new child items. related_board_item_id stamps the parent so the
    // child is findable from its owner without consulting table_in_columns.
    if (split.newChildItems.length > 0) {
      // Cross-environment CSV imports embed child rows as `{<field name>:
      // <value>}` objects so the source can't assume the destination's field
      // UUIDs. Translate name→id here, once per unique child board, using the
      // destination's own schema. Unknown keys are dropped (logged) so a
      // mismatched column doesn't ghost-write into `fields` and break reads.
      const uniqueChildBoardIds = Array.from(
        new Set(split.newChildItems.map((c) => c.childBoardId)),
      );
      const nameByBoardId = new Map<string, Map<string, string>>(); // boardId → name→fieldId
      const knownIdsByBoardId = new Map<string, Set<string>>();
      for (const childBoardId of uniqueChildBoardIds) {
        const childBoard = await this.boardRepository
          .findById(childBoardId)
          .catch(() => null);
        if (!childBoard) continue;
        const m = new Map<string, string>();
        const ids = new Set<string>();
        for (const f of childBoard.fields ?? []) {
          if (f?.name && f?.id) m.set(f.name, f.id);
          if (f?.id) ids.add(f.id);
        }
        nameByBoardId.set(childBoardId, m);
        knownIdsByBoardId.set(childBoardId, ids);
      }

      const translateFields = (
        childBoardId: string,
        raw: Record<string, any>,
      ) => {
        const nameMap = nameByBoardId.get(childBoardId);
        const idSet = knownIdsByBoardId.get(childBoardId);
        if (!nameMap || !idSet) return raw; // no schema available — pass through
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (idSet.has(k)) {
            // Already a field ID — keep as-is (FE/programmatic writers).
            out[k] = v;
          } else if (nameMap.has(k)) {
            // Name → field id translation (CSV import path).
            out[nameMap.get(k)!] = v;
          } else {
            logger.warn(
              `writeTitEdges: dropping unknown child field '${k}' on board ${childBoardId} (no matching id or name)`,
            );
          }
        }
        return out;
      };

      const rows = split.newChildItems.map((c) => ({
        id: c.newId,
        business_unit_id: parentBoard.business_unit_id,
        organization_id: parentBoard.organization_id,
        board_id: c.childBoardId,
        created_by: actor,
        created_type: CreateType.MANUAL,
        fields: translateFields(c.childBoardId, c.fields || {}),
        related_board_item_id: parentItemId,
        related_board_item_list: [],
        conversation_ids: [],
      }));
      await tx.insert(schema.boardItems).values(rows as any);
    }

    // Apply in-place updates to existing child items. Entries carrying an
    // `_id` plus extra field keys are interpreted as "update this child" so
    // the round-trip of a hydrated read does not duplicate child rows. Refs
    // were already validated above to exist and belong to the right board.
    if (split.childUpdates.length > 0) {
      const now = new Date();
      for (const upd of split.childUpdates) {
        const [existing] = await tx
          .select({ fields: schema.boardItems.fields })
          .from(schema.boardItems)
          .where(eq(schema.boardItems.id, upd.id));
        if (!existing) continue;
        const merged = {
          ...((existing.fields as Record<string, any>) || {}),
          ...upd.fields,
        };
        await tx
          .update(schema.boardItems)
          .set({ fields: merged, updated_at: now })
          .where(eq(schema.boardItems.id, upd.id));
      }
    }

    // Insert edges. parent_board_item_id is the same for every row in this call.
    const edgeRows = split.edges.map((e) => ({
      parent_board_id: parentBoardId,
      parent_board_item_id: parentItemId,
      parent_board_field_id: e.parent_board_field_id,
      child_board_id: e.child_board_id,
      child_board_item_id: e.child_board_item_id,
      created_by: actor,
      updated_by: actor,
    }));
    if (edgeRows.length > 0) {
      await tx.insert(schema.tableInColumns).values(edgeRows);
    }
  }

  /**
   * Update-path companion to `writeTitEdges`. For every TIT field the payload
   * touched: collect the existing child ids, drop the edges, then delete any
   * child item that the new payload no longer references AND no other parent
   * still references. Without this cleanup, repeat PUTs whose payload omits
   * `_id` would each create a new child row while the previous ones live on
   * as orphans in the child board.
   */
  private async rewriteTitEdges(
    tx: NodePgDatabase<typeof schema>,
    parentBoardId: string,
    parentItemId: string,
    parentBoard: Board,
    split: SplitResult,
    actor: string,
  ): Promise<void> {
    if (split.touchedFieldIds.length === 0) return;

    // Group the new (post-update) child ids by field so we can compute which
    // previously-linked children are no longer referenced.
    const newChildIdsByField = new Map<string, Set<string>>();
    for (const edge of split.edges) {
      let set = newChildIdsByField.get(edge.parent_board_field_id);
      if (!set) {
        set = new Set();
        newChildIdsByField.set(edge.parent_board_field_id, set);
      }
      set.add(edge.child_board_item_id);
    }

    const orphanCandidates = new Set<string>();
    let totalEdgesDeleted = 0;
    for (const fieldId of split.touchedFieldIds) {
      const oldEdges = await tx
        .select({ childId: schema.tableInColumns.child_board_item_id })
        .from(schema.tableInColumns)
        .where(
          and(
            eq(schema.tableInColumns.parent_board_item_id, parentItemId),
            eq(schema.tableInColumns.parent_board_field_id, fieldId),
          ),
        );

      const deleted = await tx
        .delete(schema.tableInColumns)
        .where(
          and(
            eq(schema.tableInColumns.parent_board_item_id, parentItemId),
            eq(schema.tableInColumns.parent_board_field_id, fieldId),
          ),
        )
        .returning({ id: schema.tableInColumns.id });
      totalEdgesDeleted += deleted.length;

      const keepers = newChildIdsByField.get(fieldId) ?? new Set<string>();
      for (const row of oldEdges) {
        if (!keepers.has(row.childId)) orphanCandidates.add(row.childId);
      }
    }

    // Only drop child rows that no other edge still points at — a TIT child
    // can in principle be linked from multiple parent fields/items.
    if (orphanCandidates.size > 0) {
      const candidates = Array.from(orphanCandidates);
      const stillReferenced = await tx
        .select({ childId: schema.tableInColumns.child_board_item_id })
        .from(schema.tableInColumns)
        .where(inArray(schema.tableInColumns.child_board_item_id, candidates));
      const referenced = new Set(stillReferenced.map((r) => r.childId));
      const toDelete = candidates.filter((id) => !referenced.has(id));
      if (toDelete.length > 0) {
        await tx
          .delete(schema.boardItems)
          .where(inArray(schema.boardItems.id, toDelete));
        logger.info(
          `rewriteTitEdges: parent=${parentItemId} dropped ${totalEdgesDeleted} edge(s), deleted ${toDelete.length} orphan child item(s)`,
        );
      } else {
        logger.info(
          `rewriteTitEdges: parent=${parentItemId} dropped ${totalEdgesDeleted} edge(s); ${candidates.length} child(ren) still referenced elsewhere`,
        );
      }
    } else if (totalEdgesDeleted > 0) {
      logger.info(
        `rewriteTitEdges: parent=${parentItemId} dropped ${totalEdgesDeleted} edge(s), no orphans`,
      );
    }

    await this.writeTitEdges(
      tx,
      parentBoardId,
      parentItemId,
      parentBoard,
      split,
      actor,
    );
  }

  /**
   * Read-side hydration for TIT fields. Returns the legacy Mongo shape so the
   * FE renders unchanged:
   *
   *   parent.fields[titFieldId] = { count, sum, data }
   *
   * Where:
   *   - `count` is the number of child records
   *   - `sum`   is `0` if no child field is numeric, the single summed value
   *             when exactly one numeric key exists, or `{ key: sumValue, ... }`
   *             when multiple numeric keys exist (matches legacy
   *             `controllers/board.js:1095-1107`)
   *   - `data`  is `child.fields[]` for each child (NOT the full BoardItem —
   *             matches legacy `$replaceRoot: { newRoot: '$childItems.fields' }`)
   *
   * Two payload shapes are accepted in DB:
   *   - `string[]`  — modern shape (post the inline-split fix); we batch-fetch
   *                   child items by id and pull their `.fields`.
   *   - `object[]`  — legacy inline data still in DB (pre-fix rows); we use
   *                   the objects directly without a DB roundtrip.
   * Anything else (null/undefined/non-array) is left untouched so FE accessors
   * can fall through to a 0 count naturally.
   */
  /**
   * Walk each item's SingleSelection / MultipleSelection field values and, when
   * the stored value matches a known option id/_id, replace it with the
   * option's `value` (label). Legacy rows that already store the label pass
   * through unchanged.
   *
   * Background: the FE fix on 2026-05-19 (4385cf7 + ad440e1 + follow-ons)
   * started writing the option's id into board_item.fields[fieldId] so React
   * dropdowns key correctly. That broke workflow / usecase consumers who
   * expect the human-readable label. The fix is to resolve at read time so
   * the storage shape stays as the FE expects and downstream consumers still
   * see labels.
   */
  private resolveSelectionLabels(items: BoardItem[], board: Board): void {
    if (items.length === 0) return;
    const idToLabelByField = this.buildSelectionLabelMap(board);
    if (idToLabelByField.size === 0) return;
    for (const item of items) {
      if (!item.fields) continue;
      this.applySelectionLabelMap(
        item.fields as Record<string, any>,
        idToLabelByField,
      );
    }
  }

  /**
   * Hydrate Assignee / MultipleAssignee field values in place.
   *
   * The pre-migration Mongo backend stored assignee values as objects carrying
   * the user's `display_name` (etc.); the PG port stores only the user id, so
   * reads returned bare ids — the FE/CSV then showed the id instead of the
   * name. This re-resolves each id to `{ id, display_name, email, avatar_url }`
   * by fetching the org's active users from platform-service ONCE per call.
   *
   * Mirrors `resolveSelectionLabels`: collects the assignee field ids on the
   * board, then rewrites matching values on every item. Non-fatal — if the
   * platform fetch fails (or no context), values are left id-only.
   *
   * ASSIGNEE: bare id string OR object missing display_name → replaced/backfilled.
   * MULTI_ASSIGNEE: array of ids and/or objects, each element mapped the same.
   * Unknown ids (deactivated/removed users) degrade to `{ id }`, never dropped.
   */
  private async hydrateAssigneeFields(
    items: BoardItem[],
    board: Board,
    ctx?: AssigneeHydrationContext,
  ): Promise<void> {
    if (items.length === 0) return;
    const assigneeFieldIds = this.collectAssigneeFieldIds(board);
    if (assigneeFieldIds.size === 0) return;

    const userMap = await fetchOrgUserMap({
      organizationId: ctx?.organizationId,
      userId: ctx?.userId,
      accessToken: ctx?.accessToken,
    });
    // No users resolved (fetch failed / empty org) → leave values id-only.
    if (userMap.size === 0) return;

    for (const item of items) {
      if (!item.fields) continue;
      const fields = item.fields as Record<string, any>;
      for (const [fieldId, isMulti] of assigneeFieldIds) {
        const v = fields[fieldId];
        if (v == null) continue;
        if (isMulti) {
          if (!Array.isArray(v)) continue;
          fields[fieldId] = v
            .map((el) => this.hydrateAssigneeValue(el, userMap))
            .filter((el) => el != null);
        } else {
          fields[fieldId] = this.hydrateAssigneeValue(v, userMap);
        }
      }
    }
  }

  /** Build `{fieldId → isMultiAssignee}` for assignee fields on a board. */
  private collectAssigneeFieldIds(board: Board): Map<string, boolean> {
    const out = new Map<string, boolean>();
    for (const f of board.fields || []) {
      const type = (f as any).type;
      const isMulti = type === BoardFieldType.MULTI_ASSIGNEE;
      if (type !== BoardFieldType.ASSIGNEE && !isMulti) continue;
      const fieldId: string | undefined = (f as any).id ?? (f as any)._id;
      if (fieldId) out.set(fieldId, isMulti);
    }
    return out;
  }

  /**
   * Resolve a single assignee value (id string or object) to the full
   * `{ id, display_name, email, avatar_url }` shape. Backfills `display_name`
   * on objects that lack it. Unknown ids degrade to `{ id }`.
   */
  private hydrateAssigneeValue(
    value: unknown,
    userMap: Map<string, AssigneeSummary>,
  ): AssigneeSummary | { id: string } | null {
    // Bare id string.
    if (typeof value === "string") {
      if (!value) return null;
      return userMap.get(value) ?? { id: value };
    }
    // Object form: pull the id, then prefer a fresh lookup; otherwise keep the
    // existing object but backfill a missing display_name when we can.
    if (value && typeof value === "object") {
      const obj = value as Record<string, any>;
      const id: string | undefined = obj.id ?? obj._id ?? obj.user_id;
      if (!id) return obj as any;
      const resolved = userMap.get(id);
      if (resolved) return resolved;
      return { ...(obj as any), id } as any;
    }
    return null;
  }

  /** Build `{fieldId → {optionId → label}}` for selection fields on a board. */
  private buildSelectionLabelMap(
    board: Board,
  ): Map<string, Map<string, unknown>> {
    const idToLabelByField = new Map<string, Map<string, unknown>>();
    for (const f of board.fields || []) {
      const type = (f as any).type;
      if (
        type !== BoardFieldType.SINGLE_SELECTION &&
        type !== BoardFieldType.MULTI_SELECTION
      ) {
        continue;
      }
      const fieldId: string | undefined = (f as any).id ?? (f as any)._id;
      const opts: any[] = Array.isArray((f as any).data) ? (f as any).data : [];
      if (!fieldId || opts.length === 0) continue;

      const map = new Map<string, unknown>();
      for (const opt of opts) {
        const oid = opt?.id ?? opt?._id;
        if (typeof oid === "string" && opt && "value" in opt) {
          map.set(oid, opt.value);
        }
      }
      if (map.size > 0) idToLabelByField.set(fieldId, map);
    }
    return idToLabelByField;
  }

  /** Mutates `fields`: replaces selection option ids with their labels in place. */
  private applySelectionLabelMap(
    fields: Record<string, any>,
    idToLabelByField: Map<string, Map<string, unknown>>,
  ): void {
    for (const [fieldId, idToLabel] of idToLabelByField) {
      const v = fields[fieldId];
      if (v == null) continue;
      if (typeof v === "string") {
        if (idToLabel.has(v)) fields[fieldId] = idToLabel.get(v);
      } else if (Array.isArray(v)) {
        fields[fieldId] = v.map((el) =>
          typeof el === "string" && idToLabel.has(el) ? idToLabel.get(el) : el,
        );
      }
    }
  }

  /**
   * Return a shallow-cloned fields dict with selection option ids replaced by
   * labels. Used by Kafka publishers so workflow consumers receive labels
   * without mutating the in-memory item still held by HTTP callers. Returns
   * the original reference unchanged when there is nothing to resolve.
   */
  private cloneFieldsWithResolvedLabels(
    fields: Record<string, any> | undefined,
    board: Board | null | undefined,
  ): Record<string, any> | undefined {
    if (!fields || !board) return fields;
    const idToLabelByField = this.buildSelectionLabelMap(board);
    if (idToLabelByField.size === 0) return fields;
    const clone = { ...fields };
    this.applySelectionLabelMap(clone, idToLabelByField);
    return clone;
  }

  private async hydrateTitFields(
    items: BoardItem[],
    parentBoard: Board,
  ): Promise<void> {
    if (items.length === 0) return;
    // Resolve a TIT field's child board id, falling back to the legacy
    // `data[0].id` shape for migrated/pre-cutover fields with no
    // `settings.childBoardId` (mirrors the split + board-column hydration).
    const titChildBoardId = (f: any): string | undefined =>
      f.settings?.childBoardId ?? (f.data?.[0]?.id as string | undefined);
    const titFields = parentBoard.fields.filter(
      (f) => f.type === BoardFieldType.TABLE_IN_TABLE && !!titChildBoardId(f),
    );
    if (titFields.length === 0) return;

    // Group id lookups by child board so we batch one query per child board.
    const idsByChildBoard = new Map<string, Set<string>>();
    for (const item of items) {
      for (const field of titFields) {
        const v = item.fields?.[field.id];
        if (!Array.isArray(v)) continue;
        for (const entry of v) {
          if (typeof entry === "string") {
            const childBoardId = titChildBoardId(field)!;
            let set = idsByChildBoard.get(childBoardId);
            if (!set) {
              set = new Set();
              idsByChildBoard.set(childBoardId, set);
            }
            set.add(entry);
          }
        }
      }
    }

    const childById = new Map<string, BoardItem>();
    for (const [childBoardId, idSet] of idsByChildBoard) {
      const ids = Array.from(idSet);
      if (ids.length === 0) continue;
      const rows = await this.itemRepository.findByFilter(
        childBoardId,
        { id: { $in: ids } },
        { skip: 0, limit: ids.length },
      );
      // Child board may define its own SingleSelection/MultiSelection options;
      // resolve those before stuffing into the parent response, otherwise
      // workflow consumers see option UUIDs inside nested TIT rows.
      const childBoard = await this.boardRepository
        .findById(childBoardId)
        .catch(() => null);
      if (childBoard) {
        this.resolveSelectionLabels(rows.data, childBoard);
      }
      for (const row of rows.data) {
        const key = row.id || row._id;
        if (key) childById.set(key, row);
      }
    }

    for (const item of items) {
      if (!item.fields) continue;
      for (const field of titFields) {
        const v = item.fields[field.id];
        if (!Array.isArray(v)) continue;

        // Resolve each entry to its `fields` payload. `_id` is preserved on
        // every hydrated row so that when the FE echoes the read shape back
        // via PUT, splitInlineTitFields recognises it as an existing child
        // (in-place update) instead of inserting a duplicate row.
        const data: Record<string, any>[] = [];
        for (const entry of v) {
          if (typeof entry === "string") {
            const child = childById.get(entry);
            if (child && child.fields) {
              const childId = child.id || child._id;
              data.push(
                childId ? { _id: childId, ...child.fields } : child.fields,
              );
            }
          } else if (
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry)
          ) {
            const e = entry as Record<string, any>;
            // Legacy inline shape may already be just fields, or it may be a
            // BoardItem-like object with a `.fields` subdoc — handle both.
            if (e.fields && typeof e.fields === "object") {
              const id = e._id ?? e.id ?? e.board_item_id;
              data.push(id ? { _id: id, ...e.fields } : e.fields);
            } else {
              data.push(e);
            }
          }
        }

        // Sum numeric child fields per key (matches legacy aggregation).
        const sums: Record<string, number> = {};
        for (const child of data) {
          for (const [key, value] of Object.entries(child)) {
            if (typeof value === "number") {
              sums[key] = (sums[key] || 0) + value;
            }
          }
        }
        let sum: number | Record<string, number> = 0;
        const sumKeys = Object.keys(sums);
        if (sumKeys.length === 1) sum = sums[sumKeys[0]];
        else if (sumKeys.length > 1) sum = sums;

        item.fields[field.id] = { count: data.length, sum, data };
      }
    }
  }
}
