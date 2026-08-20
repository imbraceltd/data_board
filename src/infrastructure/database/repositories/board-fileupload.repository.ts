/**
 * Board File Upload Repository
 *
 * Data access layer for Board File Upload entity
 * Manages file uploads to databoard/AI processing
 */

import { getDatabase } from "../factory";
import type { DatabaseClient, WhereClause, FindOptions } from "../types";
import type { IBoardUploadFile } from "../../../db/models/board-fileupload.model";
import logger from "../../logging/logger";
import { DatabaseError } from "../../../domain/shared/errors";

/**
 * Board File Upload Repository Class
 */
class BoardFileUploadRepository {
  private readonly tableName = "boardFileUpload";

  /**
   * Get database client
   */
  private getDB(): DatabaseClient {
    return getDatabase();
  }

  /**
   * Create a new board file upload
   */
  async create(data: Partial<IBoardUploadFile>): Promise<IBoardUploadFile> {
    try {
      const db = this.getDB();
      const [upload] = await db.insert<IBoardUploadFile>(this.tableName, data);
      logger.debug(`Board file upload created: ${upload._id}`);
      return upload;
    } catch (error) {
      logger.error("Error creating board file upload:", error);
      throw new DatabaseError(
        `Failed to create board file upload: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find upload by ID
   */
  async findById(id: string): Promise<IBoardUploadFile | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IBoardUploadFile>(this.tableName, {
        _id: id,
      } as WhereClause<IBoardUploadFile>);
    } catch (error) {
      logger.error(`Error finding board file upload ${id}:`, error);
      throw new DatabaseError(
        `Failed to find board file upload: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find uploads by query
   */
  async findMany(
    where?: WhereClause<IBoardUploadFile>,
    options?: FindOptions,
  ): Promise<IBoardUploadFile[]> {
    try {
      const db = this.getDB();
      return await db.findMany<IBoardUploadFile>(
        this.tableName,
        where,
        options,
      );
    } catch (error) {
      logger.error("Error finding board file uploads:", error);
      throw new DatabaseError(
        `Failed to find board file uploads: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find uploads by organization ID
   */
  async findByOrganization(
    organizationId: string,
    options?: FindOptions,
  ): Promise<IBoardUploadFile[]> {
    try {
      const where: WhereClause<IBoardUploadFile> = {
        organization_id: organizationId,
      };
      return this.findMany(where, options);
    } catch (error) {
      logger.error(
        `Error finding board file uploads for organization ${organizationId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find uploads: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find uploads by board ID
   */
  async findByBoardId(
    boardId: string,
    options?: FindOptions,
  ): Promise<IBoardUploadFile[]> {
    try {
      const where: WhereClause<IBoardUploadFile> = { board_id: boardId };
      return this.findMany(where, options);
    } catch (error) {
      logger.error(
        `Error finding board file uploads for board ${boardId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find uploads: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find upload by key (storage key)
   */
  async findByKey(key: string): Promise<IBoardUploadFile | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IBoardUploadFile>(this.tableName, {
        key,
      } as WhereClause<IBoardUploadFile>);
    } catch (error) {
      logger.error(`Error finding board file upload by key ${key}:`, error);
      throw new DatabaseError(
        `Failed to find upload: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update upload by ID
   */
  async update(
    id: string,
    data: Partial<IBoardUploadFile>,
  ): Promise<IBoardUploadFile | null> {
    try {
      const db = this.getDB();
      const where: WhereClause<IBoardUploadFile> = { _id: id };
      const [updated] = await db.update<IBoardUploadFile>(
        this.tableName,
        where,
        data,
      );

      if (updated) {
        logger.debug(`Board file upload updated: ${id}`);
      }

      return updated || null;
    } catch (error) {
      logger.error(`Error updating board file upload ${id}:`, error);
      throw new DatabaseError(
        `Failed to update board file upload: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete upload by ID
   */
  async delete(id: string): Promise<boolean> {
    try {
      const db = this.getDB();
      const where: WhereClause<IBoardUploadFile> = { _id: id };
      const deletedCount = await db.delete<IBoardUploadFile>(
        this.tableName,
        where,
      );

      if (deletedCount > 0) {
        logger.debug(`Board file upload deleted: ${id}`);
      }

      return deletedCount > 0;
    } catch (error) {
      logger.error(`Error deleting board file upload ${id}:`, error);
      throw new DatabaseError(
        `Failed to delete board file upload: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete uploads by board ID
   */
  async deleteByBoardId(boardId: string): Promise<number> {
    try {
      const db = this.getDB();
      const where: WhereClause<IBoardUploadFile> = { board_id: boardId };
      const deletedCount = await db.delete<IBoardUploadFile>(
        this.tableName,
        where,
      );

      logger.debug(
        `${deletedCount} board file uploads deleted for board ${boardId}`,
      );
      return deletedCount;
    } catch (error) {
      logger.error(
        `Error deleting board file uploads for board ${boardId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to delete uploads: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Count uploads
   */
  async count(where?: WhereClause<IBoardUploadFile>): Promise<number> {
    try {
      const db = this.getDB();
      return await db.count<IBoardUploadFile>(this.tableName, where);
    } catch (error) {
      logger.error("Error counting board file uploads:", error);
      throw new DatabaseError(
        `Failed to count uploads: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Count uploads by organization
   */
  async countByOrganization(organizationId: string): Promise<number> {
    const where: WhereClause<IBoardUploadFile> = {
      organization_id: organizationId,
    };
    return this.count(where);
  }

  /**
   * Count uploads by board
   */
  async countByBoardId(boardId: string): Promise<number> {
    const where: WhereClause<IBoardUploadFile> = { board_id: boardId };
    return this.count(where);
  }
}

// Export singleton instance
export const boardFileUploadRepository = new BoardFileUploadRepository();
