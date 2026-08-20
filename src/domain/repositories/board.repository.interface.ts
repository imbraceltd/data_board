/**
 * Board Repository Interface
 *
 * Defines the contract for Board data access operations
 * Implementations: MongoDBBoardRepository, DrizzleBoardRepository
 */

import type {
  Board,
  BoardField,
  BoardFilters,
  CreateBoardDTO,
  UpdateBoardDTO,
  CreateBoardFieldDTO,
  UpdateBoardFieldDTO,
} from "../shared/board.types";

export interface IBoardRepository {
  /**
   * Find board by ID
   */
  findById(id: string): Promise<Board | null>;

  /**
   * Find boards by organization
   */
  findByOrganization(orgId: string, filters?: BoardFilters): Promise<Board[]>;

  /**
   * Find boards with team access filtering
   */
  findByTeamAccess(
    orgId: string,
    teamIds: string[],
    filters?: BoardFilters,
  ): Promise<Board[]>;

  /**
   * Find board by type
   */
  findByType(orgId: string, type: string): Promise<Board[]>;

  /**
   * Create a new board
   */
  create(data: CreateBoardDTO): Promise<Board>;

  /**
   * Update board metadata
   */
  update(id: string, data: UpdateBoardDTO): Promise<Board>;

  /**
   * Delete board
   */
  delete(id: string): Promise<void>;

  /**
   * Add field to board
   */
  addField(boardId: string, field: CreateBoardFieldDTO): Promise<Board>;

  /**
   * Update board field
   */
  updateField(
    boardId: string,
    fieldId: string,
    updates: UpdateBoardFieldDTO,
  ): Promise<Board>;

  /**
   * Delete board field
   */
  deleteField(boardId: string, fieldId: string): Promise<Board>;

  /**
   * Reorder board fields
   */
  reorderFields(boardId: string, fieldIds: string[]): Promise<Board>;

  /**
   * Reorder boards
   */
  reorder(boardIds: string[]): Promise<void>;

  /**
   * Check if board exists
   */
  exists(id: string): Promise<boolean>;

  /**
   * Count boards
   */
  count(orgId: string, filters?: BoardFilters): Promise<number>;
}
