import { describe, it, expect } from "vitest";
import { Store } from "oxigraph";
import {
  assertReadOnlyQuery,
  buildItemTree,
  extractSelectVars,
  runQuery,
  SparqlForbiddenError,
} from "../../core/rdf/sparql.service";
import { boardItemToQuads, boardToQuads, tableInColumnToQuads } from "../../core/rdf/rdf-mapper";
import {
  BoardFieldType,
  BoardType,
  type Board,
} from "../../domain/shared/board.types";
import {
  CreateType,
  type BoardItem,
  type TableInColumn,
} from "../../domain/shared/board-item.types";

function buildSampleStore(): Store {
  const parentBoard: Board = {
    _id: "board-parent",
    id: "board-parent",
    business_unit_id: "bu",
    organization_id: "org",
    name: "Parent",
    type: BoardType.GENERAL,
    order: 0,
    hidden: false,
    fields: [
      {
        id: "f-name",
        name: "Title",
        type: BoardFieldType.SHORT_TEXT,
        isUniqueIdentifier: false,
        isDefault: false,
        hidden: false,
        hiddenOnRecord: false,
        isIdentifier: false,
        isDeprecated: false,
      },
      {
        id: "f-children",
        name: "Children",
        type: BoardFieldType.TABLE_IN_TABLE,
        isUniqueIdentifier: false,
        isDefault: false,
        hidden: false,
        hiddenOnRecord: false,
        isIdentifier: false,
        isDeprecated: false,
        settings: { childBoardId: "board-child" },
      },
    ],
    managers: [],
    show_id: false,
    is_child_table: false,
    created_at: new Date("2026-05-01T00:00:00Z"),
    updated_at: new Date("2026-05-01T00:00:00Z"),
  } as Board;

  const childBoard: Board = {
    ...parentBoard,
    _id: "board-child",
    id: "board-child",
    name: "Child",
    fields: [
      {
        id: "f-name",
        name: "Title",
        type: BoardFieldType.SHORT_TEXT,
        isUniqueIdentifier: false,
        isDefault: false,
        hidden: false,
        hiddenOnRecord: false,
        isIdentifier: false,
        isDeprecated: false,
      },
    ],
  } as Board;

  const parentItem: BoardItem = {
    _id: "p1",
    id: "p1",
    business_unit_id: "bu",
    organization_id: "org",
    board_id: "board-parent",
    created_type: CreateType.MANUAL,
    // Mirror the production shape: scalar field + the TIT field's stringified
    // id-array. The tree builder must drop the TIT raw value.
    fields: {
      "f-name": "Parent One",
      "f-children": '["c1","c2"]',
    },
    related_board_item_list: [],
    conversation_ids: [],
    created_at: new Date("2026-05-01T00:00:00Z"),
    updated_at: new Date("2026-05-01T00:00:00Z"),
  } as BoardItem;

  const childItem1: BoardItem = {
    ...parentItem,
    _id: "c1",
    id: "c1",
    board_id: "board-child",
    fields: { "f-name": "Child A" },
    created_at: new Date("2026-05-02T00:00:00Z"),
  } as BoardItem;
  const childItem2: BoardItem = {
    ...parentItem,
    _id: "c2",
    id: "c2",
    board_id: "board-child",
    fields: { "f-name": "Child B" },
    created_at: new Date("2026-05-03T00:00:00Z"),
  } as BoardItem;

  const link1: TableInColumn = {
    _id: "tic-1",
    id: "tic-1",
    parent_board_id: "board-parent",
    parent_board_item_id: "p1",
    parent_board_field_id: "f-children",
    child_board_id: "board-child",
    child_board_item_id: "c1",
    created_at: new Date(),
    updated_at: new Date(),
  };
  const link2: TableInColumn = { ...link1, _id: "tic-2", id: "tic-2", child_board_item_id: "c2" };

  const store = new Store();
  for (const q of boardToQuads(parentBoard)) store.add(q);
  for (const q of boardToQuads(childBoard)) store.add(q);
  for (const q of boardItemToQuads(parentItem)) store.add(q);
  for (const q of boardItemToQuads(childItem1)) store.add(q);
  for (const q of boardItemToQuads(childItem2)) store.add(q);
  for (const q of tableInColumnToQuads(link1)) store.add(q);
  for (const q of tableInColumnToQuads(link2)) store.add(q);

  return store;
}

