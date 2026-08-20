/**
 * Folder Repository
 *
 * Data access layer for Folder entity
 * All database operations for folders should go through this repository
 */

import { getDatabase } from "../factory";
import type { DatabaseClient, WhereClause, FindOptions } from "../types";
import type { IFolder } from "../../../db/models/folder.model";
import logger from "../../logging/logger";
import { DatabaseError, NotFoundError } from "../../../domain/shared/errors";

/**
 * Folder Repository Class
 */
class FolderRepository {
  private readonly tableName = "folders";

  /**
   * Get database client
   */
  private getDB(): DatabaseClient {
    return getDatabase();
  }

  /**
   * Create a new folder
   */
  async create(data: Partial<IFolder>): Promise<IFolder> {
    try {
      const db = this.getDB();
      const [folder] = await db.insert<IFolder>(this.tableName, data);
      logger.debug(`Folder created: ${folder._id}`);
      return folder;
    } catch (error) {
      logger.error("Error creating folder:", error);
      throw new DatabaseError(
        `Failed to create folder: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find folder by ID
   */
  async findById(id: string): Promise<IFolder | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IFolder>(this.tableName, {
        _id: id,
      } as WhereClause<IFolder>);
    } catch (error) {
      logger.error(`Error finding folder ${id}:`, error);
      throw new DatabaseError(
        `Failed to find folder: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find folders by query
   */
  async findMany(
    where?: WhereClause<IFolder>,
    options?: FindOptions,
  ): Promise<IFolder[]> {
    try {
      const db = this.getDB();
      return await db.findMany<IFolder>(this.tableName, where, options);
    } catch (error) {
      logger.error("Error finding folders:", error);
      throw new DatabaseError(
        `Failed to find folders: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find all folders
   */
  async findAll(options?: FindOptions): Promise<IFolder[]> {
    return this.findMany(undefined, options);
  }

  /**
   * Find folders by organization ID
   */
  async findByOrganization(
    organizationId: string,
    options?: FindOptions,
  ): Promise<IFolder[]> {
    try {
      const where: WhereClause<IFolder> = { organization_id: organizationId };
      return this.findMany(where, options);
    } catch (error) {
      logger.error(
        `Error finding folders for organization ${organizationId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find folders: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find folders by parent folder ID
   */
  async findByParentId(
    parentId: string,
    options?: FindOptions,
  ): Promise<IFolder[]> {
    try {
      const where: WhereClause<IFolder> = { parent_folder_id: parentId };
      return this.findMany(where, options);
    } catch (error) {
      logger.error(`Error finding subfolders for ${parentId}:`, error);
      throw new DatabaseError(
        `Failed to find subfolders: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find folder by external ID and source
   */
  async findByExternalId(
    externalId: string,
    externalSource: string,
  ): Promise<IFolder | null> {
    try {
      const db = this.getDB();
      const where: WhereClause<IFolder> = {
        external_id: externalId,
        external_source: externalSource,
      };
      return await db.findFirst<IFolder>(this.tableName, where);
    } catch (error) {
      logger.error(`Error finding folder by external ID ${externalId}:`, error);
      throw new DatabaseError(
        `Failed to find folder: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Search folders by name
   */
  async search(
    query: string,
    organizationId?: string,
    limit?: number,
  ): Promise<IFolder[]> {
    try {
      const db = this.getDB();
      const where: WhereClause<IFolder> = {
        name: { $regex: query, $options: "i" },
      };

      if (organizationId) {
        where.organization_id = organizationId;
      }

      const options: FindOptions = limit ? { limit } : {};
      return await db.findMany<IFolder>(this.tableName, where, options);
    } catch (error) {
      logger.error(`Error searching folders with query "${query}":`, error);
      throw new DatabaseError(
        `Failed to search folders: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update folder by ID
   */
  async update(id: string, data: Partial<IFolder>): Promise<IFolder | null> {
    try {
      const db = this.getDB();
      const where: WhereClause<IFolder> = { _id: id };
      const [updated] = await db.update<IFolder>(this.tableName, where, data);

      if (updated) {
        logger.debug(`Folder updated: ${id}`);
      }

      return updated || null;
    } catch (error) {
      logger.error(`Error updating folder ${id}:`, error);
      throw new DatabaseError(
        `Failed to update folder: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete folder by ID
   */
  async delete(id: string): Promise<boolean> {
    try {
      const db = this.getDB();
      const where: WhereClause<IFolder> = { _id: id };
      const deletedCount = await db.delete<IFolder>(this.tableName, where);

      if (deletedCount > 0) {
        logger.debug(`Folder deleted: ${id}`);
      }

      return deletedCount > 0;
    } catch (error) {
      logger.error(`Error deleting folder ${id}:`, error);
      throw new DatabaseError(
        `Failed to delete folder: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete multiple folders by IDs
   */
  async deleteMultiple(ids: string[]): Promise<number> {
    try {
      const db = this.getDB();
      const where: WhereClause<IFolder> = { _id: { $in: ids } };
      const deletedCount = await db.delete<IFolder>(this.tableName, where);

      logger.debug(`${deletedCount} folders deleted`);
      return deletedCount;
    } catch (error) {
      logger.error("Error deleting multiple folders:", error);
      throw new DatabaseError(
        `Failed to delete folders: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Count folders
   */
  async count(where?: WhereClause<IFolder>): Promise<number> {
    try {
      const db = this.getDB();
      return await db.count<IFolder>(this.tableName, where);
    } catch (error) {
      logger.error("Error counting folders:", error);
      throw new DatabaseError(
        `Failed to count folders: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Count folders by organization
   */
  async countByOrganization(organizationId: string): Promise<number> {
    const where: WhereClause<IFolder> = { organization_id: organizationId };
    return this.count(where);
  }

  /**
   * Check if folder exists
   */
  async exists(id: string): Promise<boolean> {
    try {
      const folder = await this.findById(id);
      return folder !== null;
    } catch (error) {
      logger.error(`Error checking if folder ${id} exists:`, error);
      throw new DatabaseError(
        `Failed to check folder existence: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find folder by session ID
   */
  async findBySessionId(
    sessionId: string,
    options?: FindOptions,
  ): Promise<IFolder[]> {
    try {
      const where: WhereClause<IFolder> = { session_id: sessionId };
      return this.findMany(where, options);
    } catch (error) {
      logger.error(`Error finding folders for session ${sessionId}:`, error);
      throw new DatabaseError(
        `Failed to find folders: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update file count for a folder
   */
  async updateFileCount(
    id: string,
    fileCount: number,
  ): Promise<IFolder | null> {
    return this.update(id, { file_count: fileCount } as Partial<IFolder>);
  }
}

// Export singleton instance
export const folderRepository = new FolderRepository();
