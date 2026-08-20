/**
 * File Repository
 *
 * Data access layer for File entity
 * All database operations for files should go through this repository
 */

import { getDatabase } from "../factory";
import type { DatabaseClient, WhereClause, FindOptions } from "../types";
import type { IFile } from "../../../db/models/file.model";
import logger from "../../logging/logger";
import { DatabaseError } from "../../../domain/shared/errors";

/**
 * File Repository Class
 */
class FileRepository {
  private readonly tableName = "files";

  /**
   * Get database client
   */
  private getDB(): DatabaseClient {
    return getDatabase();
  }

  /**
   * Create a new file
   */
  async create(data: Partial<IFile>): Promise<IFile> {
    try {
      const db = this.getDB();
      const [file] = await db.insert<IFile>(this.tableName, data);
      logger.debug(`File created: ${file._id}`);
      return file;
    } catch (error) {
      logger.error("Error creating file:", error);
      throw new DatabaseError(
        `Failed to create file: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find file by ID
   */
  async findById(id: string): Promise<IFile | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IFile>(this.tableName, {
        _id: id,
      } as WhereClause<IFile>);
    } catch (error) {
      logger.error(`Error finding file ${id}:`, error);
      throw new DatabaseError(
        `Failed to find file: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find files by query
   */
  async findMany(
    where?: WhereClause<IFile>,
    options?: FindOptions,
  ): Promise<IFile[]> {
    try {
      const db = this.getDB();
      return await db.findMany<IFile>(this.tableName, where, options);
    } catch (error) {
      logger.error("Error finding files:", error);
      throw new DatabaseError(
        `Failed to find files: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find all files
   */
  async findAll(options?: FindOptions): Promise<IFile[]> {
    return this.findMany(undefined, options);
  }

  /**
   * Find files by folder ID
   */
  async findByFolderId(
    folderId: string,
    options?: FindOptions,
  ): Promise<IFile[]> {
    try {
      const where: WhereClause<IFile> = { folder_id: folderId };
      return this.findMany(where, options);
    } catch (error) {
      logger.error(`Error finding files for folder ${folderId}:`, error);
      throw new DatabaseError(
        `Failed to find files: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find files by organization ID
   */
  async findByOrganization(
    organizationId: string,
    options?: FindOptions,
  ): Promise<IFile[]> {
    try {
      const where: WhereClause<IFile> = { organization_id: organizationId };
      return this.findMany(where, options);
    } catch (error) {
      logger.error(
        `Error finding files for organization ${organizationId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find files: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find file by external ID and source
   */
  async findByExternalId(
    externalId: string,
    externalSource: string,
  ): Promise<IFile | null> {
    try {
      const db = this.getDB();
      const where: WhereClause<IFile> = {
        external_id: externalId,
        external_source: externalSource,
      };
      return await db.findFirst<IFile>(this.tableName, where);
    } catch (error) {
      logger.error(`Error finding file by external ID ${externalId}:`, error);
      throw new DatabaseError(
        `Failed to find file: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find file by key (storage key)
   */
  async findByKey(key: string): Promise<IFile | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IFile>(this.tableName, {
        key,
      } as WhereClause<IFile>);
    } catch (error) {
      logger.error(`Error finding file by key ${key}:`, error);
      throw new DatabaseError(
        `Failed to find file: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Search files by name
   */
  async search(
    query: string,
    organizationId?: string,
    limit?: number,
  ): Promise<IFile[]> {
    try {
      const db = this.getDB();
      const where: WhereClause<IFile> = {
        name: { $regex: query, $options: "i" },
      };

      if (organizationId) {
        where.organization_id = organizationId;
      }

      const options: FindOptions = limit ? { limit } : {};
      return await db.findMany<IFile>(this.tableName, where, options);
    } catch (error) {
      logger.error(`Error searching files with query "${query}":`, error);
      throw new DatabaseError(
        `Failed to search files: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Search files within a folder
   */
  async searchInFolder(
    folderId: string,
    query: string,
    options?: FindOptions,
  ): Promise<IFile[]> {
    try {
      const db = this.getDB();
      const where: WhereClause<IFile> = {
        folder_id: folderId,
        name: { $regex: query, $options: "i" },
      };
      return await db.findMany<IFile>(this.tableName, where, options);
    } catch (error) {
      logger.error(`Error searching files in folder ${folderId}:`, error);
      throw new DatabaseError(
        `Failed to search files: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update file by ID
   */
  async update(id: string, data: Partial<IFile>): Promise<IFile | null> {
    try {
      const db = this.getDB();
      const where: WhereClause<IFile> = { _id: id };
      const [updated] = await db.update<IFile>(this.tableName, where, data);

      if (updated) {
        logger.debug(`File updated: ${id}`);
      }

      return updated || null;
    } catch (error) {
      logger.error(`Error updating file ${id}:`, error);
      throw new DatabaseError(
        `Failed to update file: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete file by ID
   */
  async delete(id: string): Promise<boolean> {
    try {
      const db = this.getDB();
      const where: WhereClause<IFile> = { _id: id };
      const deletedCount = await db.delete<IFile>(this.tableName, where);

      if (deletedCount > 0) {
        logger.debug(`File deleted: ${id}`);
      }

      return deletedCount > 0;
    } catch (error) {
      logger.error(`Error deleting file ${id}:`, error);
      throw new DatabaseError(
        `Failed to delete file: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete multiple files by IDs
   */
  async deleteMultiple(ids: string[]): Promise<number> {
    try {
      const db = this.getDB();
      const where: WhereClause<IFile> = { _id: { $in: ids } };
      const deletedCount = await db.delete<IFile>(this.tableName, where);

      logger.debug(`${deletedCount} files deleted`);
      return deletedCount;
    } catch (error) {
      logger.error("Error deleting multiple files:", error);
      throw new DatabaseError(
        `Failed to delete files: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete files by folder ID
   */
  async deleteByFolderId(folderId: string): Promise<number> {
    try {
      const db = this.getDB();
      const where: WhereClause<IFile> = { folder_id: folderId };
      const deletedCount = await db.delete<IFile>(this.tableName, where);

      logger.debug(`${deletedCount} files deleted from folder ${folderId}`);
      return deletedCount;
    } catch (error) {
      logger.error(`Error deleting files from folder ${folderId}:`, error);
      throw new DatabaseError(
        `Failed to delete files: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Count files
   */
  async count(where?: WhereClause<IFile>): Promise<number> {
    try {
      const db = this.getDB();
      return await db.count<IFile>(this.tableName, where);
    } catch (error) {
      logger.error("Error counting files:", error);
      throw new DatabaseError(
        `Failed to count files: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Count files in folder
   */
  async countByFolderId(folderId: string): Promise<number> {
    const where: WhereClause<IFile> = { folder_id: folderId };
    return this.count(where);
  }

  /**
   * Count files across multiple folder IDs in a single query
   */
  async countByFolderIds(folderIds: string[]): Promise<number> {
    const where: WhereClause<IFile> = { folder_id: { $in: folderIds } };
    return this.count(where);
  }

  /**
   * Get file names only for a given folder (lightweight projection)
   */
  async findNamesByFolderId(folderId: string): Promise<{ name: string }[]> {
    try {
      const db = this.getDB();
      return await db.select<{ name: string }>({
        table: this.tableName,
        where: { folder_id: folderId } as WhereClause<IFile>,
        fields: ["name"],
      });
    } catch (error) {
      logger.error(
        `Error finding file names for folder ${folderId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find file names: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Get file names only for multiple folder IDs in a single query (lightweight projection)
   * Returns file names along with their folder_id for grouping
   */
  async findNamesByFolderIds(
    folderIds: string[],
  ): Promise<{ _id: string; name: string; folder_id: string; remarks?: string }[]> {
    try {
      const db = this.getDB();
      return await db.select<{ _id: string; name: string; folder_id: string; remarks?: string }>({
        table: this.tableName,
        where: { folder_id: { $in: folderIds } } as WhereClause<IFile>,
        fields: ["_id", "name", "folder_id", "remarks"],
      });
    } catch (error) {
      logger.error("Error finding file names for multiple folders:", error);
      throw new DatabaseError(
        `Failed to find file names: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Count files by organization
   */
  async countByOrganization(organizationId: string): Promise<number> {
    const where: WhereClause<IFile> = { organization_id: organizationId };
    return this.count(where);
  }

  /**
   * Check if file exists
   */
  async exists(id: string): Promise<boolean> {
    try {
      const file = await this.findById(id);
      return file !== null;
    } catch (error) {
      logger.error(`Error checking if file ${id} exists:`, error);
      throw new DatabaseError(
        `Failed to check file existence: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find files by type (MIME type)
   */
  async findByType(mimeType: string, options?: FindOptions): Promise<IFile[]> {
    try {
      const where: WhereClause<IFile> = { type: mimeType };
      return this.findMany(where, options);
    } catch (error) {
      logger.error(`Error finding files of type ${mimeType}:`, error);
      throw new DatabaseError(
        `Failed to find files: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find files by multiple keys
   */
  async findByKeys(keys: string[]): Promise<IFile[]> {
    try {
      const db = this.getDB();
      const where: WhereClause<IFile> = { key: { $in: keys } };
      return await db.findMany<IFile>(this.tableName, where);
    } catch (error) {
      logger.error("Error finding files by keys:", error);
      throw new DatabaseError(
        `Failed to find files: ${(error as Error).message}`,
      );
    }
  }
}

// Export singleton instance
export const fileRepository = new FileRepository();