describe("sparql.service — assertReadOnlyQuery", () => {
  it("accepts SELECT, ASK, CONSTRUCT, DESCRIBE", () => {
    expect(() => assertReadOnlyQuery("SELECT * WHERE { ?s ?p ?o }")).not.toThrow();
    expect(() => assertReadOnlyQuery("ASK { ?s ?p ?o }")).not.toThrow();
    expect(() =>
      assertReadOnlyQuery("CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }"),
    ).not.toThrow();
  });

  it("rejects update operations", () => {
    expect(() => assertReadOnlyQuery("INSERT DATA { <x> <y> <z> }")).toThrow(
      SparqlForbiddenError,
    );
    expect(() => assertReadOnlyQuery("DELETE WHERE { ?s ?p ?o }")).toThrow();
    expect(() => assertReadOnlyQuery("DROP GRAPH <x>")).toThrow();
    expect(() => assertReadOnlyQuery("CLEAR ALL")).toThrow();
    expect(() => assertReadOnlyQuery("LOAD <x>")).toThrow();
  });

  it("ignores forbidden keywords inside comments", () => {
    expect(() =>
      assertReadOnlyQuery("# DELETE\nSELECT * WHERE { ?s ?p ?o }"),
    ).not.toThrow();
  });
});

describe("sparql.service — runQuery", () => {
  it("runs a SELECT and returns SPARQL JSON results", () => {
    const store = buildSampleStore();
    const result = runQuery(
      store,
      `PREFIX imb: <urn:imbrace:vocab#>
       SELECT ?parent ?child WHERE { ?parent imb:hasChild ?child }`,
    );
    expect(result.kind).toBe("select");
    if (result.kind !== "select") return;
    expect(result.data.head.vars.sort()).toEqual(["child", "parent"]);
    const bindings = result.data.results.bindings;
    expect(bindings).toHaveLength(2);
    expect(bindings[0].parent.type).toBe("uri");
    expect(bindings[0].parent.value).toBe("urn:imbrace:item:p1");
  });

  it("runs an ASK", () => {
    const store = buildSampleStore();
    const result = runQuery(
      store,
      `PREFIX imb: <urn:imbrace:vocab#>
       ASK { ?p imb:hasChild ?c }`,
    );
    expect(result.kind).toBe("ask");
    if (result.kind !== "ask") return;
    expect(result.data).toEqual({ head: {}, boolean: true });
  });

  it("rejects update statements", () => {
    const store = buildSampleStore();
    expect(() => runQuery(store, "INSERT DATA { <x> <y> <z> }")).toThrow(
      SparqlForbiddenError,
    );
  });

  it("hydrate=true: attaches an `_items` map per binding for item-IRI values", () => {
    const store = buildSampleStore();
    const result = runQuery(
      store,
      `PREFIX imb: <urn:imbrace:vocab#>
       SELECT ?item WHERE {
         ?item imb:belongsToBoard <urn:imbrace:board:board-parent> .
       }`,
      { hydrate: true },
    );
    if (result.kind !== "select") throw new Error("expected select");
    const rows = result.data.results.bindings as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty("_items");
    const items = (rows[0] as { _items: Record<string, any> })._items;
    expect(items.item).toBeDefined();
    expect(items.item.id).toBe("p1");
    expect(items.item.board_id).toBe("board-parent");
    expect(items.item.board_name).toBe("Parent");
    // Field values are labeled and typed.
    expect(items.item.fields["f-name"]).toMatchObject({
      name: "Title",
      type: "ShortText",
      value: "Parent One",
    });
  });

  it("hydrate=false (default): does NOT attach `_items`", () => {
    const store = buildSampleStore();
    const result = runQuery(
      store,
      `PREFIX imb: <urn:imbrace:vocab#>
       SELECT ?item WHERE {
         ?item imb:belongsToBoard <urn:imbrace:board:board-parent> .
       }`,
    );
    if (result.kind !== "select") throw new Error("expected select");
    expect(result.data.results.bindings[0]).not.toHaveProperty("_items");
  });

  it("hydrate=true: skips rows with no item-IRI bindings", () => {
    const store = buildSampleStore();
    const result = runQuery(
      store,
      `PREFIX imb: <urn:imbrace:vocab#>
       SELECT ?b WHERE { ?b a imb:Board }`,
      { hydrate: true },
    );
    if (result.kind !== "select") throw new Error("expected select");
    const rows = result.data.results.bindings as Array<
      Record<string, unknown>
    >;
    expect(rows.length).toBeGreaterThan(0);
    // None of these are item IRIs, so no row should have `_items`.
    for (const row of rows) {
      expect(row).not.toHaveProperty("_items");
    }
  });

  it("populates head.vars from the SELECT clause even when bindings are empty", () => {
    const store = buildSampleStore();
    // No item belongs to a board with this fake IRI — query is valid but
    // matches zero rows. vars should still reflect the projection.
    const result = runQuery(
      store,
      `PREFIX imb: <urn:imbrace:vocab#>
       SELECT ?item ?status WHERE {
         ?item imb:belongsToBoard <urn:imbrace:board:does-not-exist> ;
               imb:fieldValue [ imb:field <urn:imbrace:field:x/y> ; imb:value ?status ] .
       }`,
    );
    expect(result.kind).toBe("select");
    if (result.kind !== "select") return;
    expect(result.data.results.bindings).toHaveLength(0);
    // Critical: vars MUST list the projected names even with zero bindings.
    expect(result.data.head.vars).toEqual(["item", "status"]);
  });
});

