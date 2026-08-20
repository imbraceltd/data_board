/**
 * Dropbox Session Repository
 *
 * Data access layer for Dropbox Session entity
 * Manages OAuth session data for Dropbox authentication
 */

import { getDatabase } from "../factory";
import type { DatabaseClient, WhereClause, FindOptions } from "../types";
import type { IDropboxSession } from "../../../db/models/dropbox-session.model";
import logger from "../../logging/logger";
import { DatabaseError } from "../../../domain/shared/errors";

/**
 * Dropbox Session Repository Class
 */
class DropboxSessionRepository {
  private readonly tableName = "dropboxSession";

  /**
   * Get database client
   */
  private getDB(): DatabaseClient {
    return getDatabase();
  }

  /**
   * Create a new Dropbox session
   */
  async create(data: Partial<IDropboxSession>): Promise<IDropboxSession> {
    try {
      const db = this.getDB();
      const [session] = await db.insert<IDropboxSession>(this.tableName, data);
      logger.debug(`Dropbox session created: ${session._id}`);
      return session;
    } catch (error) {
      logger.error("Error creating Dropbox session:", error);
      throw new DatabaseError(
        `Failed to create Dropbox session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find session by ID
   */
  async findById(id: string): Promise<IDropboxSession | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IDropboxSession>(this.tableName, {
        _id: id,
      } as WhereClause<IDropboxSession>);
    } catch (error) {
      logger.error(`Error finding Dropbox session ${id}:`, error);
      throw new DatabaseError(
        `Failed to find Dropbox session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find session by OAuth `sessionId` (the OAuth-state key). Replaces the
   * legacy Mongoose `findOne({ sessionId })`.
   */
  async findBySessionId(sessionId: string): Promise<IDropboxSession | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IDropboxSession>(this.tableName, {
        sessionId,
      } as WhereClause<IDropboxSession>);
    } catch (error) {
      logger.error(
        `Error finding Dropbox session by sessionId ${sessionId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find Dropbox session: ${(error as Error).message}`,
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
    data: Partial<IDropboxSession>,
  ): Promise<IDropboxSession | null> {
    try {
      const db = this.getDB();
      const existing = await db.findFirst<IDropboxSession>(this.tableName, {
        sessionId,
      } as WhereClause<IDropboxSession>);
      if (existing) {
        const [updated] = await db.update<IDropboxSession>(
          this.tableName,
          { sessionId } as WhereClause<IDropboxSession>,
          data,
        );
        return updated ?? null;
      }
      const [created] = await db.insert<IDropboxSession>(this.tableName, {
        sessionId,
        ...data,
      });
      return created ?? null;
    } catch (error) {
      logger.error(
        `Error upserting Dropbox session by sessionId ${sessionId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to upsert Dropbox session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find session by user ID
   */
  async findByUserId(userId: string): Promise<IDropboxSession | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IDropboxSession>(this.tableName, {
        user_id: userId,
      } as WhereClause<IDropboxSession>);
    } catch (error) {
      logger.error(`Error finding Dropbox session for user ${userId}:`, error);
      throw new DatabaseError(
        `Failed to find Dropbox session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find sessions by query
   */
  async findMany(
    where?: WhereClause<IDropboxSession>,
    options?: FindOptions,
  ): Promise<IDropboxSession[]> {
    try {
      const db = this.getDB();
      return await db.findMany<IDropboxSession>(this.tableName, where, options);
    } catch (error) {
      logger.error("Error finding Dropbox sessions:", error);
      throw new DatabaseError(
        `Failed to find Dropbox sessions: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update session by ID
   */
  async update(
    id: string,
    data: Partial<IDropboxSession>,
  ): Promise<IDropboxSession | null> {
    try {
      const db = this.getDB();
      const where: WhereClause<IDropboxSession> = { _id: id };
      const [updated] = await db.update<IDropboxSession>(
        this.tableName,
        where,
        data,
      );

      if (updated) {
        logger.debug(`Dropbox session updated: ${id}`);
      }

      return updated || null;
    } catch (error) {
      logger.error(`Error updating Dropbox session ${id}:`, error);
      throw new DatabaseError(
        `Failed to update Dropbox session: ${(error as Error).message}`,
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
  ): Promise<IDropboxSession | null> {
    const data: Partial<IDropboxSession> = {
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
      const where: WhereClause<IDropboxSession> = { _id: id };
      const deletedCount = await db.delete<IDropboxSession>(
        this.tableName,
        where,
      );

      if (deletedCount > 0) {
        logger.debug(`Dropbox session deleted: ${id}`);
      }

      return deletedCount > 0;
    } catch (error) {
      logger.error(`Error deleting Dropbox session ${id}:`, error);
      throw new DatabaseError(
        `Failed to delete Dropbox session: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete session by user ID
   */
  async deleteByUserId(userId: string): Promise<number> {
    try {
      const db = this.getDB();
      const where: WhereClause<IDropboxSession> = { user_id: userId };
      const deletedCount = await db.delete<IDropboxSession>(
        this.tableName,
        where,
      );

      logger.debug(
        `${deletedCount} Dropbox sessions deleted for user ${userId}`,
      );
      return deletedCount;
    } catch (error) {
      logger.error(
        `Error deleting Dropbox sessions for user ${userId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to delete Dropbox sessions: ${(error as Error).message}`,
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
      logger.error(`Error checking if Dropbox session ${id} exists:`, error);
      throw new DatabaseError(
        `Failed to check session existence: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find expired sessions
   */
  async findExpired(): Promise<IDropboxSession[]> {
    try {
      const db = this.getDB();
      const where: WhereClause<IDropboxSession> = {
        expires_at: { $lt: new Date() },
      };
      return await db.findMany<IDropboxSession>(this.tableName, where);
    } catch (error) {
      logger.error("Error finding expired Dropbox sessions:", error);
      throw new DatabaseError(
        `Failed to find expired sessions: ${(error as Error).message}`,
      );
    }
  }
}

// Export singleton instance
export const dropboxSessionRepository = new DropboxSessionRepository();
