/**
 * Ingestion Job Repository
 *
 * Data access layer for Ingestion Job entity
 * Manages background file ingestion queue and job tracking
 */

import { getDatabase } from "../factory";
import type { DatabaseClient, WhereClause, FindOptions } from "../types";
import type { IIngestionJob } from "../../../db/models/ingestion-job.model";
import logger from "../../logging/logger";
import { DatabaseError } from "../../../domain/shared/errors";

/**
 * Ingestion Job Repository Class
 */
class IngestionJobRepository {
  private readonly tableName = "ingestion_jobs";

  /**
   * Get database client
   */
  private getDB(): DatabaseClient {
    return getDatabase();
  }

  /**
   * Create a new ingestion job
   */
  async create(data: Partial<IIngestionJob>): Promise<IIngestionJob> {
    try {
      const db = this.getDB();
      const [job] = await db.insert<IIngestionJob>(this.tableName, data);
      logger.debug(`Ingestion job created: ${job._id}`);
      return job;
    } catch (error) {
      logger.error("Error creating ingestion job:", error);
      throw new DatabaseError(
        `Failed to create ingestion job: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find job by ID
   */
  async findById(id: string): Promise<IIngestionJob | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IIngestionJob>(this.tableName, {
        _id: id,
      } as WhereClause<IIngestionJob>);
    } catch (error) {
      logger.error(`Error finding ingestion job ${id}:`, error);
      throw new DatabaseError(
        `Failed to find ingestion job: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find jobs by query
   */
  async findMany(
    where?: WhereClause<IIngestionJob>,
    options?: FindOptions,
  ): Promise<IIngestionJob[]> {
    try {
      const db = this.getDB();
      return await db.findMany<IIngestionJob>(this.tableName, where, options);
    } catch (error) {
      logger.error("Error finding ingestion jobs:", error);
      throw new DatabaseError(
        `Failed to find ingestion jobs: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find pending jobs
   */
  async findPending(limit?: number): Promise<IIngestionJob[]> {
    try {
      const where: WhereClause<IIngestionJob> = { status: "pending" };
      const options: FindOptions = {
        orderBy: [{ field: "createdAt", direction: "asc" }],
      };

      if (limit) {
        options.limit = limit;
      }

      return this.findMany(where, options);
    } catch (error) {
      logger.error("Error finding pending ingestion jobs:", error);
      throw new DatabaseError(
        `Failed to find pending jobs: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find jobs by status
   */
  async findByStatus(
    status: string,
    options?: FindOptions,
  ): Promise<IIngestionJob[]> {
    try {
      const where: WhereClause<IIngestionJob> = { status };
      return this.findMany(where, options);
    } catch (error) {
      logger.error(
        `Error finding ingestion jobs with status ${status}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find jobs: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find job by file ID
   */
  async findByFileId(fileId: string): Promise<IIngestionJob | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IIngestionJob>(this.tableName, {
        fileId,
      } as WhereClause<IIngestionJob>);
    } catch (error) {
      logger.error(`Error finding ingestion job for file ${fileId}:`, error);
      throw new DatabaseError(
        `Failed to find job: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find an active (pending or error) job for a given file ID
   */
  async findActiveByFileId(fileId: string): Promise<IIngestionJob | null> {
    try {
      const db = this.getDB();
      return await db.findFirst<IIngestionJob>(this.tableName, {
        fileId,
        status: { $in: ["pending", "error"] },
      } as WhereClause<IIngestionJob>);
    } catch (error) {
      logger.error(
        `Error finding active ingestion job for file ${fileId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find active job: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find pending jobs ready to run (nextRetryAt missing or <= now).
   * The $exists / null-or-lte filter is not portable across adapters, so we
   * over-fetch pending jobs ordered by createdAt and filter in memory.
   */
  async findPendingReady(limit: number): Promise<IIngestionJob[]> {
    const pending = await this.findMany(
      { status: "pending" },
      {
        orderBy: [{ field: "createdAt", direction: "asc" }],
        limit: Math.max(limit * 4, limit),
      },
    );
    const now = Date.now();
    return pending
      .filter((j: any) => {
        if (!j.nextRetryAt) return true;
        const ts = new Date(j.nextRetryAt).getTime();
        return Number.isNaN(ts) || ts <= now;
      })
      .slice(0, limit);
  }

  /**
   * Update job by ID
   */
  async update(
    id: string,
    data: Partial<IIngestionJob>,
  ): Promise<IIngestionJob | null> {
    try {
      const db = this.getDB();
      const where: WhereClause<IIngestionJob> = { _id: id };
      const [updated] = await db.update<IIngestionJob>(
        this.tableName,
        where,
        data,
      );

      if (updated) {
        logger.debug(`Ingestion job updated: ${id}`);
      }

      return updated || null;
    } catch (error) {
      logger.error(`Error updating ingestion job ${id}:`, error);
      throw new DatabaseError(
        `Failed to update ingestion job: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update job status
   */
  async updateStatus(
    id: string,
    status: string,
    error?: string,
  ): Promise<IIngestionJob | null> {
    const data: Partial<IIngestionJob> = { status: status as any };

    if (error) {
      data.error = error;
    }

    if (status === "processing") {
      data.processing_started_at = new Date() as any;
    } else if (status === "completed" || status === "failed") {
      data.processing_completed_at = new Date() as any;
    }

    return this.update(id, data);
  }

  /**
   * Delete job by ID
   */
  async delete(id: string): Promise<boolean> {
    try {
      const db = this.getDB();
      const where: WhereClause<IIngestionJob> = { _id: id };
      const deletedCount = await db.delete<IIngestionJob>(
        this.tableName,
        where,
      );

      if (deletedCount > 0) {
        logger.debug(`Ingestion job deleted: ${id}`);
      }

      return deletedCount > 0;
    } catch (error) {
      logger.error(`Error deleting ingestion job ${id}:`, error);
      throw new DatabaseError(
        `Failed to delete ingestion job: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete completed jobs older than given date
   */
  async deleteOldCompleted(olderThan: Date): Promise<number> {
    try {
      const db = this.getDB();
      const where: WhereClause<IIngestionJob> = {
        status: "completed",
        processing_completed_at: { $lt: olderThan },
      };
      const deletedCount = await db.delete<IIngestionJob>(
        this.tableName,
        where,
      );

      logger.debug(`${deletedCount} old completed ingestion jobs deleted`);
      return deletedCount;
    } catch (error) {
      logger.error("Error deleting old completed ingestion jobs:", error);
      throw new DatabaseError(
        `Failed to delete old jobs: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Count jobs
   */
  async count(where?: WhereClause<IIngestionJob>): Promise<number> {
    try {
      const db = this.getDB();
      return await db.count<IIngestionJob>(this.tableName, where);
    } catch (error) {
      logger.error("Error counting ingestion jobs:", error);
      throw new DatabaseError(
        `Failed to count jobs: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Count jobs by status
   */
  async countByStatus(status: string): Promise<number> {
    const where: WhereClause<IIngestionJob> = { status };
    return this.count(where);
  }

  /**
   * Count pending jobs
   */
  async countPending(): Promise<number> {
    return this.countByStatus("pending");
  }
}

// Export singleton instance
export const ingestionJobRepository = new IngestionJobRepository();
