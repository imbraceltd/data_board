/**
 * Google Drive Subscription Repository
 *
 * Data access layer for Google Drive Subscription entity
 * Manages webhook subscriptions for Google Drive change notifications
 */

import { getDatabase } from "../factory";
import type { DatabaseClient, WhereClause, FindOptions } from "../types";
import type { IGoogleDriveSubscription } from "../../../db/models/google-drive-subscription.model";
import logger from "../../logging/logger";
import { DatabaseError } from "../../../domain/shared/errors";

/**
 * Google Drive Subscription Repository Class
 */
class GoogleDriveSubscriptionRepository {
  private readonly tableName = "googleDriveSubscription";

  /**
   * Get database client
   */
  private getDB(): DatabaseClient {
    return getDatabase();
  }

  /**
   * Create a new subscription
   */
  async create(
    data: Partial<IGoogleDriveSubscription>,
  ): Promise<IGoogleDriveSubscription> {
    try {
      const db = this.getDB();
      const [subscription] = await db.insert<IGoogleDriveSubscription>(
        this.tableName,
        data,
      );
      logger.debug(`Google Drive subscription created: ${subscription._id}`);
      return subscription;
    } catch (error) {
      logger.error("Error creating Google Drive subscription:", error);
      throw new DatabaseError(
        `Failed to create Google Drive subscription: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find subscription by ID
   */
  async findById(id: string): Promise<IGoogleDriveSubscription | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IGoogleDriveSubscription>(this.tableName, {
        _id: id,
      } as WhereClause<IGoogleDriveSubscription>);
    } catch (error) {
      logger.error(`Error finding Google Drive subscription ${id}:`, error);
      throw new DatabaseError(
        `Failed to find Google Drive subscription: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find subscription by channel ID (from Google)
   */
  async findByChannelId(
    channelId: string,
  ): Promise<IGoogleDriveSubscription | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IGoogleDriveSubscription>(this.tableName, {
        channel_id: channelId,
      } as WhereClause<IGoogleDriveSubscription>);
    } catch (error) {
      logger.error(
        `Error finding Google Drive subscription with channel ${channelId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find Google Drive subscription: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find subscriptions by session ID
   */
  async findBySessionId(
    sessionId: string,
    options?: FindOptions,
  ): Promise<IGoogleDriveSubscription[]> {
    try {
      const where: WhereClause<IGoogleDriveSubscription> = {
        session_id: sessionId,
      };
      return this.findMany(where, options);
    } catch (error) {
      logger.error(
        `Error finding Google Drive subscriptions for session ${sessionId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find subscriptions: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find subscriptions by query
   */
  async findMany(
    where?: WhereClause<IGoogleDriveSubscription>,
    options?: FindOptions,
  ): Promise<IGoogleDriveSubscription[]> {
    try {
      const db = this.getDB();
      return await db.findMany<IGoogleDriveSubscription>(
        this.tableName,
        where,
        options,
      );
    } catch (error) {
      logger.error("Error finding Google Drive subscriptions:", error);
      throw new DatabaseError(
        `Failed to find Google Drive subscriptions: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update subscription by ID
   */
  async update(
    id: string,
    data: Partial<IGoogleDriveSubscription>,
  ): Promise<IGoogleDriveSubscription | null> {
    try {
      const db = this.getDB();
      const where: WhereClause<IGoogleDriveSubscription> = { _id: id };
      const [updated] = await db.update<IGoogleDriveSubscription>(
        this.tableName,
        where,
        data,
      );

      if (updated) {
        logger.debug(`Google Drive subscription updated: ${id}`);
      }

      return updated || null;
    } catch (error) {
      logger.error(`Error updating Google Drive subscription ${id}:`, error);
      throw new DatabaseError(
        `Failed to update Google Drive subscription: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete subscription by ID
   */
  async delete(id: string): Promise<boolean> {
    try {
      const db = this.getDB();
      const where: WhereClause<IGoogleDriveSubscription> = { _id: id };
      const deletedCount = await db.delete<IGoogleDriveSubscription>(
        this.tableName,
        where,
      );

      if (deletedCount > 0) {
        logger.debug(`Google Drive subscription deleted: ${id}`);
      }

      return deletedCount > 0;
    } catch (error) {
      logger.error(`Error deleting Google Drive subscription ${id}:`, error);
      throw new DatabaseError(
        `Failed to delete Google Drive subscription: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete subscriptions by session ID
   */
  async deleteBySessionId(sessionId: string): Promise<number> {
    try {
      const db = this.getDB();
      const where: WhereClause<IGoogleDriveSubscription> = {
        session_id: sessionId,
      };
      const deletedCount = await db.delete<IGoogleDriveSubscription>(
        this.tableName,
        where,
      );

      logger.debug(
        `${deletedCount} Google Drive subscriptions deleted for session ${sessionId}`,
      );
      return deletedCount;
    } catch (error) {
      logger.error(
        `Error deleting Google Drive subscriptions for session ${sessionId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to delete subscriptions: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find expired subscriptions
   */
  async findExpired(): Promise<IGoogleDriveSubscription[]> {
    try {
      const db = this.getDB();
      const where: WhereClause<IGoogleDriveSubscription> = {
        expiration: { $lt: Date.now() },
      };
      return await db.findMany<IGoogleDriveSubscription>(this.tableName, where);
    } catch (error) {
      logger.error("Error finding expired Google Drive subscriptions:", error);
      throw new DatabaseError(
        `Failed to find expired subscriptions: ${(error as Error).message}`,
      );
    }
  }
}

// Export singleton instance
export const googleDriveSubscriptionRepository =
  new GoogleDriveSubscriptionRepository();
