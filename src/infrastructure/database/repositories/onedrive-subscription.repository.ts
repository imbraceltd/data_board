/**
 * OneDrive Subscription Repository
 *
 * Data access layer for OneDrive Subscription entity
 * Manages webhook subscriptions for OneDrive delta sync
 */

import { getDatabase } from "../factory";
import type { DatabaseClient, WhereClause, FindOptions } from "../types";
import type { IOneDriveSubscription } from "../../../db/models/onedrive-subscription.model";
import logger from "../../logging/logger";
import { DatabaseError } from "../../../domain/shared/errors";

/**
 * OneDrive Subscription Repository Class
 */
class OnedriveSubscriptionRepository {
  private readonly tableName = "onedriveSubscription";

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
    data: Partial<IOneDriveSubscription>,
  ): Promise<IOneDriveSubscription> {
    try {
      const db = this.getDB();
      const [subscription] = await db.insert<IOneDriveSubscription>(
        this.tableName,
        data,
      );
      logger.debug(`OneDrive subscription created: ${subscription._id}`);
      return subscription;
    } catch (error) {
      logger.error("Error creating OneDrive subscription:", error);
      throw new DatabaseError(
        `Failed to create OneDrive subscription: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find subscription by ID
   */
  async findById(id: string): Promise<IOneDriveSubscription | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IOneDriveSubscription>(this.tableName, {
        _id: id,
      } as WhereClause<IOneDriveSubscription>);
    } catch (error) {
      logger.error(`Error finding OneDrive subscription ${id}:`, error);
      throw new DatabaseError(
        `Failed to find OneDrive subscription: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find subscription by subscription ID (from Microsoft)
   */
  async findBySubscriptionId(
    subscriptionId: string,
  ): Promise<IOneDriveSubscription | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IOneDriveSubscription>(this.tableName, {
        subscription_id: subscriptionId,
      } as WhereClause<IOneDriveSubscription>);
    } catch (error) {
      logger.error(
        `Error finding OneDrive subscription ${subscriptionId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find OneDrive subscription: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find subscriptions by session ID
   */
  async findBySessionId(
    sessionId: string,
    options?: FindOptions,
  ): Promise<IOneDriveSubscription[]> {
    try {
      const where: WhereClause<IOneDriveSubscription> = {
        session_id: sessionId,
      };
      return this.findMany(where, options);
    } catch (error) {
      logger.error(
        `Error finding OneDrive subscriptions for session ${sessionId}:`,
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
    where?: WhereClause<IOneDriveSubscription>,
    options?: FindOptions,
  ): Promise<IOneDriveSubscription[]> {
    try {
      const db = this.getDB();
      return await db.findMany<IOneDriveSubscription>(
        this.tableName,
        where,
        options,
      );
    } catch (error) {
      logger.error("Error finding OneDrive subscriptions:", error);
      throw new DatabaseError(
        `Failed to find OneDrive subscriptions: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update subscription by ID
   */
  async update(
    id: string,
    data: Partial<IOneDriveSubscription>,
  ): Promise<IOneDriveSubscription | null> {
    try {
      const db = this.getDB();
      const where: WhereClause<IOneDriveSubscription> = { _id: id };
      const [updated] = await db.update<IOneDriveSubscription>(
        this.tableName,
        where,
        data,
      );

      if (updated) {
        logger.debug(`OneDrive subscription updated: ${id}`);
      }

      return updated || null;
    } catch (error) {
      logger.error(`Error updating OneDrive subscription ${id}:`, error);
      throw new DatabaseError(
        `Failed to update OneDrive subscription: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete subscription by ID
   */
  async delete(id: string): Promise<boolean> {
    try {
      const db = this.getDB();
      const where: WhereClause<IOneDriveSubscription> = { _id: id };
      const deletedCount = await db.delete<IOneDriveSubscription>(
        this.tableName,
        where,
      );

      if (deletedCount > 0) {
        logger.debug(`OneDrive subscription deleted: ${id}`);
      }

      return deletedCount > 0;
    } catch (error) {
      logger.error(`Error deleting OneDrive subscription ${id}:`, error);
      throw new DatabaseError(
        `Failed to delete OneDrive subscription: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete subscriptions by session ID
   */
  async deleteBySessionId(sessionId: string): Promise<number> {
    try {
      const db = this.getDB();
      const where: WhereClause<IOneDriveSubscription> = {
        session_id: sessionId,
      };
      const deletedCount = await db.delete<IOneDriveSubscription>(
        this.tableName,
        where,
      );

      logger.debug(
        `${deletedCount} OneDrive subscriptions deleted for session ${sessionId}`,
      );
      return deletedCount;
    } catch (error) {
      logger.error(
        `Error deleting OneDrive subscriptions for session ${sessionId}:`,
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
  async findExpired(): Promise<IOneDriveSubscription[]> {
    try {
      const db = this.getDB();
      const where: WhereClause<IOneDriveSubscription> = {
        expiration_date_time: { $lt: new Date() },
      };
      return await db.findMany<IOneDriveSubscription>(this.tableName, where);
    } catch (error) {
      logger.error("Error finding expired OneDrive subscriptions:", error);
      throw new DatabaseError(
        `Failed to find expired subscriptions: ${(error as Error).message}`,
      );
    }
  }
}

// Export singleton instance
export const onedriveSubscriptionRepository =
  new OnedriveSubscriptionRepository();
