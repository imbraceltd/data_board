/**
 * Google Drive Session Repository
 *
 * Data access layer for Google Drive Session entity
 * Manages OAuth session data for Google Drive authentication
 */

import { getDatabase } from "../factory";
import type { DatabaseClient, WhereClause, FindOptions } from "../types";
import type { IGoogleDriveSession } from "../../../db/models/google-drive-session.model";
import logger from "../../logging/logger";
import { DatabaseError } from "../../../domain/shared/errors";

/**
 * Google Drive Session Repository Class
 */
class GoogleDriveSessionRepository {
  private readonly tableName = "googleDriveSession";

  /**
   * Get database client
   */
  private getDB(): DatabaseClient {
    return getDatabase();
  }

  /**
   * Create a new Google Drive session
   */
  async create(
    data: Partial<IGoogleDriveSession>,
  ): Promise<IGoogleDriveSession> {
    try {
      const db = this.getDB();
      const [session] = await db.insert<IGoogleDriveSession>(
        this.tableName,
        data,
      );
      logger.debug(`Google Drive session created: ${session._id}`);
      return session;
    } catch (error) {
      logger.error("Error creating Google Drive session:", error);
      throw new DatabaseError(
        `Failed to create Google Drive session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find session by ID
   */
  async findById(id: string): Promise<IGoogleDriveSession | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IGoogleDriveSession>(this.tableName, {
        _id: id,
      } as WhereClause<IGoogleDriveSession>);
    } catch (error) {
      logger.error(`Error finding Google Drive session ${id}:`, error);
      throw new DatabaseError(
        `Failed to find Google Drive session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find session by OAuth `sessionId` (the OAuth-state key). Replaces the
   * legacy Mongoose `findOne({ sessionId })`.
   */
  async findBySessionId(
    sessionId: string,
  ): Promise<IGoogleDriveSession | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IGoogleDriveSession>(this.tableName, {
        sessionId,
      } as WhereClause<IGoogleDriveSession>);
    } catch (error) {
      logger.error(
        `Error finding Google Drive session by sessionId ${sessionId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find Google Drive session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Upsert a session keyed by `sessionId`. Replaces the legacy Mongoose
   * `findOneAndUpdate({ sessionId }, data, { upsert: true })`: updates in place
   * when the row exists, otherwise inserts. Returns the resulting row.
   */
  async upsertBySessionId(
    sessionId: string,
    data: Partial<IGoogleDriveSession>,
  ): Promise<IGoogleDriveSession | null> {
    try {
      const db = this.getDB();
      const existing = await db.findFirst<IGoogleDriveSession>(this.tableName, {
        sessionId,
      } as WhereClause<IGoogleDriveSession>);
      if (existing) {
        const [updated] = await db.update<IGoogleDriveSession>(
          this.tableName,
          { sessionId } as WhereClause<IGoogleDriveSession>,
          data,
        );
        return updated ?? null;
      }
      const [created] = await db.insert<IGoogleDriveSession>(this.tableName, {
        sessionId,
        ...data,
      });
      return created ?? null;
    } catch (error) {
      logger.error(
        `Error upserting Google Drive session by sessionId ${sessionId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to upsert Google Drive session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find session by user ID
   */
  async findByUserId(userId: string): Promise<IGoogleDriveSession | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IGoogleDriveSession>(this.tableName, {
        user_id: userId,
      } as WhereClause<IGoogleDriveSession>);
    } catch (error) {
      logger.error(
        `Error finding Google Drive session for user ${userId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find Google Drive session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find sessions by query
   */
  async findMany(
    where?: WhereClause<IGoogleDriveSession>,
    options?: FindOptions,
  ): Promise<IGoogleDriveSession[]> {
    try {
      const db = this.getDB();
      return await db.findMany<IGoogleDriveSession>(
        this.tableName,
        where,
        options,
      );
    } catch (error) {
      logger.error("Error finding Google Drive sessions:", error);
      throw new DatabaseError(
        `Failed to find Google Drive sessions: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update session by ID
   */
  async update(
    id: string,
    data: Partial<IGoogleDriveSession>,
  ): Promise<IGoogleDriveSession | null> {
    try {
      const db = this.getDB();
      const where: WhereClause<IGoogleDriveSession> = { _id: id };
      const [updated] = await db.update<IGoogleDriveSession>(
        this.tableName,
        where,
        data,
      );

      if (updated) {
        logger.debug(`Google Drive session updated: ${id}`);
      }

      return updated || null;
    } catch (error) {
      logger.error(`Error updating Google Drive session ${id}:`, error);
      throw new DatabaseError(
        `Failed to update Google Drive session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update session tokens
   */
  async updateTokens(
    id: string,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: Date,
  ): Promise<IGoogleDriveSession | null> {
    const data: Partial<IGoogleDriveSession> = {
      access_token: accessToken,
    };

    if (refreshToken) {
      data.refresh_token = refreshToken;
    }
    if (expiresAt) {
      // Convert Date to timestamp (number) since expires_at is typed as number
      data.expires_at = expiresAt.getTime();
    }

    return this.update(id, data);
  }

  /**
   * Update page token for delta sync
   */
  async updatePageToken(
    id: string,
    pageToken: string,
  ): Promise<IGoogleDriveSession | null> {
    return this.update(id, {
      page_token: pageToken,
    } as Partial<IGoogleDriveSession>);
  }

  /**
   * Delete session by ID
   */
  async delete(id: string): Promise<boolean> {
    try {
      const db = this.getDB();
      const where: WhereClause<IGoogleDriveSession> = { _id: id };
      const deletedCount = await db.delete<IGoogleDriveSession>(
        this.tableName,
        where,
      );

      if (deletedCount > 0) {
        logger.debug(`Google Drive session deleted: ${id}`);
      }

      return deletedCount > 0;
    } catch (error) {
      logger.error(`Error deleting Google Drive session ${id}:`, error);
      throw new DatabaseError(
        `Failed to delete Google Drive session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete session by user ID
   */
  async deleteByUserId(userId: string): Promise<number> {
    try {
      const db = this.getDB();
      const where: WhereClause<IGoogleDriveSession> = { user_id: userId };
      const deletedCount = await db.delete<IGoogleDriveSession>(
        this.tableName,
        where,
      );

      logger.debug(
        `${deletedCount} Google Drive sessions deleted for user ${userId}`,
      );
      return deletedCount;
    } catch (error) {
      logger.error(
        `Error deleting Google Drive sessions for user ${userId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to delete Google Drive sessions: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Check if session exists
   */
  async exists(id: string): Promise<boolean> {
    try {
      const session = await this.findById(id);
      return session !== null;
    } catch (error) {
      logger.error(
        `Error checking if Google Drive session ${id} exists:`,
        error,
      );
      throw new DatabaseError(
        `Failed to check session existence: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find expired sessions
   */
  async findExpired(): Promise<IGoogleDriveSession[]> {
    try {
      const db = this.getDB();
      const where: WhereClause<IGoogleDriveSession> = {
        expires_at: { $lt: new Date() },
      };
      return await db.findMany<IGoogleDriveSession>(this.tableName, where);
    } catch (error) {
      logger.error("Error finding expired Google Drive sessions:", error);
      throw new DatabaseError(
        `Failed to find expired sessions: ${(error as Error).message}`,
      );
    }
  }
}

// Export singleton instance
export const googleDriveSessionRepository = new GoogleDriveSessionRepository();
