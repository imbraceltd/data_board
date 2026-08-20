/**
 * Materialize a virtual RDF view over a board and its TableInTable closure.
 *
 * Reads boards / board_items / table_in_columns rows via the existing
 * DatabaseClient abstraction (the same one that backs the rest of the app),
 * runs them through the pure mappers, and loads the resulting quads into an
 * in-memory oxigraph Store. No DB writes, no schema changes.
 */

import { Store } from "oxigraph";
import type { DatabaseClient } from "../../infrastructure/database/types";
import { BoardFieldType, type Board } from "../../domain/shared/board.types";
import type {
  BoardItem,
  TableInColumn,
} from "../../domain/shared/board-item.types";
import { NotFoundError } from "../../domain/shared/errors";
import logger from "../../infrastructure/logging/logger";
import {
  boardItemToQuads,
  boardToQuads,
  tableInColumnToQuads,
} from "./rdf-mapper";

export interface BuildGraphOptions {
  rootBoardId: string;
  organizationId: string;
  /** depth = 1 → root only; depth = 5 → root + 4 hops of child boards. */
  maxDepth: number;
  /** Hard cap on quad count; exceeding throws GraphTooLargeError. */
  maxQuads?: number;
}

export interface BuildGraphResult {
  store: Store;
  rootBoard: Board;
  boardIds: string[];
  itemCount: number;
  linkCount: number;
  quadCount: number;
}

const DEFAULT_MAX_QUADS = 500_000;

export class GraphTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphTooLargeError";
  }
}

export async function buildGraph(
  db: DatabaseClient,
  opts: BuildGraphOptions,
): Promise<BuildGraphResult> {
  const maxQuads = opts.maxQuads ?? DEFAULT_MAX_QUADS;
  const store = new Store();
  let quadCount = 0;
  const addAll = (quads: Iterable<any>) => {
    for (const q of quads) {
      store.add(q);
      quadCount++;
      if (quadCount > maxQuads) {
        throw new GraphTooLargeError(
          `Materialized graph exceeded ${maxQuads} quads`,
        );
      }
    }
  };

  // BFS over connected boards. Each iteration:
  //   1. Fetch the boards in the current layer.
  //   2. Fetch all table_in_columns rows whose parent is in the current layer.
  //   3. Build the next layer from BOTH:
  //      a. `field.settings.childBoardId` — the field-level template pointer.
  //      b. `table_in_columns.child_board_id` — per-row child boards (the
  //         "Monday subitems" pattern where each parent item has its own
  //         dedicated child board). The field template still exists but the
  //         actual data lives in per-row boards reachable only via the
  //         junction table.
  // Fetching TIC during BFS (rather than once at the end) also lets us reuse
  // the rows for the `imb:hasChild` quad emission below — no extra round-trip.
  const visited = new Set<string>();
  const boardsById = new Map<string, Board>();
  const collectedLinks: any[] = [];
  let layer: string[] = [opts.rootBoardId];
  let depth = 1;

  while (layer.length > 0 && depth <= opts.maxDepth) {
    const ids = layer.filter((id) => !visited.has(id));
    if (ids.length === 0) break;
    ids.forEach((id) => visited.add(id));

    const rows = await db.findMany<any>("boards", {
      id: { $in: ids },
      organization_id: opts.organizationId,
    });

    for (const row of rows) {
      const board = normalizeBoard(row);
      if (!board.id) continue;
      boardsById.set(board.id, board);
      addAll(boardToQuads(board));
    }

    // Always fetch TIC rows from this layer — they're needed for both
    // traversal and the final hasChild quad emission.
    const tics = await db.findMany<any>("table_in_columns", {
      parent_board_id: { $in: ids },
    });
    for (const tic of tics) collectedLinks.push(tic);

    if (depth >= opts.maxDepth) break;

    const nextLayer = new Set<string>();
    // (a) Template descent: settings.childBoardId
    for (const row of rows) {
      const board = boardsById.get((row.id ?? row._id)?.toString());
      if (!board) continue;
      for (const f of board.fields ?? []) {
        if (
          f.type === BoardFieldType.TABLE_IN_TABLE &&
          f.settings?.childBoardId &&
          !visited.has(f.settings.childBoardId)
        ) {
          nextLayer.add(f.settings.childBoardId);
        }
      }
    }
    // (b) Per-row descent: distinct child_board_id values from TIC.
    for (const tic of tics) {
      if (!visited.has(tic.child_board_id)) nextLayer.add(tic.child_board_id);
    }

    layer = Array.from(nextLayer);
    depth++;
  }

  const rootBoard = boardsById.get(opts.rootBoardId);
  if (!rootBoard) {
    throw new NotFoundError(
      `Board ${opts.rootBoardId} not found in organization ${opts.organizationId}`,
    );
  }

  const boardIds = Array.from(boardsById.keys());

  // Items belonging to any board in the closure.
  const itemRows = await db.findMany<any>("board_items", {
    board_id: { $in: boardIds },
    organization_id: opts.organizationId,
  });
  let itemCount = 0;
  for (const row of itemRows) {
    addAll(boardItemToQuads(normalizeBoardItem(row)));
    itemCount++;
  }

  // TableInTable edges — already gathered during BFS above.
  let linkCount = 0;
  for (const row of collectedLinks) {
    addAll(tableInColumnToQuads(normalizeLink(row)));
    linkCount++;
  }

  logger.debug(
    `[rdf] graph built: ${quadCount} quads, ${boardIds.length} boards, ${itemCount} items, ${linkCount} links`,
  );

  return { store, rootBoard, boardIds, itemCount, linkCount, quadCount };
}

