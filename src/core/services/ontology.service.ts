/**
 * Ontology Service
 *
 * Builds the runtime property-graph view from boards / fields / board_items /
 * table_in_columns. Mirrors the legacy spec at
 * `D:/work/be and IPS/backend/ONTOLOGY_API.md` §`GET /v1/ontology` and
 * §`GET /v1/board/:boardId/connections`.
 *
 * Postgres-only — `table_in_columns` is a Drizzle table without a Mongo
 * equivalent in this repo. The controller short-circuits to 501 when
 * DB_TYPE != postgres.
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/drizzle/schema";
import type { DatabaseClient } from "../../infrastructure/database/types";
import { BoardRepository } from "../../infrastructure/database/repositories/board.repository";
import { OntologyRepository } from "../../infrastructure/database/repositories/ontology.repository";
import {
  BoardFieldType,
  type Board,
  type BoardField,
} from "../../domain/shared/board.types";
import type { TableInColumn } from "../../domain/shared/board-item.types";
import type {
  BoardConnection,
  BoardConnectionLink,
  BoardConnectionsResponse,
  ContainsEdge,
  ContainsItemEdge,
  HasFieldEdge,
  OntologyEdge,
  OntologyGraph,
  OntologyNode,
  OntologyQuery,
  OntologyStats,
  ConnectionsQuery,
  BoardItemNode,
  BoardNode,
  FieldNode,
} from "../../domain/shared/ontology.types";
import { NotFoundError } from "../../domain/shared/errors";

const DEFAULT_ITEM_LIMIT_PER_BOARD = 100;

export interface OntologyServiceConfig {
  db: DatabaseClient;
  drizzleDb: NodePgDatabase<typeof schema>;
}

interface BuildContext {
  organizationId: string;
}

export class OntologyService {
  private boardRepo: BoardRepository;
  private ontologyRepo: OntologyRepository;

  constructor(config: OntologyServiceConfig) {
    this.boardRepo = new BoardRepository(config.db);
    this.ontologyRepo = new OntologyRepository(config.drizzleDb);
  }

  // ---------------------------------------------------------------------------
  // GET /api/ontologies
  // ---------------------------------------------------------------------------

  async buildGraph(
    query: OntologyQuery,
    ctx: BuildContext,
  ): Promise<OntologyGraph> {
    const includeHidden = query.include_hidden === true;
    const includeChildTablesOrgWide = query.include_child_tables === true;
    const itemLimitPerBoard =
      query.item_limit_per_board ?? DEFAULT_ITEM_LIMIT_PER_BOARD;
    const maxDepth =
      query.max_depth === undefined ? Number.POSITIVE_INFINITY : query.max_depth;

    // Step 1: resolve seed_item_id → seed board (forces include_items=true)
    let resolvedSeedBoardId = query.seed_board_id;
    let seedItem: { id: string; board_id: string } | null = null;
    let includeItems = query.include_items === true;
    let seedFound: boolean | undefined;

    if (query.seed_item_id) {
      includeItems = true;
      const item = await this.ontologyRepo.findBoardItemById(query.seed_item_id);
      if (!item) {
        return this.emptyGraphWithSeed({
          item_id: query.seed_item_id,
          board_id: query.seed_board_id,
          found: false,
          max_depth: this.serialiseDepth(maxDepth),
        });
      }
      seedItem = { id: item.id, board_id: item.board_id };
      resolvedSeedBoardId = resolvedSeedBoardId || item.board_id;
      seedFound = true;
    }

    // Step 2: fetch boards in scope
    const allBoards = await this.boardRepo.findByOrganization(ctx.organizationId);

    const buFiltered = query.business_unit_id
      ? allBoards.filter(
          (b) => b.business_unit_id === query.business_unit_id,
        )
      : allBoards;

    const seeded = !!resolvedSeedBoardId;

    // Step 3: build undirected adjacency from TableInTable fields
    const adjacency = this.buildBoardAdjacency(buFiltered);

    // Step 4: BFS from seed if any
    let reachableBoardIds: Set<string> | null = null;
    let reachableCount: number | undefined;
    if (resolvedSeedBoardId) {
      const seedExists = buFiltered.some(
        (b) => this.boardKey(b) === resolvedSeedBoardId,
      );
      if (!seedExists) {
        return this.emptyGraphWithSeed({
          item_id: query.seed_item_id,
          board_id: resolvedSeedBoardId,
          found: false,
          max_depth: this.serialiseDepth(maxDepth),
        });
      }
      seedFound = true;
      reachableBoardIds = this.bfs(adjacency, resolvedSeedBoardId, maxDepth);
      reachableCount = reachableBoardIds.size;
    }

    // Step 5: filter visible boards
    // Per spec: child tables are always included when seeded so CONTAINS edges
    // don't get silently dropped; in org-wide queries respect the flag.
    const allowChildTables = seeded ? true : includeChildTablesOrgWide;
    const allowHidden = includeHidden;

    const keptBoards = buFiltered.filter((b) => {
      const id = this.boardKey(b);
      if (reachableBoardIds && !reachableBoardIds.has(id)) return false;
      if (!allowHidden && b.hidden) return false;
      if (!allowChildTables && b.is_child_table) return false;
      return true;
    });
    const keptBoardIds = new Set(keptBoards.map((b) => this.boardKey(b)));

    // Step 6: emit Board + Field nodes + HAS_FIELD edges; CONTAINS edges
    const nodes: OntologyNode[] = [];
    const edges: OntologyEdge[] = [];
    let droppedStaleEdges = 0;

    for (const board of keptBoards) {
      nodes.push(this.toBoardNode(board));
      for (const field of board.fields) {
        if (field.isDeprecated) continue;
        const fieldNode = this.toFieldNode(board, field);
        nodes.push(fieldNode);
        edges.push(this.toHasFieldEdge(board, fieldNode));
      }
    }

    for (const board of keptBoards) {
      const parentBoardId = this.boardKey(board);
      for (const field of board.fields) {
        if (field.isDeprecated) continue;
        if (field.type !== BoardFieldType.TABLE_IN_TABLE) continue;
        const childBoardId = field.settings?.childBoardId;
        if (!childBoardId) continue;
        if (!keptBoardIds.has(childBoardId)) {
          // child board exists somewhere but was filtered out, OR childBoardId
          // is dangling (board deleted). Either way, count as stale.
          droppedStaleEdges += 1;
          continue;
        }
        edges.push(this.toContainsEdge(parentBoardId, childBoardId, field));
      }
    }

    // Step 7: optional item layer
    if (includeItems) {
      const itemLayer = await this.buildItemLayer({
        keptBoards,
        keptBoardIds,
        seedItem,
        maxDepth,
        itemLimitPerBoard,
        organizationId: ctx.organizationId,
      });
      nodes.push(...itemLayer.nodes);
      edges.push(...itemLayer.edges);
      droppedStaleEdges += itemLayer.droppedStaleEdges;
      if (seedItem) {
        reachableCount = itemLayer.reachableItemCount;
      }
    }

    // Step 8: stats
    const stats: OntologyStats = {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      byType: this.countEdgesByType(edges),
      droppedStaleEdges,
    };
    if (resolvedSeedBoardId || query.seed_item_id) {
      stats.seed = {
        ...(query.seed_item_id ? { item_id: query.seed_item_id } : {}),
        ...(resolvedSeedBoardId ? { board_id: resolvedSeedBoardId } : {}),
        found: seedFound ?? false,
        ...(reachableCount !== undefined ? { reachable: reachableCount } : {}),
        max_depth: this.serialiseDepth(maxDepth),
      };
    }

    return { nodes, edges, stats };
  }

  // ---------------------------------------------------------------------------
  // GET /api/boards/:boardId/connections
  // ---------------------------------------------------------------------------

  async getConnections(
    boardId: string,
    query: ConnectionsQuery,
    ctx: BuildContext,
  ): Promise<BoardConnectionsResponse> {
    const seedBoard = await this.boardRepo.findById(boardId);
    if (!seedBoard || seedBoard.organization_id !== ctx.organizationId) {
      throw new NotFoundError(`Board ${boardId} not found`);
    }
    const seedKey = this.boardKey(seedBoard);

    const allBoards = await this.boardRepo.findByOrganization(
      ctx.organizationId,
    );
    const boardById = new Map(allBoards.map((b) => [this.boardKey(b), b]));

    // Build directed link inventory (for direction labelling) AND undirected
    // adjacency (for BFS). Always include child tables.
    const directedLinks = new Map<string, BoardConnectionLink[]>();
    const adjacency = new Map<string, Set<string>>();

    const ensureSet = (id: string) => {
      let s = adjacency.get(id);
      if (!s) {
        s = new Set();
        adjacency.set(id, s);
      }
      return s;
    };

    for (const board of allBoards) {
      const fromId = this.boardKey(board);
      for (const field of board.fields) {
        if (field.isDeprecated) continue;
        if (field.type !== BoardFieldType.TABLE_IN_TABLE) continue;
        const toId = field.settings?.childBoardId;
        if (!toId || !boardById.has(toId)) continue;
        // Outgoing on the field-owner side, incoming on the target side.
        // Listing semantics: each connection's `links[]` describes how the
        // OTHER board sees its relation to this connection — mirror legacy.
        const onTarget: BoardConnectionLink = {
          otherBoardId: fromId,
          direction: "incoming",
          viaFieldName: field.name,
        };
        const onOwner: BoardConnectionLink = {
          otherBoardId: toId,
          direction: "outgoing",
          viaFieldName: field.name,
        };
        appendLink(directedLinks, toId, onTarget);
        appendLink(directedLinks, fromId, onOwner);
        ensureSet(fromId).add(toId);
        ensureSet(toId).add(fromId);
      }
    }

    const maxDepth =
      query.max_depth === undefined ? Number.POSITIVE_INFINITY : query.max_depth;
    const reachable = this.bfs(adjacency, seedKey, maxDepth);
    reachable.delete(seedKey);

    const connections: BoardConnection[] = [];
    for (const id of reachable) {
      const board = boardById.get(id);
      if (!board) continue;
      connections.push({
        board_id: id,
        name: board.name,
        board_type: board.type ?? "",
        is_child_table: !!board.is_child_table,
        links: directedLinks.get(id) ?? [],
      });
    }

    return {
      source: { board_id: seedKey, name: seedBoard.name },
      count: connections.length,
      max_depth: this.serialiseDepth(maxDepth),
      connected_board_ids: connections.map((c) => c.board_id),
      connections,
    };
  }

  // ---------------------------------------------------------------------------
  // Item layer (Pass C)
  // ---------------------------------------------------------------------------

  private async buildItemLayer(opts: {
    keptBoards: Board[];
    keptBoardIds: Set<string>;
    seedItem: { id: string; board_id: string } | null;
    maxDepth: number;
    itemLimitPerBoard: number;
    organizationId: string;
  }): Promise<{
    nodes: BoardItemNode[];
    edges: ContainsItemEdge[];
    droppedStaleEdges: number;
    reachableItemCount?: number;
  }> {
    const nodes: BoardItemNode[] = [];
    const edges: ContainsItemEdge[] = [];
    let droppedStaleEdges = 0;

    if (opts.seedItem) {
      // Bidirectional BFS over TableInColumns starting from the seed item.
      const visitedItemIds = new Set<string>([opts.seedItem.id]);
      let frontier = [opts.seedItem.id];
      const collectedTics: TableInColumn[] = [];

      for (
        let depth = 0;
        depth < opts.maxDepth && frontier.length > 0;
        depth += 1
      ) {
        const tics = await this.ontologyRepo.findTableInColumnsByItemIds(
          frontier,
        );
        const nextFrontier: string[] = [];
        for (const tic of tics) {
          collectedTics.push(tic);
          if (!visitedItemIds.has(tic.parent_board_item_id)) {
            visitedItemIds.add(tic.parent_board_item_id);
            nextFrontier.push(tic.parent_board_item_id);
          }
          if (!visitedItemIds.has(tic.child_board_item_id)) {
            visitedItemIds.add(tic.child_board_item_id);
            nextFrontier.push(tic.child_board_item_id);
          }
        }
        frontier = nextFrontier;
      }

      const items = await this.ontologyRepo.findBoardItemsByIds(
        Array.from(visitedItemIds),
      );
      const itemById = new Map(items.map((i) => [i.id, i]));
      const boardById = new Map(opts.keptBoards.map((b) => [this.boardKey(b), b]));

      for (const item of items) {
        if (!opts.keptBoardIds.has(item.board_id)) continue;
        const board = boardById.get(item.board_id);
        if (!board) continue;
        nodes.push(this.toBoardItemNode(item, board));
      }
      const emittedIds = new Set(nodes.map((n) => n.properties.itemId));

      // Deduplicate TICs (BFS may visit same row twice)
      const seen = new Set<string>();
      for (const tic of collectedTics) {
        const key = `${tic.parent_board_item_id}->${tic.child_board_item_id}:${tic.parent_board_field_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!emittedIds.has(tic.parent_board_item_id) || !emittedIds.has(tic.child_board_item_id)) {
          droppedStaleEdges += 1;
          continue;
        }
        edges.push(this.toContainsItemEdge(tic));
      }

      return {
        nodes,
        edges,
        droppedStaleEdges,
        reachableItemCount: emittedIds.size,
      };
    }

    // Org-wide item snapshot: cap items per board, then materialise relevant
    // TICs scoped to kept parent boards.
    const keptBoardIdList = Array.from(opts.keptBoardIds);
    const items = await this.ontologyRepo.findBoardItemsByBoardIds(
      keptBoardIdList,
      opts.organizationId,
      opts.itemLimitPerBoard,
    );
    const boardById = new Map(opts.keptBoards.map((b) => [this.boardKey(b), b]));
    for (const item of items) {
      const board = boardById.get(item.board_id);
      if (!board) continue;
      nodes.push(this.toBoardItemNode(item, board));
    }
    const emittedIds = new Set(nodes.map((n) => n.properties.itemId));

    const tics =
      keptBoardIdList.length > 0
        ? await this.ontologyRepo.findTableInColumnsByParentBoardIds(
            keptBoardIdList,
          )
        : [];
    for (const tic of tics) {
      if (
        !emittedIds.has(tic.parent_board_item_id) ||
        !emittedIds.has(tic.child_board_item_id)
      ) {
        droppedStaleEdges += 1;
        continue;
      }
      edges.push(this.toContainsItemEdge(tic));
    }

    return { nodes, edges, droppedStaleEdges };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private boardKey(board: Board): string {
    return board.id ?? board._id;
  }

  private buildBoardAdjacency(boards: Board[]): Map<string, Set<string>> {
    const adjacency = new Map<string, Set<string>>();
    const ids = new Set(boards.map((b) => this.boardKey(b)));
    const ensureSet = (id: string) => {
      let s = adjacency.get(id);
      if (!s) {
        s = new Set();
        adjacency.set(id, s);
      }
      return s;
    };
    for (const board of boards) {
      const from = this.boardKey(board);
      ensureSet(from);
      for (const field of board.fields) {
        if (field.isDeprecated) continue;
        if (field.type !== BoardFieldType.TABLE_IN_TABLE) continue;
        const to = field.settings?.childBoardId;
        if (!to || !ids.has(to)) continue;
        ensureSet(from).add(to);
        ensureSet(to).add(from);
      }
    }
    return adjacency;
  }

  private bfs(
    adjacency: Map<string, Set<string>>,
    seed: string,
    maxDepth: number,
  ): Set<string> {
    const visited = new Set<string>();
    if (!adjacency.has(seed)) {
      visited.add(seed);
      return visited;
    }
    visited.add(seed);
    let frontier = [seed];
    let depth = 0;
    while (frontier.length > 0 && depth < maxDepth) {
      const next: string[] = [];
      for (const id of frontier) {
        const neighbours = adjacency.get(id);
        if (!neighbours) continue;
        for (const n of neighbours) {
          if (!visited.has(n)) {
            visited.add(n);
            next.push(n);
          }
        }
      }
      frontier = next;
      depth += 1;
    }
    return visited;
  }

  private serialiseDepth(maxDepth: number): number | null {
    return Number.isFinite(maxDepth) ? maxDepth : null;
  }

  private emptyGraphWithSeed(seed: NonNullable<OntologyStats["seed"]>): OntologyGraph {
    return {
      nodes: [],
      edges: [],
      stats: {
        nodeCount: 0,
        edgeCount: 0,
        byType: { HAS_FIELD: 0, CONTAINS: 0, CONTAINS_ITEM: 0 },
        droppedStaleEdges: 0,
        seed,
      },
    };
  }

  private countEdgesByType(edges: OntologyEdge[]): OntologyStats["byType"] {
    const counts = { HAS_FIELD: 0, CONTAINS: 0, CONTAINS_ITEM: 0 };
    for (const e of edges) counts[e.type] += 1;
    return counts;
  }

  // ---- Node / edge constructors -------------------------------------------

  private toBoardNode(board: Board): BoardNode {
    const id = this.boardKey(board);
    return {
      id: `board:${id}`,
      type: "Board",
      label: board.name,
      properties: {
        boardId: id,
        boardType: board.type ?? "",
        description: board.description ?? "",
        organizationId: board.organization_id,
        businessUnitId: board.business_unit_id,
        isChildTable: !!board.is_child_table,
      },
    };
  }

  private toFieldNode(board: Board, field: BoardField): FieldNode {
    const slug = this.slugifyFieldName(field.name);
    const boardId = this.boardKey(board);
    return {
      id: `field:${boardId}:${slug}`,
      type: "Field",
      label: field.name,
      properties: {
        fieldName: field.name,
        dataType: field.type,
        description: field.description ?? "",
        isIdentifier: !!(field.isIdentifier || field.isUniqueIdentifier),
        isUnique: !!field.isUniqueIdentifier,
        hidden: !!field.hidden,
        settings: (field.settings as Record<string, unknown>) ?? {},
        defaultOptions:
          field.data?.map((d) => ({ id: d.id, value: d.value })) ?? [],
      },
    };
  }

  private toHasFieldEdge(board: Board, fieldNode: FieldNode): HasFieldEdge {
    const boardNodeId = `board:${this.boardKey(board)}`;
    return {
      id: `edge:HAS_FIELD:${boardNodeId}->${fieldNode.id}`,
      from: boardNodeId,
      to: fieldNode.id,
      type: "HAS_FIELD",
      properties: {} as Record<string, never>,
    };
  }

  private toContainsEdge(
    parentBoardId: string,
    childBoardId: string,
    field: BoardField,
  ): ContainsEdge {
    const fromId = `board:${parentBoardId}`;
    const toId = `board:${childBoardId}`;
    const viaFieldId = `field:${parentBoardId}:${this.slugifyFieldName(field.name)}`;
    return {
      id: `edge:CONTAINS:${fromId}->${toId}:${viaFieldId}`,
      from: fromId,
      to: toId,
      type: "CONTAINS",
      properties: {
        viaFieldId,
        viaFieldName: field.name,
        relationKind: "embedded",
      },
    };
  }

  private toBoardItemNode(
    item: { id: string; board_id: string; fields: Record<string, any> },
    board: Board,
  ): BoardItemNode {
    return {
      id: `item:${item.id}`,
      type: "BoardItem",
      label: this.resolveItemLabel(item, board),
      properties: { itemId: item.id, boardId: item.board_id },
    };
  }

  private toContainsItemEdge(tic: TableInColumn): ContainsItemEdge {
    const fromId = `item:${tic.parent_board_item_id}`;
    const toId = `item:${tic.child_board_item_id}`;
    return {
      id: `edge:CONTAINS_ITEM:${fromId}->${toId}:${tic.parent_board_field_id}`,
      from: fromId,
      to: toId,
      type: "CONTAINS_ITEM",
      properties: {
        viaFieldId: tic.parent_board_field_id,
        parentBoardId: tic.parent_board_id,
        childBoardId: tic.child_board_id,
      },
    };
  }

  private resolveItemLabel(
    item: { id: string; fields: Record<string, any> },
    board: Board,
  ): string {
    const identifierField = board.fields.find(
      (f) => f.isUniqueIdentifier || f.isIdentifier,
    );
    if (identifierField) {
      const raw = item.fields?.[identifierField.id];
      const value = this.coerceLabel(raw);
      if (value) return value;
    }
    return item.id;
  }

  private coerceLabel(raw: unknown): string | null {
    if (raw == null) return null;
    if (typeof raw === "string") return raw.trim() || null;
    if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const lifted = this.coerceLabel(entry);
        if (lifted) return lifted;
      }
      return null;
    }
    if (typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      if (typeof obj.value === "string" && obj.value.trim()) return obj.value.trim();
      if (typeof obj.label === "string" && obj.label.trim()) return obj.label.trim();
    }
    return null;
  }

  private slugifyFieldName(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "field";
  }
}

function appendLink(
  map: Map<string, BoardConnectionLink[]>,
  key: string,
  link: BoardConnectionLink,
): void {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  arr.push(link);
}

