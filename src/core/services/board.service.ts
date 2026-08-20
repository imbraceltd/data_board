/**
 * Board Service
 * Business logic for board management
 */

import type { DatabaseClient } from "../../infrastructure/database/types";
import { BoardRepository } from "../../infrastructure/database/repositories/board.repository";
import { DocSchemaRepository } from "../../infrastructure/database/repositories/doc-schema.repository";
import type {
  Board,
  BoardField,
  BoardFilters,
  CreateBoardDTO,
  UpdateBoardDTO,
  CreateBoardFieldDTO,
  UpdateBoardFieldDTO,
  BoardAttachedFrom,
} from "../../domain/shared/board.types";
import { BoardFieldType, BoardType } from "../../domain/shared/board.types";
import { DEFAULT_BOARD_TEMPLATES } from "./default-boards.template";
import {
  DUMMY_DATA_SETS,
  BOARDS_WITH_SAMPLE_ROWS,
  DEMO_BOARD_NAME,
  DEMO_BOARD_DESCRIPTION,
  DEMO_BOARD_VALUES,
  SAMPLE_ROWS_PER_BOARD,
} from "./default-board-items.template";
import { BoardItemRepository } from "../../infrastructure/database/repositories/board-item.repository";
import crypto from "crypto";
import {
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  AttachDetachError,
} from "../../domain/shared/errors";
import logger from "../../infrastructure/logging/logger";
import { eq, and, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../db/drizzle/schema";

export interface BoardServiceConfig {
  db: DatabaseClient;
}

export class BoardService {
  private repository: BoardRepository;
  private db: DatabaseClient;

  constructor(config: BoardServiceConfig) {
    this.repository = new BoardRepository(config.db);
    this.db = config.db;
  }

  /**
   * Get the raw Drizzle client for transactional writes (attach/detach child).
   * Throws if the underlying adapter isn't Postgres/Drizzle.
   */
  private getDrizzle(): NodePgDatabase<typeof schema> {
    const raw = this.db.getRawClient?.();
    if (!raw || typeof (raw as any).transaction !== "function") {
      throw new AttachDetachError(
        "DRIZZLE_REQUIRED",
        "attach-child / detach-child require a Postgres (Drizzle) database",
        501,
      );
    }
    return raw as NodePgDatabase<typeof schema>;
  }

  /**
   * Get board by ID. TableInTable fields are hydrated with their child board's
   * `fields[]` so callers (e.g. the FE schema editor) can render nested columns
   * without a follow-up request.
   */
  async getBoard(id: string): Promise<Board> {
    const board = await this.repository.findById(id);
    if (!board) {
      throw new NotFoundError(`Board ${id} not found`);
    }
    return this.hydrateTableInTableFields(board);
  }

  /**
   * Walk a board's fields. For each TABLE_IN_TABLE field with a known
   * `settings.childBoardId`, embed the child board's `fields[]` onto the
   * parent field as `child_board_fields` — the snake_case property name the
   * legacy backend (and current FE) expects (see `be and IPS/backend/src/
   * controllers/board.js` lines 1424, 4470, 4616, 4637 — all four read paths
   * embed via `field.child_board_fields = childBoard.fields`).
   *
   * Recurses to support nested TIT chains; `visited` short-circuits cycles.
   */
  private async hydrateTableInTableFields(
    board: Board,
    visited: Set<string> = new Set(),
  ): Promise<Board> {
    const boardKey = board._id || board.id;
    if (boardKey) {
      if (visited.has(boardKey)) return board;
      visited.add(boardKey);
    }

    // Resolve a TIT field's child board id from the canonical
    // `settings.childBoardId`, falling back to the legacy `data[0].id` shape
    // used by boards created before the create path populated settings
    // (migrated / pre-Apr-2026 workflow boards). Without this fallback those
    // fields never hydrate and the table renders empty on the FE.
    const titChildBoardId = (f: BoardField): string | undefined => {
      const fromSettings = (f.settings as any)?.childBoardId as
        | string
        | undefined;
      if (fromSettings) return fromSettings;
      const data = (f as any).data;
      return Array.isArray(data)
        ? (data[0]?.id as string | undefined)
        : undefined;
    };

    const hasTit = board.fields.some(
      (f) => f.type === BoardFieldType.TABLE_IN_TABLE && !!titChildBoardId(f),
    );
    if (!hasTit) return board;

    const hydratedFields = await Promise.all(
      board.fields.map(async (f) => {
        if (f.type !== BoardFieldType.TABLE_IN_TABLE) return f;
        const childBoardId = titChildBoardId(f);
        if (!childBoardId) return f;
        const childBoard = await this.repository.findById(childBoardId);
        if (!childBoard) return f;
        const hydratedChild = await this.hydrateTableInTableFields(
          childBoard,
          visited,
        );
        return {
          ...f,
          child_board_fields: hydratedChild.fields,
        } as BoardField & { child_board_fields: BoardField[] };
      }),
    );

    return { ...board, fields: hydratedFields };
  }

  /**
   * Get boards for organization with optional filters
   */
  async getBoards(
    organizationId: string,
    filters?: BoardFilters,
  ): Promise<Board[]> {
    return this.repository.findByOrganization(organizationId, filters);
  }

  /**
   * Get boards accessible by team
   */
  async getBoardsForTeam(
    organizationId: string,
    teamIds: string[],
    filters?: BoardFilters,
  ): Promise<Board[]> {
    return this.repository.findByTeamAccess(organizationId, teamIds, filters);
  }

  /**
   * List boards for the org plus an accurate `total` for server-side pagination.
   * `total` counts every board matching the filters (type/hidden/search/category)
   * BEFORE limit/skip.
   *
   * Team scoping is driven by `teamScope`, resolved server-side from the caller's
   * identity (see resolveTeamScope middleware):
   *   - resolved=false → scope couldn't be determined (no creds / platform
   *     error). Fail OPEN: list across the whole org so users aren't locked out.
   *   - resolved=true  → authoritative. Restrict to boards these teams can
   *     access (boards with no managers are open to all). An empty team list
   *     therefore yields only no-manager boards.
   */
  async listBoardsWithTotal(
    organizationId: string,
    filters: BoardFilters,
    teamScope?: { resolved: boolean; teamIds: string[] },
  ): Promise<{ data: Board[]; total: number }> {
    if (teamScope?.resolved) {
      return this.repository.findByTeamAccessWithTotal(
        organizationId,
        teamScope.teamIds,
        filters,
      );
    }

    const [data, total] = await Promise.all([
      this.repository.findByOrganization(organizationId, filters),
      this.repository.count(organizationId, filters),
    ]);
    return { data, total };
  }

  /**
   * Get boards by type
   */
  async getBoardsByType(
    organizationId: string,
    type: string,
  ): Promise<Board[]> {
    return this.repository.findByType(organizationId, type);
  }

  /**
   * Create a new board.
   * If any field is of type TABLE_IN_TABLE, a child board is automatically
   * created and its ID is linked into the field's settings.childBoardId.
   */
  async createBoard(data: CreateBoardDTO): Promise<Board> {
    // Validate board data
    this.validateBoardData(data);

    // Validate fields if provided
    if (data.fields && data.fields.length > 0) {
      this.validateFields(data.fields);
    }

    // Get current board count for ordering
    const boardCount = await this.repository.count(data.organization_id);
    const order = data.order !== undefined ? data.order : boardCount;

    // Pre-process TABLE_IN_TABLE fields: auto-create child boards
    const processedFields = data.fields
      ? await this.processTableInTableFields(data.fields, data)
      : data.fields;

    const board = await this.repository.create({
      ...data,
      fields: processedFields,
      order,
    });

    logger.info(`Board created: ${board.id} (${board.name})`);
    return board;
  }

  /**
   * Seed the 6 default CRM boards (Contacts, Companies, Opportunities, Tasks,
   * Product, Opt-out) plus a 7th "Demo Board" for a fresh org, then populate
   * 10 sample rows into every board except Opt-out — mirroring legacy
   * `backend/src/facades/Organization.js` which called Board.generateDefault
   * + addDummyData + addDummyDataBoard during org creation.
   *
   * Called by platform-service from CreateOrganization. Idempotent: if any
   * board already exists for the org it returns without writing, matching
   * legacy Board.generateDefault's pre-cutover behaviour (skipped if board
   * count > 0).
   */
  async seedDefaults(
    organizationId: string,
    businessUnitId: string,
  ): Promise<{
    seeded: boolean;
    boardIds: string[];
    boardItemsInserted: number;
  }> {
    const existing = await this.repository.count(organizationId);
    if (existing > 0) {
      logger.info(
        `seedDefaults: skip — org ${organizationId} already has ${existing} board(s)`,
      );
      return { seeded: false, boardIds: [], boardItemsInserted: 0 };
    }

    // Track created boards so the sample-row seeder can look up their ids and
    // field._id values (which are generated above and not on the templates).
    const createdBoards: Array<{
      id: string;
      name: string;
      fields: Array<{ id: string; name: string }>;
    }> = [];

    const buildFields = (
      tmplFields: Array<{
        name: string;
        type: BoardFieldType;
        description?: string;
        isDefault?: boolean;
        isIdentifier?: boolean;
        isUniqueIdentifier?: boolean;
        defaultFieldName?: string;
        contactField?: string;
        data?: Array<{ value: string }>;
        settings?: Record<string, unknown>;
      }>,
    ) =>
      tmplFields.map((f) => ({
        id: crypto.randomUUID(),
        hidden: false,
        hiddenOnRecord: false,
        isDeprecated: false,
        isDefault: f.isDefault ?? false,
        isUniqueIdentifier: f.isUniqueIdentifier ?? false,
        isIdentifier: f.isIdentifier ?? false,
        name: f.name,
        type: f.type,
        description: f.description,
        defaultFieldName: f.defaultFieldName,
        contactField: f.contactField,
        data: f.data,
        settings: f.settings,
      }));

    // 1. Create the 6 default CRM boards.
    for (const template of DEFAULT_BOARD_TEMPLATES) {
      const fields = buildFields(template.fields);
      const board = await this.repository.create({
        organization_id: organizationId,
        business_unit_id: businessUnitId,
        name: template.name,
        description: template.description,
        type: template.type,
        order: template.order,
        hidden: false,
        fields: fields as any,
      } as CreateBoardDTO);
      if (board.id) {
        createdBoards.push({
          id: board.id,
          name: template.name,
          fields: fields.map((f) => ({ id: f.id, name: f.name })),
        });
      }
    }

    // 2. Create the Demo Board (legacy addDummyDataBoard — appended after the
    //    6 defaults at order = DEFAULT_BOARD_TEMPLATES.length + 1).
    const demoFields = buildFields([
      {
        name: "Name",
        type: BoardFieldType.SHORT_TEXT,
        contactField: "display_name",
        isDefault: true,
        isIdentifier: true,
        defaultFieldName: "name",
        description: "Name of the customer",
      },
      {
        name: "Email",
        type: BoardFieldType.EMAIL,
        contactField: "email",
        isUniqueIdentifier: true,
        isDefault: true,
        defaultFieldName: "email",
        description:
          "Email collected through conversation or entered by user/automations",
      },
    ]);
    const demoBoard = await this.repository.create({
      organization_id: organizationId,
      business_unit_id: businessUnitId,
      name: DEMO_BOARD_NAME,
      description: DEMO_BOARD_DESCRIPTION,
      type: BoardType.GENERAL,
      order: DEFAULT_BOARD_TEMPLATES.length + 1,
      hidden: false,
      fields: demoFields as any,
    } as CreateBoardDTO);
    if (demoBoard.id) {
      createdBoards.push({
        id: demoBoard.id,
        name: DEMO_BOARD_NAME,
        fields: demoFields.map((f) => ({ id: f.id, name: f.name })),
      });
    }

    // 3. Seed 10 sample rows into each of Contacts/Companies/Opportunities/
    //    Tasks/Product + Demo Board (legacy filtered Opt-out out even though
    //    its dummy rows were defined). Field._id <-> column-index zip mirrors
    //    legacy addDummyData() exactly.
    const itemRepo = new BoardItemRepository(this.db);
    const itemsToInsert: Array<{
      organization_id: string;
      business_unit_id: string;
      board_id: string;
      fields: Record<string, unknown>;
    }> = [];

    for (const dataset of DUMMY_DATA_SETS) {
      if (!BOARDS_WITH_SAMPLE_ROWS.has(dataset.boardName)) continue;
      const board = createdBoards.find((b) => b.name === dataset.boardName);
      if (!board) continue;
      for (let i = 0; i < SAMPLE_ROWS_PER_BOARD; i++) {
        const row = dataset.values[i % dataset.values.length];
        const fieldsObj: Record<string, unknown> = {};
        board.fields.forEach((f, idx) => {
          fieldsObj[f.id] = row[idx] ?? null;
        });
        itemsToInsert.push({
          organization_id: organizationId,
          business_unit_id: businessUnitId,
          board_id: board.id,
          fields: fieldsObj,
        });
      }
    }

    const demoBoardCreated = createdBoards.find(
      (b) => b.name === DEMO_BOARD_NAME,
    );
    if (demoBoardCreated) {
      for (let i = 0; i < SAMPLE_ROWS_PER_BOARD; i++) {
        const row = DEMO_BOARD_VALUES[i % DEMO_BOARD_VALUES.length];
        const fieldsObj: Record<string, unknown> = {};
        demoBoardCreated.fields.forEach((f, idx) => {
          if (row[idx] !== undefined) fieldsObj[f.id] = row[idx];
        });
        itemsToInsert.push({
          organization_id: organizationId,
          business_unit_id: businessUnitId,
          board_id: demoBoardCreated.id,
          fields: fieldsObj,
        });
      }
    }

    let boardItemsInserted = 0;
    if (itemsToInsert.length > 0) {
      const inserted = await itemRepo.createMultiple(itemsToInsert as any);
      boardItemsInserted = inserted.length;
    }

    const boardIds = createdBoards.map((b) => b.id);
    logger.info(
      `seedDefaults: created ${boardIds.length} boards + ${boardItemsInserted} sample items for org ${organizationId}`,
    );
    return { seeded: true, boardIds, boardItemsInserted };
  }

  /**
   * For each TABLE_IN_TABLE field, create a hidden child board and link it.
   * Nested fields passed on the TABLE_IN_TABLE field definition are forwarded
   * to the child board so everything is created in one request.
   */
  private async processTableInTableFields(
    fields: BoardField[],
    parentData: CreateBoardDTO,
  ): Promise<BoardField[]> {
    return Promise.all(
      fields.map(async (field) => {
        if (field.type !== BoardFieldType.TABLE_IN_TABLE) return field;

        const nestedFields = (field as any).fields as BoardField[] | undefined;

        const childBoard = await this.repository.create({
          name: field.name,
          organization_id: parentData.organization_id,
          business_unit_id: parentData.business_unit_id,
          type: parentData.type,
          hidden: true,
          is_child_table: true,
          fields: nestedFields ?? [],
          managers: parentData.managers ?? [],
          order: 0,
        });

        logger.info(
          `Child board created for TABLE_IN_TABLE field '${field.name}': ${childBoard._id}`,
        );

        return {
          ...field,
          id: childBoard._id,
          _id: childBoard._id,
          settings: {
            ...field.settings,
            childBoardId: childBoard._id,
            childBoardName: childBoard.name,
          },
        };
      }),
    );
  }

  /**
   * Update board metadata
   */
  async updateBoard(id: string, data: UpdateBoardDTO): Promise<Board> {
    // Ensure board exists
    await this.getBoard(id);

    // Validate update data
    if (data.name !== undefined && !data.name.trim()) {
      throw new ValidationError("Board name cannot be empty");
    }

    const board = await this.repository.update(id, data);
    logger.info(`Board updated: ${board.id}`);
    return board;
  }

  /**
   * Delete board
   */
  async deleteBoard(id: string): Promise<void> {
    // Ensure board exists (and capture its org for the cross-link cleanup).
    const board = await this.getBoard(id);

    await this.repository.delete(id);
    logger.info(`Board deleted: ${id}`);

    // Prune this board's id from any doc_schema.databoard_ids so the schema
    // detail/list responses don't carry a dangling reference. Best-effort: a
    // cleanup failure must not turn a successful delete into an error.
    //
    // NOTE: the agent side of this (pruning doc_schema.agent_ids when an
    // assistant is deleted) is NOT handled here — agents live in the external
    // AI service, so it needs a webhook/event handler in this repo that calls
    // a sibling DocSchemaRepository.removeAgentIdFromSchemas(orgId, agentId).
    // TODO(agent-webhook): build that endpoint and the repo method.
    try {
      const schemaRepo = new DocSchemaRepository(this.db);
      const pruned = await schemaRepo.removeBoardIdFromSchemas(
        board.organization_id,
        id,
      );
      if (pruned > 0) {
        logger.info(
          `Unlinked deleted board ${id} from ${pruned} schema(s)`,
        );
      }
    } catch (error) {
      logger.error(
        `Failed to unlink deleted board ${id} from schemas: ${
          (error as Error).message
        }`,
      );
    }
  }

  /**
   * Add field to board
   */
  async addField(
    boardId: string,
    fieldData: CreateBoardFieldDTO,
  ): Promise<Board> {
    // Validate field data
    this.validateFieldData(fieldData);

    // Check if field name already exists
    const board = await this.getBoard(boardId);
    const existingField = board.fields.find(
      (f) => f.name.toLowerCase() === fieldData.name.toLowerCase(),
    );
    if (existingField) {
      throw new ValidationError(
        `Field with name '${fieldData.name}' already exists`,
      );
    }

    // Validate unique identifier constraint
    if (fieldData.isUniqueIdentifier) {
      const hasUniqueIdentifier = board.fields.some(
        (f) => f.isUniqueIdentifier,
      );
      if (hasUniqueIdentifier) {
        throw new ValidationError(
          "Board already has a unique identifier field",
        );
      }
    }

    // For TABLE_IN_TABLE, provision a hidden child board on demand and link it
    // back into the parent field's settings. Mirrors createBoard's behaviour so
    // a TIT field added later (single POST /fields or bulk PUT/PATCH) ends up
    // shaped the same as one created at board-creation time.
    let persistedFieldData = fieldData;
    if (fieldData.type === BoardFieldType.TABLE_IN_TABLE) {
      const normaliseNested = (raw: any): any => ({
        ...raw,
        id: raw?.id ?? crypto.randomUUID(),
        hidden: raw?.hidden ?? false,
        hiddenOnRecord: raw?.hiddenOnRecord ?? false,
        isIdentifier: raw?.isUniqueIdentifier ?? false,
        isDeprecated: false,
        fields: Array.isArray(raw?.fields)
          ? raw.fields.map(normaliseNested)
          : undefined,
      });
      const nestedFields = ((fieldData.fields ?? []) as any[]).map(
        normaliseNested,
      );
      const childBoardName =
        fieldData.settings?.childBoardName?.trim() || fieldData.name;

      const childBoard = await this.repository.create({
        name: childBoardName,
        organization_id: board.organization_id,
        business_unit_id: board.business_unit_id,
        type: board.type,
        hidden: true,
        is_child_table: true,
        fields: nestedFields as any,
        managers: board.managers ?? [],
        order: 0,
      });

      logger.info(
        `Child board created for TABLE_IN_TABLE field '${fieldData.name}': ${childBoard._id}`,
      );

      persistedFieldData = {
        ...fieldData,
        id: childBoard._id,
        settings: {
          ...(fieldData.settings ?? {}),
          childBoardId: childBoard._id,
          childBoardName: childBoard.name,
        },
      };
    }

    const updatedBoard = await this.repository.addField(
      boardId,
      persistedFieldData,
    );
    logger.info(`Field added to board ${boardId}: ${fieldData.name}`);
    return this.hydrateTableInTableFields(updatedBoard);
  }

  /**
   * Update board field
   */
  async updateField(
    boardId: string,
    fieldId: string,
    updates: UpdateBoardFieldDTO,
  ): Promise<Board> {
    // Validate updates
    if (updates.name !== undefined && !updates.name.trim()) {
      throw new ValidationError("Field name cannot be empty");
    }

    // Check if renaming to existing field name
    if (updates.name) {
      const board = await this.getBoard(boardId);
      const existingField = board.fields.find(
        (f) =>
          f.id !== fieldId &&
          f.name.toLowerCase() === updates.name!.toLowerCase(),
      );
      if (existingField) {
        throw new ValidationError(
          `Field with name '${updates.name}' already exists`,
        );
      }
    }

    const updatedBoard = await this.repository.updateField(
      boardId,
      fieldId,
      updates,
    );
    logger.info(`Field updated in board ${boardId}: ${fieldId}`);
    return this.hydrateTableInTableFields(updatedBoard);
  }

  /**
   * Delete board field
   */
  async deleteField(boardId: string, fieldId: string): Promise<Board> {
    const board = await this.getBoard(boardId);

    // Check if it's a default field (should not be deleted)
    const field = board.fields.find((f) => f.id === fieldId);
    if (field?.isDefault) {
      throw new ValidationError("Cannot delete default field");
    }

    const childBoardId =
      field?.type === BoardFieldType.TABLE_IN_TABLE
        ? field.settings?.childBoardId ?? field.id
        : undefined;

    const updatedBoard = await this.repository.deleteField(boardId, fieldId);
    logger.info(`Field deleted from board ${boardId}: ${fieldId}`);

    // Best-effort cleanup: a failure here must not undo the field deletion the
    // caller already committed to. Log and move on if the child board is gone.
    if (childBoardId) {
      try {
        await this.repository.delete(childBoardId);
        logger.info(
          `Child board ${childBoardId} deleted with TABLE_IN_TABLE field ${fieldId}`,
        );
      } catch (error) {
        logger.error(
          `Failed to delete child board ${childBoardId} for field ${fieldId}: ${
            (error as Error).message
          }`,
        );
      }
    }

    return this.hydrateTableInTableFields(updatedBoard);
  }

  /**
   * Reorder board fields
   */
  async reorderFields(boardId: string, fieldIds: string[]): Promise<Board> {
    // Ensure board exists
    const board = await this.getBoard(boardId);

    // Validate that all field IDs exist
    const existingFieldIds = new Set(board.fields.map((f) => f.id));
    const invalidIds = fieldIds.filter((id) => !existingFieldIds.has(id));
    if (invalidIds.length > 0) {
      throw new ValidationError(`Invalid field IDs: ${invalidIds.join(", ")}`);
    }

    const updatedBoard = await this.repository.reorderFields(boardId, fieldIds);
    logger.info(`Fields reordered in board ${boardId}`);
    return this.hydrateTableInTableFields(updatedBoard);
  }

  /**
   * Reorder boards
   */
  async reorderBoards(boardIds: string[]): Promise<void> {
    // Validate that all boards exist
    await Promise.all(boardIds.map((id) => this.getBoard(id)));

    await this.repository.reorder(boardIds);
    logger.info(`Boards reordered: ${boardIds.length} boards`);
  }

  /**
   * Check if user has access to board
   */
  async hasAccess(boardId: string, teamIds: string[]): Promise<boolean> {
    const board = await this.getBoard(boardId);

    // If no managers, everyone has access
    if (!board.managers || board.managers.length === 0) {
      return true;
    }

    // Check if any of user's teams have access
    return board.managers.some((manager) => teamIds.includes(manager.teamId));
  }

  /**
   * Get board field by ID
   */
  async getField(boardId: string, fieldId: string): Promise<BoardField> {
    const board = await this.getBoard(boardId);
    const field = board.fields.find((f) => f.id === fieldId);
    if (!field) {
      throw new NotFoundError(`Field ${fieldId} not found in board ${boardId}`);
    }
    return field;
  }

  /**
   * Check board exists
   */
  async exists(id: string): Promise<boolean> {
    return this.repository.exists(id);
  }

  /**
   * Count boards
   */
  async count(organizationId: string, filters?: BoardFilters): Promise<number> {
    return this.repository.count(organizationId, filters);
  }

  /**
   * Validate board data
   */
  private validateBoardData(data: CreateBoardDTO): void {
    if (!data.name || !data.name.trim()) {
      throw new ValidationError("Board name is required");
    }

    if (!data.organization_id) {
      throw new ValidationError("Organization ID is required");
    }

    if (!data.type) {
      throw new ValidationError("Board type is required");
    }
  }

  /**
   * Validate field data
   */
  private validateFieldData(data: CreateBoardFieldDTO): void {
    if (!data.name || !data.name.trim()) {
      throw new ValidationError("Field name is required");
    }

    if (!data.type) {
      throw new ValidationError("Field type is required");
    }

    // Validate field type-specific requirements
    if (
      ["SELECT", "MULTI_SELECT", "STATUS"].includes(data.type) &&
      (!data.data || data.data.length === 0)
    ) {
      throw new ValidationError(
        `${data.type} field requires at least one option`,
      );
    }
  }

  /**
   * Validate multiple fields
   */
  private validateFields(fields: BoardField[]): void {
    // Check for duplicate field names
    const names = fields.map((f) => f.name.toLowerCase());
    const duplicates = names.filter(
      (name, index) => names.indexOf(name) !== index,
    );
    if (duplicates.length > 0) {
      throw new ValidationError(
        `Duplicate field names: ${duplicates.join(", ")}`,
      );
    }

    // Validate each field
    fields.forEach((field) => {
      this.validateFieldData(field);
    });

    // Check for multiple unique identifiers
    const uniqueIdentifiers = fields.filter((f) => f.isUniqueIdentifier);
    if (uniqueIdentifiers.length > 1) {
      throw new ValidationError(
        "Board cannot have multiple unique identifier fields",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Attach / detach an existing board as a TableInTable child of another.
  //
  // Ports `attachBoardAsChild` / `detachChildBoard` from the legacy Mongo
  // service (`be and IPS/backend/src/core/services/board_services.js` lines
  // 728-1009). Postgres-only — uses Drizzle transactions for atomicity, so the
  // legacy fallback for non-replica-set Mongo is dropped.
  // ---------------------------------------------------------------------------

  /**
   * Wrap an existing standalone board as a TableInTable child of another board.
   *
   * Validation is strict-mode (matches legacy): every existing item of the
   * child board MUST appear in `itemMapping`, otherwise `UNMAPPED_CHILD_ITEMS`
   * is raised. The mutation runs inside a single Drizzle transaction so a
   * failure mid-flight rolls back the new field, the provenance stamp, the
   * jsonb edits on parent items, the table_in_columns rows, and the
   * `related_board_item_id` writes on child items together.
   */
  async attachChild(input: {
    parentBoardId: string;
    childBoardId: string;
    fieldName: string;
    itemMapping: Array<{ parent_item_id: string; child_item_ids: string[] }>;
    organizationId: string;
    userId?: string;
  }): Promise<{
    parent_board_id: string;
    child_board_id: string;
    new_field_id: string;
    field_name: string;
    mapped_items: number;
    inserted_edges: number;
  }> {
    const {
      parentBoardId,
      childBoardId,
      fieldName,
      itemMapping,
      organizationId,
      userId,
    } = input;

    if (!parentBoardId || !childBoardId) {
      throw new AttachDetachError(
        "MISSING_BOARD_IDS",
        "parent_board_id and child_board_id are required",
        400,
      );
    }
    if (!fieldName || !fieldName.trim()) {
      throw new AttachDetachError(
        "MISSING_FIELD_NAME",
        "field_name is required",
        400,
      );
    }
    if (parentBoardId === childBoardId) {
      throw new AttachDetachError(
        "SAME_BOARD",
        "Cannot attach a board as a child of itself",
        400,
      );
    }

    const [parentBoard, childBoard] = await Promise.all([
      this.repository.findById(parentBoardId),
      this.repository.findById(childBoardId),
    ]);
    if (!parentBoard || parentBoard.organization_id !== organizationId) {
      throw new AttachDetachError(
        "PARENT_BOARD_NOT_FOUND",
        "Parent board not found",
        404,
      );
    }
    if (!childBoard || childBoard.organization_id !== organizationId) {
      throw new AttachDetachError(
        "CHILD_BOARD_NOT_FOUND",
        "Child board not found",
        404,
      );
    }
    if (childBoard.is_child_table) {
      throw new AttachDetachError(
        "CHILD_ALREADY_NESTED",
        "Child board is already a nested table",
        409,
      );
    }
    if (parentBoard.business_unit_id !== childBoard.business_unit_id) {
      throw new AttachDetachError(
        "DIFFERENT_BU",
        "Parent and child boards belong to different business units",
        400,
      );
    }
    if (
      (parentBoard.fields || []).some(
        (f) => !f.isDeprecated && f.name === fieldName,
      )
    ) {
      throw new AttachDetachError(
        "FIELD_NAME_TAKEN",
        `Field "${fieldName}" already exists on parent`,
        409,
      );
    }
    const alreadyAttached = (parentBoard.fields || []).some(
      (f) =>
        !f.isDeprecated &&
        f.type === BoardFieldType.TABLE_IN_TABLE &&
        f.settings?.childBoardId === childBoardId,
    );
    if (alreadyAttached) {
      throw new AttachDetachError(
        "ALREADY_ATTACHED",
        "Parent already has a TableInTable field pointing to this child",
        409,
      );
    }

    // Validate item_mapping shape + dedupe child IDs across entries.
    if (!Array.isArray(itemMapping)) {
      throw new AttachDetachError(
        "INVALID_MAPPING",
        "item_mapping must be an array",
        400,
      );
    }
    const childToParent = new Map<string, string>();
    const parentItemIds = new Set<string>();
    const mappedChildIds: string[] = [];
    for (const entry of itemMapping) {
      if (
        !entry ||
        !entry.parent_item_id ||
        !Array.isArray(entry.child_item_ids)
      ) {
        throw new AttachDetachError(
          "INVALID_MAPPING_ENTRY",
          "Each mapping entry needs parent_item_id + child_item_ids[]",
          400,
        );
      }
      parentItemIds.add(entry.parent_item_id);
      for (const cid of entry.child_item_ids) {
        if (!cid) continue;
        if (
          childToParent.has(cid) &&
          childToParent.get(cid) !== entry.parent_item_id
        ) {
          throw new AttachDetachError(
            "DUPLICATE_CHILD_ASSIGNMENT",
            `Child item ${cid} is assigned to multiple parents`,
            400,
            { child_item_id: cid },
          );
        }
        childToParent.set(cid, entry.parent_item_id);
        mappedChildIds.push(cid);
      }
    }

    // Verify parent items belong to parent board.
    if (parentItemIds.size > 0) {
      const count = await this.db.count("board_items", {
        id: { $in: Array.from(parentItemIds) },
        board_id: parentBoardId,
      });
      if (count !== parentItemIds.size) {
        throw new AttachDetachError(
          "INVALID_PARENT_ITEM",
          "One or more parent_item_id do not belong to parent board",
          400,
        );
      }
    }

    // Verify mapped child items belong to child board.
    const uniqueMappedChildIds = Array.from(new Set(mappedChildIds));
    if (uniqueMappedChildIds.length > 0) {
      const count = await this.db.count("board_items", {
        id: { $in: uniqueMappedChildIds },
        board_id: childBoardId,
      });
      if (count !== uniqueMappedChildIds.length) {
        throw new AttachDetachError(
          "INVALID_CHILD_ITEM",
          "One or more child_item_ids do not belong to child board",
          400,
        );
      }
    }

    // Strict mode: every child item must be referenced in the mapping.
    const allChildItems = await this.db.findMany<{ id: string; _id?: string }>(
      "board_items",
      { board_id: childBoardId },
    );
    const allChildIds = allChildItems.map((d) => d.id || (d._id as string));
    const mappedSet = new Set(uniqueMappedChildIds);
    const unmapped = allChildIds.filter((id) => !mappedSet.has(id));
    if (unmapped.length > 0) {
      throw new AttachDetachError(
        "UNMAPPED_CHILD_ITEMS",
        `${unmapped.length} child item(s) not included in item_mapping`,
        400,
        { unmapped_item_ids: unmapped.slice(0, 50) },
      );
    }

    // Mutation phase: single transaction for atomicity.
    const drizzleDb = this.getDrizzle();
    const actor = userId || "System";
    const newFieldId = crypto.randomUUID();
    const now = new Date();

    const newField: BoardField = {
      id: newFieldId,
      name: fieldName,
      type: BoardFieldType.TABLE_IN_TABLE,
      isUniqueIdentifier: false,
      isDefault: false,
      hidden: false,
      hiddenOnRecord: false,
      isIdentifier: false,
      isDeprecated: false,
      data: [{ id: childBoardId, value: childBoardId }],
      settings: {
        childBoardId: childBoardId,
        childBoardName: childBoard.name,
      },
      order: parentBoard.fields.length,
    };

    const insertedEdges = await drizzleDb.transaction(async (tx) => {
      // 1. Append the new TIT field to parent.fields[].
      const parentFields = [...parentBoard.fields, newField];
      await tx
        .update(schema.boards)
        .set({ fields: parentFields, updated_at: now })
        .where(eq(schema.boards.id, parentBoardId));

      // 2. Mark child as nested + stamp provenance.
      const attachedFrom: BoardAttachedFrom = {
        parent_board_id: parentBoardId,
        parent_board_field_id: newFieldId,
        attached_at: now,
        attached_by: actor,
      };
      await tx
        .update(schema.boards)
        .set({
          is_child_table: true,
          attached_from: attachedFrom,
          updated_at: now,
        })
        .where(eq(schema.boards.id, childBoardId));

      // 3. Update parent BoardItem.fields[newFieldId] = child_item_ids.
      //    JSONB merge keeps any other field values intact.
      const edgeRows: Array<typeof schema.tableInColumns.$inferInsert> = [];
      for (const entry of itemMapping) {
        const childIds = entry.child_item_ids || [];
        const patch = JSON.stringify({ [newFieldId]: childIds });
        await tx
          .update(schema.boardItems)
          .set({
            fields: sql`${schema.boardItems.fields} || ${patch}::jsonb`,
            updated_at: now,
          })
          .where(
            and(
              eq(schema.boardItems.id, entry.parent_item_id),
              eq(schema.boardItems.board_id, parentBoardId),
            ),
          );
        for (const cid of childIds) {
          edgeRows.push({
            parent_board_id: parentBoardId,
            parent_board_item_id: entry.parent_item_id,
            parent_board_field_id: newFieldId,
            child_board_id: childBoardId,
            child_board_item_id: cid,
            created_by: actor,
            updated_by: actor,
          });
        }
      }

      // 4. Bulk insert table_in_columns edges.
      if (edgeRows.length > 0) {
        await tx.insert(schema.tableInColumns).values(edgeRows);
      }

      // 5. Stamp related_board_item_id on each linked child item.
      for (const entry of itemMapping) {
        if (!entry.child_item_ids || entry.child_item_ids.length === 0)
          continue;
        await tx
          .update(schema.boardItems)
          .set({
            related_board_item_id: entry.parent_item_id,
            updated_at: now,
          })
          .where(
            and(
              inArray(schema.boardItems.id, entry.child_item_ids),
              eq(schema.boardItems.board_id, childBoardId),
            ),
          );
      }

      return edgeRows.length;
    });

    logger.info(
      `Attached child ${childBoardId} to parent ${parentBoardId} via field ${newFieldId} (${insertedEdges} edges)`,
    );

    return {
      parent_board_id: parentBoardId,
      child_board_id: childBoardId,
      new_field_id: newFieldId,
      field_name: fieldName,
      mapped_items: itemMapping.length,
      inserted_edges: insertedEdges,
    };
  }

  /**
   * Reverse of `attachChild`. Removes the parent's TIT field entirely (same as
   * a normal column delete — no `_deprecated_attached_*` tombstone is left
   * behind), deletes the corresponding `table_in_columns` rows, clears
   * `related_board_item_id` on child items, and clears `attached_from` on the
   * child board. When `restoreAsIndependent` is true (default) the child board
   * also flips `is_child_table=false` so it surfaces in standalone listings.
   */
  async detachChild(input: {
    parentBoardId: string;
    childBoardId: string;
    organizationId: string;
    restoreAsIndependent?: boolean;
  }): Promise<{
    parent_board_id: string;
    child_board_id: string;
    deprecated_field_id: string;
    deprecated_field_name: string;
    deleted_edges: number;
    restored_as_independent: boolean;
  }> {
    const {
      parentBoardId,
      childBoardId,
      organizationId,
      restoreAsIndependent = true,
    } = input;

    if (!parentBoardId || !childBoardId) {
      throw new AttachDetachError(
        "MISSING_BOARD_IDS",
        "parent_board_id and child_board_id are required",
        400,
      );
    }

    const [parentBoard, childBoard] = await Promise.all([
      this.repository.findById(parentBoardId),
      this.repository.findById(childBoardId),
    ]);
    if (!parentBoard || parentBoard.organization_id !== organizationId) {
      throw new AttachDetachError(
        "PARENT_BOARD_NOT_FOUND",
        "Parent board not found",
        404,
      );
    }
    if (!childBoard || childBoard.organization_id !== organizationId) {
      throw new AttachDetachError(
        "CHILD_BOARD_NOT_FOUND",
        "Child board not found",
        404,
      );
    }
    if (!childBoard.is_child_table) {
      throw new AttachDetachError(
        "CHILD_NOT_NESTED",
        "Child board is not currently nested",
        409,
      );
    }

    const targetField = (parentBoard.fields || []).find(
      (f) =>
        !f.isDeprecated &&
        f.type === BoardFieldType.TABLE_IN_TABLE &&
        f.settings?.childBoardId === childBoardId,
    );
    if (!targetField) {
      throw new AttachDetachError(
        "NOT_ATTACHED",
        "Parent has no active TableInTable field pointing to this child",
        409,
      );
    }
    const targetFieldId = targetField.id;
    const removedFieldName = targetField.name;

    const drizzleDb = this.getDrizzle();
    const now = new Date();

    const deletedEdges = await drizzleDb.transaction(async (tx) => {
      // 1. Remove the parent TIT field entirely (mirrors `deleteField`), so no
      //    `_deprecated_attached_*` tombstone lingers on the board.
      const updatedParentFields = parentBoard.fields.filter(
        (f) => f.id !== targetFieldId,
      );
      await tx
        .update(schema.boards)
        .set({ fields: updatedParentFields, updated_at: now })
        .where(eq(schema.boards.id, parentBoardId));

      // 2. Delete table_in_columns edges for this attachment.
      const deleted = await tx
        .delete(schema.tableInColumns)
        .where(
          and(
            eq(schema.tableInColumns.parent_board_id, parentBoardId),
            eq(schema.tableInColumns.parent_board_field_id, targetFieldId),
            eq(schema.tableInColumns.child_board_id, childBoardId),
          ),
        )
        .returning({ id: schema.tableInColumns.id });

      // 3. Clear related_board_item_id on every child item of this child board.
      await tx
        .update(schema.boardItems)
        .set({ related_board_item_id: null, updated_at: now })
        .where(
          and(
            eq(schema.boardItems.board_id, childBoardId),
            sql`${schema.boardItems.related_board_item_id} IS NOT NULL`,
          ),
        );

      // 4. Clear attached_from + optionally restore child as independent.
      await tx
        .update(schema.boards)
        .set({
          attached_from: null,
          ...(restoreAsIndependent ? { is_child_table: false } : {}),
          updated_at: now,
        })
        .where(eq(schema.boards.id, childBoardId));

      return deleted.length;
    });

    logger.info(
      `Detached child ${childBoardId} from parent ${parentBoardId}: removed field ${targetFieldId}, removed ${deletedEdges} edges`,
    );

    return {
      parent_board_id: parentBoardId,
      child_board_id: childBoardId,
      deprecated_field_id: targetFieldId,
      deprecated_field_name: removedFieldName,
      deleted_edges: deletedEdges,
      restored_as_independent: !!restoreAsIndependent,
    };
  }
}