function normalizeBoard(row: any): Board {
  const id = (row.id ?? row._id)?.toString();
  return {
    _id: id,
    id,
    business_unit_id: row.business_unit_id,
    organization_id: row.organization_id,
    name: row.name,
    description: row.description ?? undefined,
    type: row.type,
    order: row.order ?? 0,
    hidden: row.hidden ?? false,
    created_by: row.created_by ?? undefined,
    fields: (row.fields ?? []).map((f: any) => {
      const fid = (f.id ?? f._id)?.toString();
      return { ...f, id: fid, _id: fid };
    }),
    managers: row.managers ?? [],
    journey: row.journey ?? undefined,
    show_id: row.show_id ?? false,
    is_child_table: row.is_child_table ?? false,
    created_at: row.created_at ? new Date(row.created_at) : new Date(),
    updated_at: row.updated_at ? new Date(row.updated_at) : new Date(),
  } as Board;
}

function normalizeBoardItem(row: any): BoardItem {
  const id = (row.id ?? row._id)?.toString();
  return {
    _id: id,
    id,
    business_unit_id: row.business_unit_id,
    organization_id: row.organization_id,
    board_id: row.board_id,
    created_by: row.created_by ?? undefined,
    created_type: row.created_type,
    fields: row.fields ?? {},
    related_board_item_id: row.related_board_item_id ?? undefined,
    related_board_item_list: row.related_board_item_list ?? [],
    conversation_ids: row.conversation_ids ?? [],
    logo_url: row.logo_url ?? undefined,
    created_at: row.created_at ? new Date(row.created_at) : new Date(),
    updated_at: row.updated_at ? new Date(row.updated_at) : new Date(),
  } as BoardItem;
}

function normalizeLink(row: any): TableInColumn {
  const id = (row.id ?? row._id)?.toString();
  return {
    _id: id,
    id,
    parent_board_id: row.parent_board_id,
    parent_board_item_id: row.parent_board_item_id,
    parent_board_field_id: row.parent_board_field_id,
    child_board_id: row.child_board_id,
    child_board_item_id: row.child_board_item_id,
    created_by: row.created_by ?? undefined,
    updated_by: row.updated_by ?? undefined,
    created_at: row.created_at ? new Date(row.created_at) : new Date(),
    updated_at: row.updated_at ? new Date(row.updated_at) : new Date(),
  } as TableInColumn;
}
