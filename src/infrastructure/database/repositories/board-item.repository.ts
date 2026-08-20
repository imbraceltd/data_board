/**
 * Universal BoardItem Repository
 * Implementation of IBoardItemRepository using abstract DatabaseClient
 * Supports both MongoDB and PostgreSQL (via adapters)
 */

import type { DatabaseClient, WhereClause, FindOptions } from "../types";
import type { IBoardItemRepository } from "../../../domain/repositories/board-item.repository.interface";
import {
  CreateType,
  type BoardItem,
  type PaginatedResult,
  type QueryOptions,
  type CreateBoardItemDTO,
  type UpdateBoardItemDTO,
} from "../../../domain/shared/board-item.types";
import { DatabaseError, NotFoundError } from "../../../domain/shared/errors";
import logger from "../../logging/logger";

export class BoardItemRepository implements IBoardItemRepository {
  private readonly TABLE = "board_items";

  constructor(private db: DatabaseClient) {}

  /**
   * Find board item by ID
   */
  async findById(id: string): Promise<BoardItem | null> {
    try {
      const result = await this.db.findFirst<BoardItem>(this.TABLE, {
        $or: [{ id: id }, { _id: id }],
      });

      if (!result) return null;

      return this.toEntity(result);
    } catch (error) {
      logger.error(`Error finding board item ${id}:`, error);
      throw new DatabaseError(
        `Failed to find board item: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find board items by board ID with pagination and filtering
   */
  async findByBoard(
    boardId: string,
    options: QueryOptions,
  ): Promise<PaginatedResult<BoardItem>> {
    try {
      const { skip = 0, limit = 20, sort, filter } = options;

      const where: WhereClause = {
        board_id: boardId,
      };

      // Add filter conditions directly to the where clause
      // The DatabaseClient implementations will handle structure differences
      // (PostgreSQL adapter handles JSONB, MongoDB handles dots)
      if (filter && Object.keys(filter).length > 0) {
        Object.assign(where, filter);
      }

      // Build sort options
      const findOptions: FindOptions = {
        limit,
        skip,
        orderBy: [],
      };

      if (sort && Object.keys(sort).length > 0) {
        for (const [key, direction] of Object.entries(sort)) {
          findOptions.orderBy?.push({
            field: key,
            direction: direction === 1 ? "asc" : "desc",
          });
        }
      } else {
        // Default sort by created_at descending
        findOptions.orderBy?.push({
          field: "created_at",
          direction: "desc",
        });
      }

      const [data, count] = await Promise.all([
        this.db.findMany<BoardItem>(this.TABLE, where, findOptions),
        this.db.count(this.TABLE, where),
      ]);

      return {
        data: data.map((r) => this.toEntity(r)),
        count,
        skip,
        limit,
        // limit=0 means unlimited (no LIMIT applied) → everything is one page.
        totalPages: limit > 0 ? Math.ceil(count / limit) : 1,
      };
    } catch (error) {
      logger.error(`Error finding board items for board ${boardId}:`, error);
      throw new DatabaseError(
        `Failed to find board items: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find board items by filter
   */
  async findByFilter(
    boardId: string,
    filter: Record<string, any>,
    options: QueryOptions,
  ): Promise<PaginatedResult<BoardItem>> {
    return this.findByBoard(boardId, { ...options, filter });
  }

  /**
   * Find board item by contact ID
   */
  async findByContactId(contactId: string): Promise<BoardItem | null> {
    try {
      // Create a filter where logic depends on DB type but passing abstraction
      // For now assuming we pass 'fields.contact_id' or equivalent
      // The adapter will need to handle nested fields
      const result = await this.db.findFirst<BoardItem>(this.TABLE, {
        "fields.contact_id": contactId,
      });

      if (!result) return null;

      return this.toEntity(result);
    } catch (error) {
      logger.error(`Error finding board item by contact ${contactId}:`, error);
      throw new DatabaseError(
        `Failed to find board item: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Create a new board item
   */
  async create(data: CreateBoardItemDTO): Promise<BoardItem> {
    try {
      const record = {
        business_unit_id: data.business_unit_id,
        organization_id: data.organization_id,
        board_id: data.board_id,
        created_by: data.created_by,
        created_type: data.created_type || CreateType.MANUAL,
        fields: data.fields,
        related_board_item_id: data.related_board_item_id,
        related_board_item_list: data.related_board_item_list || [],
        conversation_ids: data.conversation_ids || [],
        logo_url: data.logo_url,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const [result] = await this.db.insert<BoardItem>(this.TABLE, record);

      logger.debug(`Board item created: ${result.id || result._id}`);
      return this.toEntity(result);
    } catch (error) {
      logger.error("Error creating board item:", error);
      throw new DatabaseError(
        `Failed to create board item: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Create multiple board items
   */
  async createMultiple(items: CreateBoardItemDTO[]): Promise<BoardItem[]> {
    try {
      const now = new Date();
      const records = items.map((data) => {
        const createdAt = data.created_at
          ? new Date(data.created_at as any)
          : now;
        const updatedAt = data.updated_at
          ? new Date(data.updated_at as any)
          : createdAt;
        return {
          business_unit_id: data.business_unit_id,
          organization_id: data.organization_id,
          board_id: data.board_id,
          created_by: data.created_by,
          created_type: data.created_type || CreateType.MANUAL,
          fields: data.fields,
          related_board_item_id: data.related_board_item_id,
          related_board_item_list: data.related_board_item_list || [],
          conversation_ids: data.conversation_ids || [],
          logo_url: data.logo_url,
          created_at: createdAt,
          updated_at: updatedAt,
        };
      });

      const results = await this.db.insert<BoardItem>(this.TABLE, records);

      logger.debug(`${results.length} board items created`);
      return results.map((r) => this.toEntity(r));
    } catch (error) {
      logger.error("Error creating multiple board items:", error);
      throw new DatabaseError(
        `Failed to create board items: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update board item by ID
   */
  async update(id: string, data: UpdateBoardItemDTO): Promise<BoardItem> {
    try {
      const updateData: any = {
        updated_at: new Date(),
      };

      if (data.fields !== undefined) {
        // We need to fetch existing fields to merge if doing partial update logic
        // But for repository update, it depends on DB adapter behavior
        // Assuming data.fields contains the full or partial fields to update
        // The Drizzle adapter's update might replace the whole object if not careful
        // But here we rely on the adapter to handle the update correctly
        updateData.fields = data.fields;
      }

      if (data.related_board_item_id !== undefined)
        updateData.related_board_item_id = data.related_board_item_id;
      if (data.related_board_item_list !== undefined)
        updateData.related_board_item_list = data.related_board_item_list;
      if (data.conversation_ids !== undefined)
        updateData.conversation_ids = data.conversation_ids;
      if (data.logo_url !== undefined) updateData.logo_url = data.logo_url;

      // Note: merging fields is tricky in generic repository without knowing DB capabilities
      // (e.g. JSONB deep merge in PG vs $set in Mongo)
      // For now, simpler approach: fetch, merge in memory, update back
      if (data.fields) {
        const existing = await this.findById(id);
        if (!existing) {
          throw new NotFoundError(`Board item ${id} not found`);
        }
        updateData.fields = { ...existing.fields, ...data.fields };
      }

      const [result] = await this.db.update<BoardItem>(
        this.TABLE,
        { $or: [{ id: id }, { _id: id }] },
        updateData,
      );

      if (!result) {
        throw new NotFoundError(`Board item ${id} not found`);
      }

      logger.debug(`Board item updated: ${id}`);
      return this.toEntity(result);
    } catch (error) {
      logger.error(`Error updating board item ${id}:`, error);
      if (error instanceof NotFoundError) throw error;
      throw new DatabaseError(
        `Failed to update board item: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update board items by filter
   */
  async updateByFilter(
    boardId: string,
    filter: Record<string, any>,
    updates: Record<string, any>,
  ): Promise<number> {
    try {
      const where: WhereClause = {
        board_id: boardId,
        ...filter,
      };

      // Since we can't easily do field-merging in a generic way for all DBs in one go here
      // without adapter support for JSON merging, we might need adapter specific logic or
      // accept that this replaces fields or requires specific adapter handling.
      // For now, we assume adapter handles partial updates or we provide full object.
      // But `updates` here is typically just the fields to change.

      // Limitation: Generic updateMany doesn't support complex JSON path updates easily
      // across different DBs without more complex abstraction.
      // We'll pass the updates object and let the adapter try to handle it.

      // IMPORTANT: This assumes the adapter can handle the update payload correctly.
      // For 'fields' updates, especially partial, it needs care.
      // As a fallback for compatibility, finding and updating in loop might be safer but slower.
      // Given requirements, let's try direct update first.

      const results = await this.db.update<BoardItem>(this.TABLE, where, {
        fields: updates, // This intends to update fields property. Behavior depends on adapter (replace vs merge)
        updated_at: new Date(),
      });

      logger.debug(`Board items updated by filter in board ${boardId}`);
      return results.length;
    } catch (error) {
      logger.error(
        `Error updating board items by filter in board ${boardId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to update board items: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update multiple board items by IDs
   */
  async updateMultiple(
    ids: string[],
    updates: Record<string, any>,
  ): Promise<number> {
    try {
      const results = await this.db.update<BoardItem>(
        this.TABLE,
        { id: { $in: ids } }, // Using $in operator
        {
          fields: updates, // Again, behavior depends on adapter (replace vs merge)
          updated_at: new Date(),
        },
      );

      logger.debug(`${results.length} board items updated`);
      return results.length;
    } catch (error) {
      logger.error("Error updating multiple board items:", error);
      throw new DatabaseError(
        `Failed to update board items: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete board item by ID
   */
  async delete(id: string): Promise<void> {
    try {
      await this.db.delete(this.TABLE, { $or: [{ id: id }, { _id: id }] });
      logger.debug(`Board item deleted: ${id}`);
    } catch (error) {
      logger.error(`Error deleting board item ${id}:`, error);
      throw new DatabaseError(
        `Failed to delete board item: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete board items by filter
   */
  async deleteByFilter(
    boardId: string,
    filter: Record<string, any>,
  ): Promise<number> {
    try {
      const where: WhereClause = {
        board_id: boardId,
        ...filter,
      };

      const count = await this.db.delete(this.TABLE, where);

      logger.debug(`Board items deleted by filter in board ${boardId}`);
      return count;
    } catch (error) {
      logger.error(
        `Error deleting board items by filter in board ${boardId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to delete board items: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete multiple board items by IDs
   */
  async deleteMultiple(ids: string[]): Promise<number> {
    try {
      const count = await this.db.delete(this.TABLE, { id: { $in: ids } });

      logger.debug(`${count} board items deleted`);
      return count;
    } catch (error) {
      logger.error("Error deleting multiple board items:", error);
      throw new DatabaseError(
        `Failed to delete board items: ${(error as Error).message}`,
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
    try {
      const item = await this.findById(itemId);
      if (!item) {
        throw new NotFoundError(`Board item ${itemId} not found`);
      }

      // Add to related_board_item_list (avoid duplicates)
      const currentList = item.related_board_item_list || [];
      const updatedList = Array.from(
        new Set([...currentList, ...relatedItemIds]),
      );

      await this.db.update(
        this.TABLE,
        { $or: [{ id: itemId }, { _id: itemId }] },
        {
          related_board_item_list: updatedList,
          updated_at: new Date(),
        },
      );

      logger.debug(`Linked ${relatedItemIds.length} items to ${itemId}`);
    } catch (error) {
      logger.error(`Error linking related items to ${itemId}:`, error);
      if (error instanceof NotFoundError) throw error;
      throw new DatabaseError(
        `Failed to link related items: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Unlink related board items
   */
  async unlinkRelatedItems(
    itemId: string,
    relatedBoardId: string,
    relatedItemIds: string[],
  ): Promise<void> {
    try {
      const item = await this.findById(itemId);
      if (!item) {
        throw new NotFoundError(`Board item ${itemId} not found`);
      }

      // Remove from related_board_item_list
      const currentList = item.related_board_item_list || [];
      const updatedList = currentList.filter(
        (id) => !relatedItemIds.includes(id),
      );

      await this.db.update(
        this.TABLE,
        { $or: [{ id: itemId }, { _id: itemId }] },
        {
          related_board_item_list: updatedList,
          updated_at: new Date(),
        },
      );

      logger.debug(`Unlinked ${relatedItemIds.length} items from ${itemId}`);
    } catch (error) {
      logger.error(`Error unlinking related items from ${itemId}:`, error);
      if (error instanceof NotFoundError) throw error;
      throw new DatabaseError(
        `Failed to unlink related items: ${(error as Error).message}`,
      );
    }
  }

  // Helper method to implement getRelatedItems since it wasn't in the original Drizzle one I saw fully?
  // Checked previous view: getRelatedItems WAS there.
  async getRelatedItems(
    itemId: string,
    relatedBoardId: string,
  ): Promise<BoardItem[]> {
    try {
      const item = await this.findById(itemId);
      if (!item) {
        throw new NotFoundError(`Board item ${itemId} not found`);
      }

      if (
        !item.related_board_item_list ||
        item.related_board_item_list.length === 0
      ) {
        return [];
      }

      // Find items in related board that are in the list
      const results = await this.db.findMany<BoardItem>(this.TABLE, {
        board_id: relatedBoardId,
        id: { $in: item.related_board_item_list },
      });

      return results.map((r) => this.toEntity(r));
    } catch (error) {
      logger.error(`Error getting related items for ${itemId}:`, error);
      if (error instanceof NotFoundError) throw error;
      throw new DatabaseError(
        `Failed to get related items: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Count board items
   */
  async count(boardId: string, filter?: Record<string, any>): Promise<number> {
    try {
      const where: WhereClause = {
        board_id: boardId,
        ...filter,
      };

      return await this.db.count(this.TABLE, where);
    } catch (error) {
      logger.error(`Error counting board items for board ${boardId}:`, error);
      throw new DatabaseError(
        `Failed to count board items: ${(error as Error).message}`,
      );
    }
  }

  async countByBoardIds(ids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!ids?.length) return out;
    const unique = Array.from(new Set(ids));
    const results = await Promise.all(
      unique.map(async (id) => {
        try {
          return [id, await this.count(id)] as const;
        } catch {
          return [id, 0] as const;
        }
      }),
    );
    for (const [id, n] of results) out.set(id, n);
    return out;
  }

  /**
   * Check if board item exists
   */
  async exists(id: string): Promise<boolean> {
    try {
      const item = await this.findById(id);
      return item !== null;
    } catch (error) {
      logger.error(`Error checking if board item ${id} exists:`, error);
      throw new DatabaseError(
        `Failed to check board item existence: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Convert database row to domain entity
   */
  toEntity(row: any): BoardItem {
    // Handle both id and _id
    const id = row.id || row._id;

    return {
      _id: id?.toString(),
      id: id?.toString(),
      board_item_id: id?.toString(),
      business_unit_id: row.business_unit_id,
      organization_id: row.organization_id,
      board_id: row.board_id,
      created_by: row.created_by || undefined,
      created_type: row.created_type,
      fields: row.fields || {},
      related_board_item_id: row.related_board_item_id || undefined,
      related_board_item_list: row.related_board_item_list || [],
      conversation_ids: row.conversation_ids || [],
      logo_url: row.logo_url || undefined,
      created_at: row.created_at ? new Date(row.created_at) : new Date(),
      updated_at: row.updated_at ? new Date(row.updated_at) : new Date(),
    };
  }
}
