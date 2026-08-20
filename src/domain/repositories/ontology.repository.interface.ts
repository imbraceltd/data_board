/**
 * Ontology Repository Interface
 *
 * Read-only access for the derived ontology graph view. Used by OntologyService
 * to walk boards / fields / board_items / table_in_columns. Implementations are
 * Postgres-only today (the `table_in_columns` table is Drizzle-defined).
 */

import type { TableInColumn } from "../shared/board-item.types";

export interface OntologyBoardItemSummary {
  id: string;
  board_id: string;
  fields: Record<string, any>;
}

export interface IOntologyRepository {
  /**
   * Find all table_in_columns rows where parent_board_id ∈ ids.
   */
  findTableInColumnsByParentBoardIds(
    parentBoardIds: string[],
  ): Promise<TableInColumn[]>;

  /**
   * Find all table_in_columns rows touching the given item id (as parent or child).
   */
  findTableInColumnsByItemId(itemId: string): Promise<TableInColumn[]>;

  /**
   * Find all table_in_columns rows where any of the given items appear (parent or child).
   */
  findTableInColumnsByItemIds(itemIds: string[]): Promise<TableInColumn[]>;

  /**
   * Fetch board items by id list (used to materialise BoardItem nodes).
   */
  findBoardItemsByIds(itemIds: string[]): Promise<OntologyBoardItemSummary[]>;

  /**
   * Fetch up to `limitPerBoard` items for each board id, scoped to org.
   * Used for the org-wide "items snapshot" mode (no seed_item_id).
   */
  findBoardItemsByBoardIds(
    boardIds: string[],
    organizationId: string,
    limitPerBoard: number,
  ): Promise<OntologyBoardItemSummary[]>;

  /**
   * Fetch a single board item (used to resolve seed_item_id → board).
   */
  findBoardItemById(itemId: string): Promise<OntologyBoardItemSummary | null>;
}
