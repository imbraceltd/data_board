/**
 * Universal Board Repository
 * Implementation of IBoardRepository using abstract DatabaseClient
 * Supports both MongoDB and PostgreSQL (via adapters)
 */

import type { DatabaseClient, WhereClause, FindOptions } from "../types";
import type { IBoardRepository } from "../../../domain/repositories/board.repository.interface";
import type {
  Board,
  BoardField,
  BoardFilters,
  CreateBoardDTO,
  UpdateBoardDTO,
  CreateBoardFieldDTO,
  UpdateBoardFieldDTO,
} from "../../../domain/shared/board.types";
import { DatabaseError, NotFoundError } from "../../../domain/shared/errors";
import logger from "../../logging/logger";
import crypto from "crypto";

/**
 * Ensure every option item in a SingleSelection / MultiSelection field's `data`
 * array has a stable, unique id. Inbound payloads from the webapp omit it for
 * newly-added options; the frontend keys dropdown options by `_id`, so without
 * one all options collide on the same React key and only the last one renders.
 *
 * Emits BOTH `id` and `_id` (set to the same value) to match the convention
 * elsewhere in the response — boards and fields are also returned with both
 * properties — so callers reading either accessor work without code changes.
 *
 * Also trims the option `value` — the FE editor lets users paste leading or
 * trailing whitespace into the label, which then propagates into stored
 * board_items (selection fields persist the option value as their stored
 * payload). Trimming at the persistence boundary keeps both the option list
 * and the resolved labels clean without forcing each caller to do it.
 *
 * Kept here (defensive) instead of in the controller so every persistence path
 * — create, addField, updateField — gets consistent treatment.
 */
function withGeneratedDataIds<T extends { data?: any[] }>(field: T): T {
  if (!Array.isArray(field?.data) || field.data.length === 0) return field;
  return {
    ...field,
    data: field.data.map((item: any) => {
      const optionId = item?.id || item?._id || crypto.randomUUID();
      const value =
        typeof item?.value === "string" ? item.value.trim() : item?.value;
      return { ...item, id: optionId, _id: optionId, value };
    }),
  };
}

function normalizeFieldsDataIds(fields: BoardField[] | undefined): BoardField[] | undefined {
  return Array.isArray(fields) ? fields.map(withGeneratedDataIds) : fields;
}

export class BoardRepository implements IBoardRepository {
  private readonly TABLE = "boards";

  constructor(private db: DatabaseClient) {}

