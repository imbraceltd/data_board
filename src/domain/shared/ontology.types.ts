/**
 * Ontology Domain Types
 *
 * Property-graph view derived from boards / fields / board_items / table_in_columns.
 * Mirrors the legacy spec at `D:/work/be and IPS/backend/ONTOLOGY_API.md` §`GET /v1/ontology`.
 */

export type OntologyNodeType = "Board" | "Field" | "BoardItem";
export type OntologyEdgeType = "HAS_FIELD" | "CONTAINS" | "CONTAINS_ITEM";

export interface BoardNode {
  id: string; // "board:<boardId>"
  type: "Board";
  label: string;
  properties: {
    boardId: string;
    boardType: string;
    description: string;
    organizationId: string;
    businessUnitId: string;
    isChildTable: boolean;
  };
}

export interface FieldNode {
  id: string; // "field:<boardId>:<slug>"
  type: "Field";
  label: string;
  properties: {
    fieldName: string;
    dataType: string;
    description: string;
    isIdentifier: boolean;
    isUnique: boolean;
    hidden: boolean;
    settings: Record<string, unknown>;
    defaultOptions: Array<{ id: string; value: string }>;
  };
}

export interface BoardItemNode {
  id: string; // "item:<itemId>"
  type: "BoardItem";
  label: string;
  properties: {
    itemId: string;
    boardId: string;
  };
}

export type OntologyNode = BoardNode | FieldNode | BoardItemNode;

export interface HasFieldEdge {
  id: string;
  from: string; // board:<id>
  to: string; // field:<id>
  type: "HAS_FIELD";
  properties: Record<string, never>;
}

export interface ContainsEdge {
  id: string;
  from: string; // board:<parentId>
  to: string; // board:<childId>
  type: "CONTAINS";
  properties: {
    viaFieldId: string; // field:<boardId>:<slug>
    viaFieldName: string;
    relationKind: "embedded";
  };
}

export interface ContainsItemEdge {
  id: string;
  from: string; // item:<parentId>
  to: string; // item:<childId>
  type: "CONTAINS_ITEM";
  properties: {
    viaFieldId: string; // raw field id (not slug)
    parentBoardId: string;
    childBoardId: string;
  };
}

export type OntologyEdge = HasFieldEdge | ContainsEdge | ContainsItemEdge;

export interface OntologyStats {
  nodeCount: number;
  edgeCount: number;
  byType: {
    HAS_FIELD: number;
    CONTAINS: number;
    CONTAINS_ITEM: number;
  };
  droppedStaleEdges: number;
  seed?: {
    item_id?: string;
    board_id?: string;
    found: boolean;
    reachable?: number;
    max_depth: number | null;
  };
}

export interface OntologyGraph {
  nodes: OntologyNode[];
  edges: OntologyEdge[];
  stats: OntologyStats;
}

export interface OntologyQuery {
  seed_board_id?: string;
  seed_item_id?: string;
  max_depth?: number;
  include_hidden?: boolean;
  include_child_tables?: boolean;
  business_unit_id?: string;
  include_items?: boolean;
  item_limit_per_board?: number;
}

export interface ConnectionsQuery {
  max_depth?: number;
}

export interface BoardConnectionLink {
  otherBoardId: string;
  direction: "incoming" | "outgoing";
  viaFieldName: string;
}

export interface BoardConnection {
  board_id: string;
  name: string;
  board_type: string;
  is_child_table: boolean;
  links: BoardConnectionLink[];
}

export interface BoardConnectionsResponse {
  source: { board_id: string; name: string };
  count: number;
  max_depth: number | null;
  connected_board_ids: string[];
  connections: BoardConnection[];
}
