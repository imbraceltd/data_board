/**
 * BoardItem Repository Interface
 *
 * Defines the contract for BoardItem data access operations
 * Implementations: MongoDBBoardItemRepository, DrizzleBoardItemRepository
 */

import type {
  BoardItem,
  PaginatedResult,
  QueryOptions,
  CreateBoardItemDTO,
  UpdateBoardItemDTO,
  TableInColumn,
  CreateTableInColumnDTO,
} from "../shared/board-item.types";

export interface IBoardItemRepository {
  /**
   * Find board item by ID
   */
  findById(id: string): Promise<BoardItem | null>;

  /**
   * Find board items by board ID with pagination and filtering
   */
  findByBoard(
    boardId: string,
    options: QueryOptions,
  ): Promise<PaginatedResult<BoardItem>>;

  /**
   * Find board items by filter
   */
  findByFilter(
    boardId: string,
    filter: Record<string, any>,
    options: QueryOptions,
  ): Promise<PaginatedResult<BoardItem>>;

  /**
   * Find board item by contact ID
   */
  findByContactId(contactId: string): Promise<BoardItem | null>;

  /**
   * Create a new board item
   */
  create(data: CreateBoardItemDTO): Promise<BoardItem>;

  /**
   * Create multiple board items
   */
  createMultiple(items: CreateBoardItemDTO[]): Promise<BoardItem[]>;

  /**
   * Update board item by ID
   */
  update(id: string, data: UpdateBoardItemDTO): Promise<BoardItem>;

  /**
   * Update board items by filter
   */
  updateByFilter(
    boardId: string,
    filter: Record<string, any>,
    updates: Record<string, any>,
  ): Promise<number>;

  /**
   * Update multiple board items by IDs
   */
  updateMultiple(ids: string[], updates: Record<string, any>): Promise<number>;

  /**
   * Delete board item by ID
   */
  delete(id: string): Promise<void>;

  /**
   * Delete board items by filter
   */
  deleteByFilter(boardId: string, filter: Record<string, any>): Promise<number>;

  /**
   * Delete multiple board items by IDs
   */
  deleteMultiple(ids: string[]): Promise<number>;

  /**
   * Link related board items
   */
  linkRelatedItems(
    itemId: string,
    relatedBoardId: string,
    relatedItemIds: string[],
  ): Promise<void>;

  /**
   * Unlink related board items
   */
  unlinkRelatedItems(
    itemId: string,
    relatedBoardId: string,
    relatedItemIds: string[],
  ): Promise<void>;

  /**
   * Get related board items
   */
  getRelatedItems(itemId: string, relatedBoardId: string): Promise<BoardItem[]>;

  /**
   * Count board items
   */
  count(boardId: string, filter?: Record<string, any>): Promise<number>;

  /**
   * Check if board item exists
   */
  exists(id: string): Promise<boolean>;
}

/**
 * TableInColumns Repository Interface
 */
export interface ITableInColumnsRepository {
  /**
   * Create table in column relationship
   */
  create(data: CreateTableInColumnDTO): Promise<TableInColumn>;

  /**
   * Find by parent board item and field
   */
  findByParent(
    parentBoardItemId: string,
    parentFieldId: string,
  ): Promise<TableInColumn[]>;

  /**
   * Find by child board item
   */
  findByChild(childBoardItemId: string): Promise<TableInColumn | null>;

  /**
   * Delete by parent
   */
  deleteByParent(
    parentBoardItemId: string,
    parentFieldId: string,
  ): Promise<number>;

  /**
   * Delete by child
   */
  deleteByChild(childBoardItemId: string): Promise<void>;
}