  /**
   * Find board by ID
   */
  async findById(id: string): Promise<Board | null> {
    try {
      const result = await this.db.findFirst<Board>(this.TABLE, {
        $or: [{ id: id }, { _id: id }],
      });

      if (!result) return null;

      return this.toEntity(result);
    } catch (error) {
      logger.error(`Error finding board ${id}:`, error);
      throw new DatabaseError(
        `Failed to find board: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find boards by organization with filters
   */
  async findByOrganization(
    orgId: string,
    filters?: BoardFilters,
  ): Promise<Board[]> {
    try {
      const where: WhereClause = {
        organization_id: orgId,
      };

      if (filters?.types && filters.types.length > 0) {
        where.type = { $in: filters.types };
      }

      if (filters?.hidden !== undefined) {
        where.hidden = filters.hidden;
      }

      if (filters?.excludeChildTables) {
        where.is_child_table = false;
      }

      if (filters?.search) {
        where.name = { $regex: filters.search, $options: "i" };
      }

      if (filters?.category_id) {
        where.category_id = filters.category_id;
      }

      const options: FindOptions = {
        orderBy: [
          { field: "order", direction: "asc" },
          { field: "created_at", direction: "asc" },
        ],
      };
      if (filters?.limit !== undefined) options.limit = filters.limit;
      if (filters?.skip !== undefined) options.skip = filters.skip;

      const results = await this.db.findMany<Board>(this.TABLE, where, options);
      return results.map((r) => this.toEntity(r));
    } catch (error) {
      logger.error(`Error finding boards for organization ${orgId}:`, error);
      throw new DatabaseError(
        `Failed to find boards: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Batch-load boards by a set of IDs, scoped to one organization.
   * Matches on either the canonical `id` or the legacy `_id` so callers can
   * pass mixed identifiers without pre-normalising. Returns only boards
   * actually found — missing IDs are silently dropped.
   */
  async findByIds(orgId: string, ids: string[]): Promise<Board[]> {
    if (!ids?.length) return [];
    try {
      const where: WhereClause = {
        organization_id: orgId,
        $or: [{ id: { $in: ids } }, { _id: { $in: ids } }],
      };
      const results = await this.db.findMany<Board>(this.TABLE, where);
      return results.map((r) => this.toEntity(r));
    } catch (error) {
      logger.error(`Error batch-loading boards for org ${orgId}:`, error);
      throw new DatabaseError(
        `Failed to batch-load boards: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find boards with team access filtering
   */
  async findByTeamAccess(
    orgId: string,
    teamIds: string[],
    filters?: BoardFilters,
  ): Promise<Board[]> {
    const { data } = await this.findByTeamAccessWithTotal(
      orgId,
      teamIds,
      filters,
    );
    return data;
  }

  /**
   * Same access filtering as findByTeamAccess, but also returns `total` — the
   * number of accessible boards matching the filters BEFORE limit/skip. The
   * list endpoint needs this for server-side pagination: a plain DB COUNT can't
   * see the manager-based access filter, which is applied in JS here.
   */
  async findByTeamAccessWithTotal(
    orgId: string,
    teamIds: string[],
    filters?: BoardFilters,
  ): Promise<{ data: Board[]; total: number }> {
    try {
      const { limit, skip, ...filtersForDb } = filters ?? {};
      const allBoards = await this.findByOrganization(orgId, filtersForDb);

      // A board is accessible if:
      // 1. It has no managers (open to all)
      // 2. User's team is in the managers list
      const accessibleBoards = allBoards.filter((board) => {
        if (!board.managers || board.managers.length === 0) {
          return true; // No restrictions
        }

        return board.managers.some((manager) =>
          teamIds.includes(manager.teamId),
        );
      });

      const effectiveSkip = skip ?? 0;
      const data =
        limit !== undefined
          ? accessibleBoards.slice(effectiveSkip, effectiveSkip + limit)
          : accessibleBoards.slice(effectiveSkip);
      return { data, total: accessibleBoards.length };
    } catch (error) {
      logger.error(
        `Error finding boards with team access for org ${orgId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find boards: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find boards by type
   */
  async findByType(orgId: string, type: string): Promise<Board[]> {
    try {
      const where: WhereClause = {
        organization_id: orgId,
        type: type,
      };

      const options: FindOptions = {
        orderBy: [{ field: "order", direction: "asc" }],
      };

      const results = await this.db.findMany<Board>(this.TABLE, where, options);

      return results.map((r) => this.toEntity(r));
    } catch (error) {
      logger.error(`Error finding boards by type ${type}:`, error);
      throw new DatabaseError(
        `Failed to find boards: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Create a new board
   */
  async create(data: CreateBoardDTO): Promise<Board> {
    try {
      const record = {
        business_unit_id: data.business_unit_id,
        organization_id: data.organization_id,
        name: data.name,
        description: data.description,
        type: data.type,
        order: data.order ?? 0,
        hidden: data.hidden ?? false,
        created_by: data.created_by,
        fields: normalizeFieldsDataIds(data.fields) ?? [],
        managers: data.managers ?? [],
        journey: data.journey,
        show_id: data.show_id ?? false,
        is_child_table: data.is_child_table ?? false,
        from_schema_id: data.from_schema_id ?? null,
        category_id: data.category_id ?? null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const [result] = await this.db.insert<Board>(this.TABLE, record);

      logger.debug(`Board created: ${result.id || result._id}`);
      return this.toEntity(result);
    } catch (error) {
      logger.error("Error creating board:", error);
      throw new DatabaseError(
        `Failed to create board: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update board metadata
   */
  async update(id: string, data: UpdateBoardDTO): Promise<Board> {
    try {
      const updateData: any = {
        updated_at: new Date(),
      };

      if (data.name !== undefined) updateData.name = data.name;
      if (data.description !== undefined)
        updateData.description = data.description;
      if (data.type !== undefined) updateData.type = data.type;
      if (data.order !== undefined) updateData.order = data.order;
      if (data.hidden !== undefined) updateData.hidden = data.hidden;
      if (data.managers !== undefined) updateData.managers = data.managers;
      if (data.journey !== undefined) updateData.journey = data.journey;
      if (data.show_id !== undefined) updateData.show_id = data.show_id;
      // null clears the category ("uncategorised"); undefined leaves it untouched.
      if (data.category_id !== undefined) updateData.category_id = data.category_id;

      const [result] = await this.db.update<Board>(
        this.TABLE,
        { $or: [{ id: id }, { _id: id }] },
        updateData,
      );

      if (!result) {
        throw new NotFoundError(`Board ${id} not found`);
      }

      logger.debug(`Board updated: ${id}`);
      return this.toEntity(result);
    } catch (error) {
      logger.error(`Error updating board ${id}:`, error);
      if (error instanceof NotFoundError) throw error;
      throw new DatabaseError(
        `Failed to update board: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete board
   */
  async delete(id: string): Promise<void> {
    try {
      await this.db.delete(this.TABLE, { $or: [{ id: id }, { _id: id }] });
      logger.debug(`Board deleted: ${id}`);
    } catch (error) {
      logger.error(`Error deleting board ${id}:`, error);
      throw new DatabaseError(
        `Failed to delete board: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Add field to board
   */
  async addField(boardId: string, field: CreateBoardFieldDTO): Promise<Board> {
    try {
      const board = await this.findById(boardId);
      if (!board) {
        throw new NotFoundError(`Board ${boardId} not found`);
      }

      // Create new field with generated ID. Also auto-generate ids for any
      // option items in `data` that arrived without one (see helper above).
      // `field.id` is honored when present so callers (e.g. the TIT-add flow
      // pinning field.id to the freshly created child board id) can keep
      // the two identifiers in sync.
      const newField: BoardField = withGeneratedDataIds({
        id: (field as any).id || crypto.randomUUID(),
        name: field.name,
        description: field.description,
        type: field.type,
        isUniqueIdentifier: field.isUniqueIdentifier ?? false,
        isDefault: false,
        hidden: field.hidden ?? false,
        hiddenOnRecord: field.hiddenOnRecord ?? false,
        contactField: field.contactField,
        isIdentifier: field.isIdentifier ?? false,
        data: field.data,
        settings: field.settings,
        promptAI: field.promptAI,
        isDeprecated: false,
        order: board.fields.length,
      });

      const updatedFields = [...board.fields, newField];

      const [result] = await this.db.update<Board>(
        this.TABLE,
        { $or: [{ id: boardId }, { _id: boardId }] },
        {
          fields: updatedFields,
          updated_at: new Date(),
        },
      );

      logger.debug(`Field added to board ${boardId}: ${newField.id}`);
      return this.toEntity(result);
    } catch (error) {
      logger.error(`Error adding field to board ${boardId}:`, error);
      if (error instanceof NotFoundError) throw error;
      throw new DatabaseError(
        `Failed to add field: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update board field
   */
  async updateField(
    boardId: string,
    fieldId: string,
    updates: UpdateBoardFieldDTO,
  ): Promise<Board> {
    try {
      const board = await this.findById(boardId);
      if (!board) {
        throw new NotFoundError(`Board ${boardId} not found`);
      }

      const fieldIndex = board.fields.findIndex((f) => f.id === fieldId);
      if (fieldIndex === -1) {
        throw new NotFoundError(`Field ${fieldId} not found in board`);
      }

      // When `updates.data` is provided it fully replaces the option list, so
      // make sure each new option has an id (same reasoning as `addField`).
      const normalizedUpdates = updates.data ? withGeneratedDataIds(updates) : updates;
      const updatedFields = [...board.fields];
      updatedFields[fieldIndex] = {
        ...updatedFields[fieldIndex],
        ...normalizedUpdates,
      };

      const [result] = await this.db.update<Board>(
        this.TABLE,
        { $or: [{ id: boardId }, { _id: boardId }] },
        {
          fields: updatedFields,
          updated_at: new Date(),
        },
      );

      logger.debug(`Field updated in board ${boardId}: ${fieldId}`);
      return this.toEntity(result);
    } catch (error) {
      logger.error(
        `Error updating field ${fieldId} in board ${boardId}:`,
        error,
      );
      if (error instanceof NotFoundError) throw error;
      throw new DatabaseError(
        `Failed to update field: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete board field
   */
  async deleteField(boardId: string, fieldId: string): Promise<Board> {
    try {
      const board = await this.findById(boardId);
      if (!board) {
        throw new NotFoundError(`Board ${boardId} not found`);
      }

      const updatedFields = board.fields.filter((f) => f.id !== fieldId);

      if (updatedFields.length === board.fields.length) {
        throw new NotFoundError(`Field ${fieldId} not found in board`);
      }

      const [result] = await this.db.update<Board>(
        this.TABLE,
        { $or: [{ id: boardId }, { _id: boardId }] },
        {
          fields: updatedFields,
          updated_at: new Date(),
        },
      );

      logger.debug(`Field deleted from board ${boardId}: ${fieldId}`);
      return this.toEntity(result);
    } catch (error) {
      logger.error(
        `Error deleting field ${fieldId} from board ${boardId}:`,
        error,
      );
      if (error instanceof NotFoundError) throw error;
      throw new DatabaseError(
        `Failed to delete field: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Reorder board fields
   */
  async reorderFields(boardId: string, fieldIds: string[]): Promise<Board> {
    try {
      const board = await this.findById(boardId);
      if (!board) {
        throw new NotFoundError(`Board ${boardId} not found`);
      }

      // Create a map of existing fields
      const fieldMap = new Map(board.fields.map((f) => [f.id, f]));

      // Reorder fields based on fieldIds array
      const reorderedFields = fieldIds
        .map((id, index) => {
          const field = fieldMap.get(id);
          if (!field) return null;
          return { ...field, order: index } as BoardField;
        })
        .filter((f): f is BoardField => f !== null);

      // Add any fields that weren't in the fieldIds array at the end
      const includedIds = new Set(fieldIds);
      const remainingFields = board.fields
        .filter((f) => !includedIds.has(f.id))
        .map((f, index) => ({ ...f, order: reorderedFields.length + index }));

      const updatedFields = [...reorderedFields, ...remainingFields];

      const [result] = await this.db.update<Board>(
        this.TABLE,
        { $or: [{ id: boardId }, { _id: boardId }] },
        {
          fields: updatedFields,
          updated_at: new Date(),
        },
      );

      logger.debug(`Fields reordered in board ${boardId}`);
      return this.toEntity(result);
    } catch (error) {
      logger.error(`Error reordering fields in board ${boardId}:`, error);
      if (error instanceof NotFoundError) throw error;
      throw new DatabaseError(
        `Failed to reorder fields: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Reorder boards
   */
  async reorder(boardIds: string[]): Promise<void> {
    try {
      // Update order for each board
      await Promise.all(
        boardIds.map((id, index) =>
          this.db.update<Board>(
            this.TABLE,
            { $or: [{ id: id }, { _id: id }] },
            { order: index, updated_at: new Date() },
          ),
        ),
      );

      logger.debug(`Boards reordered: ${boardIds.length} boards`);
    } catch (error) {
      logger.error("Error reordering boards:", error);
      throw new DatabaseError(
        `Failed to reorder boards: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Check if board exists
   */
  async exists(id: string): Promise<boolean> {
    try {
      const board = await this.findById(id);
      return board !== null;
    } catch (error) {
      logger.error(`Error checking if board ${id} exists:`, error);
      throw new DatabaseError(
        `Failed to check board existence: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Count boards
   */
  async count(orgId: string, filters?: BoardFilters): Promise<number> {
    try {
      const where: WhereClause = {
        organization_id: orgId,
      };

      if (filters?.types && filters.types.length > 0) {
        where.type = { $in: filters.types };
      }

      if (filters?.hidden !== undefined) {
        where.hidden = filters.hidden;
      }

      if (filters?.excludeChildTables) {
        where.is_child_table = false;
      }

      // Mirror findByOrganization's filters so `total` matches the listed page.
      if (filters?.search) {
        where.name = { $regex: filters.search, $options: "i" };
      }

      if (filters?.category_id) {
        where.category_id = filters.category_id;
      }

      return await this.db.count(this.TABLE, where);
    } catch (error) {
      logger.error(`Error counting boards for org ${orgId}:`, error);
      throw new DatabaseError(
        `Failed to count boards: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Convert database row to domain entity
   */
  private toEntity(row: any): Board {
    // In database client abstraction, _id might be mapped to id already
    const id = row.id || row._id;

    return {
      _id: id?.toString(), // Ensure string
      id: id?.toString(),
      business_unit_id: row.business_unit_id,
      organization_id: row.organization_id,
      name: row.name,
      description: row.description || undefined,
      type: row.type,
      order: row.order,
      hidden: row.hidden || false,
      created_by: row.created_by || undefined,
      // Normalize field IDs. Boards migrated from Mongo carry per-field _id
      // only; newer in-service creation assigns id. Populate both so code that
      // checks `f.id` and code that checks `f._id` both work.
      fields: (row.fields || []).map((f: any) => {
        const fieldId = (f.id ?? f._id)?.toString();
        return { ...f, id: fieldId, _id: fieldId };
      }),
      managers: row.managers || [],
      journey: row.journey || undefined,
      show_id: row.show_id || false,
      is_child_table: row.is_child_table || false,
      attached_from: row.attached_from ?? null,
      from_schema_id: row.from_schema_id ?? null,
      category_id: row.category_id ?? null,
      created_at: row.created_at ? new Date(row.created_at) : new Date(),
      updated_at: row.updated_at ? new Date(row.updated_at) : new Date(),
    };
  }
}
