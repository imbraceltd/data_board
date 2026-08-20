/**
 * Ontology Repository (Drizzle / Postgres)
 *
 * Read-only queries used by OntologyService to assemble the ontology graph.
 * Mirrors the pattern in `table-in-columns.repository.ts`: takes a raw
 * `NodePgDatabase` directly because the underlying tables (board_items partitioned,
 * table_in_columns) are Postgres-specific and aren't routed through the
 * `DatabaseClient` abstraction.
 */

import { eq, and, inArray, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  boardItems,
  tableInColumns,
} from "../../../db/drizzle/schema";
import type * as schema from "../../../db/drizzle/schema";
import type {
  IOntologyRepository,
  OntologyBoardItemSummary,
} from "../../../domain/repositories/ontology.repository.interface";
import type { TableInColumn } from "../../../domain/shared/board-item.types";
import { DatabaseError } from "../../../domain/shared/errors";
import logger from "../../logging/logger";

export class OntologyRepository implements IOntologyRepository {
  constructor(private db: NodePgDatabase<typeof schema>) {}

  async findTableInColumnsByParentBoardIds(
    parentBoardIds: string[],
  ): Promise<TableInColumn[]> {
    if (parentBoardIds.length === 0) return [];
    try {
      const rows = await this.db
        .select()
        .from(tableInColumns)
        .where(inArray(tableInColumns.parent_board_id, parentBoardIds));
      return rows.map(this.toTicEntity);
    } catch (error) {
      logger.error("OntologyRepository.findTableInColumnsByParentBoardIds:", error);
      throw new DatabaseError(
        `Failed to load table_in_columns: ${(error as Error).message}`,
      );
    }
  }

  async findTableInColumnsByItemId(itemId: string): Promise<TableInColumn[]> {
    try {
      const rows = await this.db
        .select()
        .from(tableInColumns)
        .where(
          or(
            eq(tableInColumns.parent_board_item_id, itemId),
            eq(tableInColumns.child_board_item_id, itemId),
          ),
        );
      return rows.map(this.toTicEntity);
    } catch (error) {
      logger.error(`OntologyRepository.findTableInColumnsByItemId(${itemId}):`, error);
      throw new DatabaseError(
        `Failed to load table_in_columns: ${(error as Error).message}`,
      );
    }
  }

  async findTableInColumnsByItemIds(
    itemIds: string[],
  ): Promise<TableInColumn[]> {
    if (itemIds.length === 0) return [];
    try {
      const rows = await this.db
        .select()
        .from(tableInColumns)
        .where(
          or(
            inArray(tableInColumns.parent_board_item_id, itemIds),
            inArray(tableInColumns.child_board_item_id, itemIds),
          ),
        );
      return rows.map(this.toTicEntity);
    } catch (error) {
      logger.error("OntologyRepository.findTableInColumnsByItemIds:", error);
      throw new DatabaseError(
        `Failed to load table_in_columns: ${(error as Error).message}`,
      );
    }
  }

  async findBoardItemsByIds(
    itemIds: string[],
  ): Promise<OntologyBoardItemSummary[]> {
    if (itemIds.length === 0) return [];
    try {
      const rows = await this.db
        .select({
          id: boardItems.id,
          board_id: boardItems.board_id,
          fields: boardItems.fields,
        })
        .from(boardItems)
        .where(inArray(boardItems.id, itemIds));
      return rows as OntologyBoardItemSummary[];
    } catch (error) {
      logger.error("OntologyRepository.findBoardItemsByIds:", error);
      throw new DatabaseError(
        `Failed to load board items: ${(error as Error).message}`,
      );
    }
  }

  async findBoardItemsByBoardIds(
    boardIds: string[],
    organizationId: string,
    limitPerBoard: number,
  ): Promise<OntologyBoardItemSummary[]> {
    if (boardIds.length === 0 || limitPerBoard <= 0) return [];
    try {
      // PG window function: pick up to N earliest items per board.
      // The board_items table is hash-partitioned by board_id, so the planner
      // confines the scan to relevant partitions.
      const result = await this.db.execute(sql`
        SELECT id, board_id, fields
        FROM (
          SELECT
            id,
            board_id,
            fields,
            ROW_NUMBER() OVER (PARTITION BY board_id ORDER BY created_at ASC) AS rn
          FROM board_items
          WHERE board_id = ANY(${boardIds})
            AND organization_id = ${organizationId}
        ) t
        WHERE rn <= ${limitPerBoard}
      `);
      // node-pg returns { rows: [...] } but drizzle execute returns it directly
      // depending on version — handle both.
      const rows = (result as any).rows ?? (result as any);
      return (rows as Array<{ id: string; board_id: string; fields: any }>).map(
        (r) => ({ id: r.id, board_id: r.board_id, fields: r.fields ?? {} }),
      );
    } catch (error) {
      logger.error("OntologyRepository.findBoardItemsByBoardIds:", error);
      throw new DatabaseError(
        `Failed to load board items by boards: ${(error as Error).message}`,
      );
    }
  }

  async findBoardItemById(
    itemId: string,
  ): Promise<OntologyBoardItemSummary | null> {
    try {
      const rows = await this.db
        .select({
          id: boardItems.id,
          board_id: boardItems.board_id,
          fields: boardItems.fields,
        })
        .from(boardItems)
        .where(eq(boardItems.id, itemId))
        .limit(1);
      const first = rows[0];
      if (!first) return null;
      return {
        id: first.id,
        board_id: first.board_id,
        fields: (first.fields as Record<string, any>) ?? {},
      };
    } catch (error) {
      logger.error(`OntologyRepository.findBoardItemById(${itemId}):`, error);
      throw new DatabaseError(
        `Failed to load board item: ${(error as Error).message}`,
      );
    }
  }

  private toTicEntity(row: typeof tableInColumns.$inferSelect): TableInColumn {
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
