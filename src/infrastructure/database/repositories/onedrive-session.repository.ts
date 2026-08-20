/**
 * OneDrive Session Repository
 *
 * Data access layer for OneDrive Session entity
 * Manages OAuth session data for OneDrive authentication
 */

import { getDatabase } from "../factory";
import type { DatabaseClient, WhereClause, FindOptions } from "../types";
import type { IOneDriveSession } from "../../../db/models/onedrive-session.model";
import logger from "../../logging/logger";
import { DatabaseError } from "../../../domain/shared/errors";

/**
 * OneDrive Session Repository Class
 */
class OnedriveSessionRepository {
  private readonly tableName = "onedriveSession";

  /**
   * Get database client
   */
  private getDB(): DatabaseClient {
    return getDatabase();
  }

  /**
   * Create a new OneDrive session
   */
  async create(data: Partial<IOneDriveSession>): Promise<IOneDriveSession> {
    try {
      const db = this.getDB();
      const [session] = await db.insert<IOneDriveSession>(this.tableName, data);
      logger.debug(`OneDrive session created: ${session._id}`);
      return session;
    } catch (error) {
      logger.error("Error creating OneDrive session:", error);
      throw new DatabaseError(
        `Failed to create OneDrive session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find session by ID
   */
  async findById(id: string): Promise<IOneDriveSession | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IOneDriveSession>(this.tableName, {
        _id: id,
      } as WhereClause<IOneDriveSession>);
    } catch (error) {
      logger.error(`Error finding OneDrive session ${id}:`, error);
      throw new DatabaseError(
        `Failed to find OneDrive session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find session by OAuth `sessionId` (the OAuth-state key). Replaces the
   * legacy Mongoose `findOne({ sessionId })`.
   */
  async findBySessionId(sessionId: string): Promise<IOneDriveSession | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IOneDriveSession>(this.tableName, {
        sessionId,
      } as WhereClause<IOneDriveSession>);
    } catch (error) {
      logger.error(
        `Error finding OneDrive session by sessionId ${sessionId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find OneDrive session: ${(error as Error).message}`,
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
    data: Partial<IOneDriveSession>,
  ): Promise<IOneDriveSession | null> {
    try {
      const db = this.getDB();
      const existing = await db.findFirst<IOneDriveSession>(this.tableName, {
        sessionId,
      } as WhereClause<IOneDriveSession>);
      if (existing) {
        const [updated] = await db.update<IOneDriveSession>(
          this.tableName,
          { sessionId } as WhereClause<IOneDriveSession>,
          data,
        );
        return updated ?? null;
      }
      const [created] = await db.insert<IOneDriveSession>(this.tableName, {
        sessionId,
        ...data,
      });
      return created ?? null;
    } catch (error) {
      logger.error(
        `Error upserting OneDrive session by sessionId ${sessionId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to upsert OneDrive session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find session by user ID
   */
  async findByUserId(userId: string): Promise<IOneDriveSession | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IOneDriveSession>(this.tableName, {
        user_id: userId,
      } as WhereClause<IOneDriveSession>);
    } catch (error) {
      logger.error(`Error finding OneDrive session for user ${userId}:`, error);
      throw new DatabaseError(
        `Failed to find OneDrive session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find sessions by query
   */
  async findMany(
    where?: WhereClause<IOneDriveSession>,
    options?: FindOptions,
  ): Promise<IOneDriveSession[]> {
    try {
      const db = this.getDB();
      return await db.findMany<IOneDriveSession>(
        this.tableName,
        where,
        options,
      );
    } catch (error) {
      logger.error("Error finding OneDrive sessions:", error);
      throw new DatabaseError(
        `Failed to find OneDrive sessions: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update session by ID
   */
  async update(
    id: string,
    data: Partial<IOneDriveSession>,
  ): Promise<IOneDriveSession | null> {
    try {
      const db = this.getDB();
      const where: WhereClause<IOneDriveSession> = { _id: id };
      const [updated] = await db.update<IOneDriveSession>(
        this.tableName,
        where,
        data,
      );

      if (updated) {
        logger.debug(`OneDrive session updated: ${id}`);
      }

      return updated || null;
    } catch (error) {
      logger.error(`Error updating OneDrive session ${id}:`, error);
      throw new DatabaseError(
        `Failed to update OneDrive session: ${(error as Error).message}`,
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
  ): Promise<IOneDriveSession | null> {
    const data: Partial<IOneDriveSession> = {
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
   * Delete session by ID
   */
  async delete(id: string): Promise<boolean> {
    try {
      const db = this.getDB();
      const where: WhereClause<IOneDriveSession> = { _id: id };
      const deletedCount = await db.delete<IOneDriveSession>(
        this.tableName,
        where,
      );

      if (deletedCount > 0) {
        logger.debug(`OneDrive session deleted: ${id}`);
      }

      return deletedCount > 0;
    } catch (error) {
      logger.error(`Error deleting OneDrive session ${id}:`, error);
      throw new DatabaseError(
        `Failed to delete OneDrive session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete session by user ID
   */
  async deleteByUserId(userId: string): Promise<number> {
    try {
      const db = this.getDB();
      const where: WhereClause<IOneDriveSession> = { user_id: userId };
      const deletedCount = await db.delete<IOneDriveSession>(
        this.tableName,
        where,
      );

      logger.debug(
        `${deletedCount} OneDrive sessions deleted for user ${userId}`,
      );
      return deletedCount;
    } catch (error) {
      logger.error(
        `Error deleting OneDrive sessions for user ${userId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to delete OneDrive sessions: ${(error as Error).message}`,
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
      logger.error(`Error checking if OneDrive session ${id} exists:`, error);
      throw new DatabaseError(
        `Failed to check session existence: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find expired sessions
   */
  async findExpired(): Promise<IOneDriveSession[]> {
    try {
      const db = this.getDB();
      const where: WhereClause<IOneDriveSession> = {
        expires_at: { $lt: new Date() },
      };
      return await db.findMany<IOneDriveSession>(this.tableName, where);
    } catch (error) {
      logger.error("Error finding expired OneDrive sessions:", error);
      throw new DatabaseError(
        `Failed to find expired sessions: ${(error as Error).message}`,
      );
    }
  }
}

// Export singleton instance
export const onedriveSessionRepository = new OnedriveSessionRepository();
