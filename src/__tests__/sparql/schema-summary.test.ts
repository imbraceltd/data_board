import { describe, it, expect } from "vitest";
import { Store } from "oxigraph";
import {
  INTROSPECTION_SPARQL,
  schemaSummaryFromBindings,
  VOCABULARY,
} from "../../core/rdf/schema-summary";
import { runQuery } from "../../core/rdf/sparql.service";
import {
  boardItemToQuads,
  boardToQuads,
} from "../../core/rdf/rdf-mapper";
import {
  BoardFieldType,
  BoardType,
  type Board,
} from "../../domain/shared/board.types";
import {
  CreateType,
  type BoardItem,
} from "../../domain/shared/board-item.types";

function makeBoard(overrides: Partial<Board>): Board {
  return {
    _id: "",
    id: "",
    business_unit_id: "bu",
    organization_id: "org",
    name: "",
    type: BoardType.GENERAL,
    order: 0,
    hidden: false,
    fields: [],
    managers: [],
    show_id: false,
    is_child_table: false,
    created_at: new Date("2026-05-01T00:00:00Z"),
    updated_at: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  } as Board;
}

function makeItem(boardId: string, id: string): BoardItem {
  return {
    _id: id,
    id,
    business_unit_id: "bu",
    organization_id: "org",
    board_id: boardId,
    created_type: CreateType.MANUAL,
    fields: {},
    related_board_item_list: [],
    conversation_ids: [],
    created_at: new Date(),
    updated_at: new Date(),
  } as BoardItem;
}