describe("sparql.service — extractSelectVars", () => {
  it("extracts plain projection vars", () => {
    expect(extractSelectVars("SELECT ?a ?b WHERE { ?a ?p ?b }")).toEqual([
      "a",
      "b",
    ]);
  });

  it("handles DISTINCT and REDUCED modifiers", () => {
    expect(extractSelectVars("SELECT DISTINCT ?x WHERE { ?x a ?t }")).toEqual([
      "x",
    ]);
    expect(extractSelectVars("SELECT REDUCED ?x WHERE { ?x a ?t }")).toEqual([
      "x",
    ]);
  });

  it("captures aliases from AS expressions and ignores vars inside parens", () => {
    expect(
      extractSelectVars(
        "SELECT ?a (COUNT(?x) AS ?cnt) ?b WHERE { ?a ?x ?b }",
      ),
    ).toEqual(["a", "cnt", "b"]);
  });

  it("expands SELECT * to every variable in the query", () => {
    const out = extractSelectVars(
      "SELECT * WHERE { ?s ?p ?o . ?s ?q ?r }",
    );
    expect(out.sort()).toEqual(["o", "p", "q", "r", "s"]);
  });

  it("strips comments before parsing", () => {
    expect(
      extractSelectVars(
        "# SELECT ?ignored\nSELECT ?real WHERE { ?real ?p ?o }",
      ),
    ).toEqual(["real"]);
  });
});

describe("sparql.service — buildItemTree", () => {
  it("returns root items with children grouped by parent field id", () => {
    const store = buildSampleStore();
    const tree = buildItemTree(store, {
      rootBoardId: "board-parent",
      limit: 100,
      offset: 0,
    });
    expect(tree.count).toBe(1);
    expect(tree.data).toHaveLength(1);
    const root = tree.data[0];
    expect(root.id).toBe("p1");
    expect(root.board_id).toBe("board-parent");
    expect(root.board_name).toBe("Parent");

    // Scalar field is wrapped with name/type/value.
    expect(root.fields["f-name"]).toEqual({
      name: "Title",
      type: "ShortText",
      value: "Parent One",
    });

    // TableInTable field keeps name/type but drops the redundant value.
    expect(root.fields["f-children"]).toEqual({
      name: "Children",
      type: "TableInTable",
    });
    expect(root.fields["f-children"]).not.toHaveProperty("value");

    // Children are grouped under { field_name, items }.
    expect(Object.keys(root.children)).toEqual(["f-children"]);
    const group = root.children["f-children"];
    expect(group.field_name).toBe("Children");
    const childIds = group.items.map((c) => c.id).sort();
    expect(childIds).toEqual(["c1", "c2"]);
    // Children belong to the child board.
    expect(group.items[0].board_id).toBe("board-child");
    expect(group.items[0].board_name).toBe("Child");
    // And nested fields are wrapped too.
    expect(group.items[0].fields["f-name"]).toMatchObject({
      name: "Title",
      type: "ShortText",
    });
  });

  it("filters to a single item by itemId, preserving its TIT children", () => {
    const store = buildSampleStore();
    const tree = buildItemTree(store, {
      rootBoardId: "board-parent",
      limit: 100,
      offset: 0,
      itemId: "p1",
    });
    expect(tree.count).toBe(1);
    expect(tree.data).toHaveLength(1);
    expect(tree.data[0].id).toBe("p1");
    // Children block still resolved.
    expect(Object.keys(tree.data[0].children)).toEqual(["f-children"]);
    expect(tree.data[0].children["f-children"].items.map((i) => i.id).sort())
      .toEqual(["c1", "c2"]);
  });

  it("returns a single child item directly when itemId is a child", () => {
    const store = buildSampleStore();
    const tree = buildItemTree(store, {
      rootBoardId: "board-parent",
      limit: 100,
      offset: 0,
      itemId: "c1",
    });
    expect(tree.count).toBe(1);
    expect(tree.data[0].id).toBe("c1");
    expect(tree.data[0].board_id).toBe("board-child");
  });

  it("returns empty data when itemId is not in the materialized graph", () => {
    const store = buildSampleStore();
    const tree = buildItemTree(store, {
      rootBoardId: "board-parent",
      limit: 100,
      offset: 0,
      itemId: "does-not-exist",
    });
    expect(tree).toEqual({ data: [], count: 0 });
  });

  it("paginates root items", () => {
    const store = buildSampleStore();
    const page1 = buildItemTree(store, {
      rootBoardId: "board-parent",
      limit: 1,
      offset: 0,
    });
    expect(page1.data).toHaveLength(1);
    expect(page1.count).toBe(1);

    const beyond = buildItemTree(store, {
      rootBoardId: "board-parent",
      limit: 1,
      offset: 1,
    });
    expect(beyond.data).toHaveLength(0);
    expect(beyond.count).toBe(1);
  });
});
