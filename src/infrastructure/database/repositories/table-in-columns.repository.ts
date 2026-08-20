/**
 * Drizzle TableInColumns Repository
 * PostgreSQL implementation for table-in-table field relationships
 */

import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { tableInColumns } from "../../../db/drizzle/schema";
import type * as schema from "../../../db/drizzle/schema";
import type { ITableInColumnsRepository } from "../../../domain/repositories/board-item.repository.interface";
import type {
  TableInColumn,
  CreateTableInColumnDTO,
} from "../../../domain/shared/board-item.types";
import { DatabaseError, NotFoundError } from "../../../domain/shared/errors";
import logger from "../../logging/logger";

export class TableInColumnsRepository implements ITableInColumnsRepository {
  constructor(private db: NodePgDatabase<typeof schema>) {}

  /**
   * Create table in column relationship
   */
  async create(data: CreateTableInColumnDTO): Promise<TableInColumn> {
    try {
      const [result] = await this.db
        .insert(tableInColumns)
        .values({
          parent_board_id: data.parent_board_id,
          parent_board_item_id: data.parent_board_item_id,
          parent_board_field_id: data.parent_board_field_id,
          child_board_id: data.child_board_id,
          child_board_item_id: data.child_board_item_id,
          created_by: data.created_by,
        })
        .returning();

      logger.debug(`TableInColumn created: ${result.id}`);
      return this.toEntity(result);
    } catch (error) {
      logger.error("Error creating table in column:", error);
      throw new DatabaseError(
        `Failed to create table in column: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find by parent board item and field
   */
  async findByParent(
    parentBoardItemId: string,
    parentFieldId: string,
  ): Promise<TableInColumn[]> {
    try {
      const results = await this.db
        .select()
        .from(tableInColumns)
        .where(
          and(
            eq(tableInColumns.parent_board_item_id, parentBoardItemId),
            eq(tableInColumns.parent_board_field_id, parentFieldId),
          ),
        );

      return results.map((r) => this.toEntity(r));
    } catch (error) {
      logger.error(
        `Error finding table in columns for parent ${parentBoardItemId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find table in columns: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find by child board item
   */
  async findByChild(childBoardItemId: string): Promise<TableInColumn | null> {
    try {
      const result = await this.db
        .select()
        .from(tableInColumns)
        .where(eq(tableInColumns.child_board_item_id, childBoardItemId))
        .limit(1);

      if (result.length === 0) return null;

      return this.toEntity(result[0]);
    } catch (error) {
      logger.error(
        `Error finding table in column for child ${childBoardItemId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find table in column: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete by parent
   */
  async deleteByParent(
    parentBoardItemId: string,
    parentFieldId: string,
  ): Promise<number> {
    try {
      await this.db
        .delete(tableInColumns)
        .where(
          and(
            eq(tableInColumns.parent_board_item_id, parentBoardItemId),
            eq(tableInColumns.parent_board_field_id, parentFieldId),
          ),
        );

      logger.debug(
        `Deleted table in columns for parent ${parentBoardItemId}:${parentFieldId}`,
      );
      return 0; // Count not easily available
    } catch (error) {
      logger.error(
        `Error deleting table in columns for parent ${parentBoardItemId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to delete table in columns: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete by child
   */
  async deleteByChild(childBoardItemId: string): Promise<void> {
    try {
      await this.db
        .delete(tableInColumns)
        .where(eq(tableInColumns.child_board_item_id, childBoardItemId));

      logger.debug(`Deleted table in column for child ${childBoardItemId}`);
    } catch (error) {
      logger.error(
        `Error deleting table in column for child ${childBoardItemId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to delete table in column: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Convert database row to domain entity
   */
  private toEntity(row: typeof tableInColumns.$inferSelect): TableInColumn {
    return {
      _id: row.id,
      id: row.id,
      parent_board_id: row.parent_board_id,
      parent_board_item_id: row.parent_board_item_id,
      parent_board_field_id: row.parent_board_field_id,
      child_board_id: row.child_board_id,
      child_board_item_id: row.child_board_item_id,
      created_by: row.created_by || undefined,
      updated_by: row.updated_by || undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