function buildSchemaStore(): Store {
  const parent = makeBoard({
    _id: "board-parent",
    id: "board-parent",
    name: "Parent",
    fields: [
      {
        id: "f-title",
        name: "Title",
        type: BoardFieldType.SHORT_TEXT,
        isUniqueIdentifier: true,
        isDefault: true,
        hidden: false,
        hiddenOnRecord: false,
        isIdentifier: false,
        isDeprecated: false,
      },
      {
        id: "f-status",
        name: "Status",
        type: BoardFieldType.SINGLE_SELECTION,
        isUniqueIdentifier: false,
        isDefault: false,
        hidden: false,
        hiddenOnRecord: false,
        isIdentifier: false,
        isDeprecated: false,
        data: [
          { id: "opt-1", value: "In Progress", order: 1 },
          { id: "opt-2", value: "Done", order: 2 },
        ],
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
  });

  const child = makeBoard({
    _id: "board-child",
    id: "board-child",
    name: "Child",
    fields: [
      {
        id: "f-name",
        name: "Name",
        type: BoardFieldType.SHORT_TEXT,
        isUniqueIdentifier: false,
        isDefault: true,
        hidden: false,
        hiddenOnRecord: false,
        isIdentifier: false,
        isDeprecated: false,
      },
    ],
  });

  const store = new Store();
  for (const q of boardToQuads(parent)) store.add(q);
  for (const q of boardToQuads(child)) store.add(q);
  // Three items in parent, one in child — exercises the COUNT.
  for (const q of boardItemToQuads(makeItem("board-parent", "p1"))) store.add(q);
  for (const q of boardItemToQuads(makeItem("board-parent", "p2"))) store.add(q);
  for (const q of boardItemToQuads(makeItem("board-parent", "p3"))) store.add(q);
  for (const q of boardItemToQuads(makeItem("board-child", "c1"))) store.add(q);
  return store;
}

describe("schema-summary — end-to-end through SPARQL", () => {
  it("transforms introspection bindings into the compact schema JSON", () => {
    const store = buildSchemaStore();
    const result = runQuery(store, INTROSPECTION_SPARQL);
    expect(result.kind).toBe("select");
    if (result.kind !== "select") return;

    const summary = schemaSummaryFromBindings(result.data, store, "board-parent");

    expect(summary.rootBoardId).toBe("board-parent");
    expect(summary.boards).toHaveLength(2);

    // Root board is surfaced first.
    expect(summary.boards[0].id).toBe("board-parent");
    expect(summary.boards[0].name).toBe("Parent");
    expect(summary.boards[0].itemCount).toBe(3);

    const parentFields = summary.boards[0].fields;
    expect(parentFields).toHaveLength(3);

    // Title field — has is_default + is_unique_identifier flags surfaced.
    const title = parentFields.find((f) => f.id === "f-title");
    expect(title).toEqual({
      id: "f-title",
      name: "Title",
      type: "ShortText",
      is_default: true,
      is_unique_identifier: true,
    });

    // TableInTable field carries the childBoard pointer (no options).
    const children = parentFields.find((f) => f.id === "f-children");
    expect(children).toEqual({
      id: "f-children",
      name: "Children",
      type: "TableInTable",
      childBoard: { id: "board-child", name: "Child" },
    });

    // SingleSelection field exposes its options array, ordered by `order`.
    const status = parentFields.find((f) => f.id === "f-status");
    expect(status).toEqual({
      id: "f-status",
      name: "Status",
      type: "SingleSelection",
      options: [
        { id: "opt-1", label: "In Progress" },
        { id: "opt-2", label: "Done" },
      ],
    });

    // Child board appears with its single field and itemCount.
    const childBoard = summary.boards.find((b) => b.id === "board-child");
    expect(childBoard).toBeDefined();
    expect(childBoard!.itemCount).toBe(1);
    expect(childBoard!.fields).toEqual([
      {
        id: "f-name",
        name: "Name",
        type: "ShortText",
        is_default: true,
      },
    ]);
  });

  it("embeds the static vocabulary block with the new entries", () => {
    const store = buildSchemaStore();
    const result = runQuery(store, INTROSPECTION_SPARQL);
    if (result.kind !== "select") throw new Error("expected select");
    const summary = schemaSummaryFromBindings(result.data, store, "board-parent");

    expect(summary.vocabulary).toBe(VOCABULARY);
    expect(summary.vocabulary.prefix).toBe("urn:imbrace:vocab#");

    const predicateNames = summary.vocabulary.predicates.map((p) => p.name);
    expect(predicateNames).toEqual(
      expect.arrayContaining([
        "imb:hasChild",
        "imb:childBoard",
        "imb:isDefault",
        "imb:isUniqueIdentifier",
        "imb:isIdentifier",
        "imb:hasOption",
        "imb:optionId",
        "imb:optionLabel",
      ]),
    );

    // field_types map documents per-BoardFieldType value shapes. Each entry
    // is now structured: { storage, literal, notes } so the agent can build
    // SPARQL filters generically.
    expect(summary.vocabulary.field_types).toBeDefined();
    const selectionEntry =
      summary.vocabulary.field_types["SingleSelection|MultipleSelection"];
    expect(selectionEntry).toMatchObject({
      storage: expect.stringMatching(/option label or option id/i),
      literal: expect.stringMatching(/options\[\]\.label/i),
      notes: expect.any(String),
    });
    // Country gets the bind-then-FILTER recipe because the value is a JSON
    // object literal in storage.
    expect(summary.vocabulary.field_types.Country).toMatchObject({
      literal: expect.stringMatching(/FILTER\(CONTAINS/i),
    });

    // query_construction_steps is the generic playbook — at least 6 numbered
    // steps the agent applies to any board/field combination.
    expect(
      Array.isArray(summary.vocabulary.query_construction_steps),
    ).toBe(true);
    expect(summary.vocabulary.query_construction_steps.length).toBeGreaterThanOrEqual(6);
    // Sanity: the steps reference field_types lookup (the core teaching).
    expect(
      summary.vocabulary.query_construction_steps.join("\n"),
    ).toMatch(/field_types\[/);

    // Examples — six total now (added the multi-field-projection one).
    expect(summary.vocabulary.examples).toHaveLength(6);
    const purposes = summary.vocabulary.examples.map((e) => e.purpose);
    expect(purposes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/several field values projected/i),
        expect.stringMatching(/generic template/i),
        expect.stringMatching(/all descendants/i),
        expect.stringMatching(/lookup an item by name/i),
      ]),
    );
    // The construction steps now mention both the multi-pattern projection
    // and the `?hydrate=true` shortcut.
    const stepsText = summary.vocabulary.query_construction_steps.join("\n");
    expect(stepsText).toMatch(/hydrate=true/i);
    expect(stepsText).toMatch(/chain|chaining|multi-pattern|imb:fieldValue/i);
  });

  it("omits xsd:string datatype from binding objects (LLM noise reduction)", () => {
    const store = buildSchemaStore();
    const result = runQuery(store, INTROSPECTION_SPARQL);
    if (result.kind !== "select") throw new Error("expected select");

    // Every literal in our introspection query is a string (name, fieldName,
    // fieldType, childBoardName) plus an integer (itemCount). The string
    // literals must NOT carry datatype, the integer one must.
    for (const row of result.data.results.bindings) {
      if (row.boardName) expect(row.boardName.datatype).toBeUndefined();
      if (row.fieldName) expect(row.fieldName.datatype).toBeUndefined();
      if (row.fieldType) expect(row.fieldType.datatype).toBeUndefined();
      if (row.itemCount) {
        expect(row.itemCount.datatype).toBe(
          "http://www.w3.org/2001/XMLSchema#integer",
        );
      }
    }
  });

  it("omits identifier flags and options when none apply", () => {
    // Minimal board: a single plain field with no flags or options.
    const board = makeBoard({
      _id: "board-bare",
      id: "board-bare",
      name: "Bare",
      fields: [
        {
          id: "f-plain",
          name: "Plain",
          type: BoardFieldType.SHORT_TEXT,
          isUniqueIdentifier: false,
          isDefault: false,
          hidden: false,
          hiddenOnRecord: false,
          isIdentifier: false,
          isDeprecated: false,
        },
      ],
    });
    const store = new Store();
    for (const q of boardToQuads(board)) store.add(q);

    const result = runQuery(store, INTROSPECTION_SPARQL);
    if (result.kind !== "select") throw new Error("expected select");
    const summary = schemaSummaryFromBindings(result.data, store, "board-bare");

    const field = summary.boards[0].fields[0];
    expect(field).toEqual({ id: "f-plain", name: "Plain", type: "ShortText" });
    expect(field).not.toHaveProperty("is_default");
    expect(field).not.toHaveProperty("is_unique_identifier");
    expect(field).not.toHaveProperty("is_identifier");
    expect(field).not.toHaveProperty("options");
  });
});
