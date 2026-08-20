import { describe, it, expect } from "vitest";
import {
  boardToQuads,
  boardItemToQuads,
  tableInColumnToQuads,
} from "../../core/rdf/rdf-mapper";
import { IMB } from "../../core/rdf/vocab";
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

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    _id: "board-1",
    id: "board-1",
    business_unit_id: "bu-1",
    organization_id: "org-1",
    name: "Parent Board",
    type: BoardType.GENERAL,
    order: 0,
    hidden: false,
    fields: [
      {
        id: "f-text",
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
        id: "f-tit",
        name: "Subitems",
        type: BoardFieldType.TABLE_IN_TABLE,
        isUniqueIdentifier: false,
        isDefault: false,
        hidden: false,
        hiddenOnRecord: false,
        isIdentifier: false,
        isDeprecated: false,
        settings: { childBoardId: "child-1", childBoardName: "Child" },
      },
    ],
    managers: [],
    show_id: false,
    is_child_table: false,
    created_at: new Date("2026-05-01T00:00:00Z"),
    updated_at: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  } as Board;
}

describe("rdf-mapper — boardToQuads", () => {
  it("emits Board class, name, type, organization, and per-field Field nodes", () => {
    const quads = boardToQuads(makeBoard());

    // basic sanity
    expect(quads.length).toBeGreaterThan(5);

    const names = quads.filter((q) => q.predicate.value === IMB.name.value);
    expect(names).toHaveLength(1);
    expect(names[0].object.value).toBe("Parent Board");

    const hasFieldEdges = quads.filter(
      (q) => q.predicate.value === IMB.hasField.value,
    );
    expect(hasFieldEdges).toHaveLength(2);
  });

  it("emits imb:childBoard for TableInTable fields with settings.childBoardId", () => {
    const quads = boardToQuads(makeBoard());
    const childBoardEdges = quads.filter(
      (q) => q.predicate.value === IMB.childBoard.value,
    );
    expect(childBoardEdges).toHaveLength(1);
    expect(childBoardEdges[0].object.value).toBe("urn:imbrace:board:child-1");
  });

  it("emits identifier flag triples only when true", () => {
    const board = makeBoard({
      fields: [
        {
          id: "f-name",
          name: "Name",
          type: BoardFieldType.SHORT_TEXT,
          isUniqueIdentifier: true,
          isDefault: true,
          hidden: false,
          hiddenOnRecord: false,
          isIdentifier: false,
          isDeprecated: false,
        },
      ],
    });
    const quads = boardToQuads(board);

    const flagPredicates = quads
      .filter(
        (q) =>
          q.predicate.value === IMB.isDefault.value ||
          q.predicate.value === IMB.isUniqueIdentifier.value ||
          q.predicate.value === IMB.isIdentifier.value,
      )
      .map((q) => q.predicate.value);
    // Only the two `true` flags are emitted — isIdentifier (false) is absent.
    expect(flagPredicates.sort()).toEqual(
      [IMB.isDefault.value, IMB.isUniqueIdentifier.value].sort(),
    );
  });

  it("emits hasOption blank nodes for SingleSelection fields with data", () => {
    const board = makeBoard({
      fields: [
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
      ],
    });
    const quads = boardToQuads(board);

    const hasOption = quads.filter(
      (q) => q.predicate.value === IMB.hasOption.value,
    );
    expect(hasOption).toHaveLength(2);
    hasOption.forEach((q) =>
      expect(q.object.termType).toBe("BlankNode"),
    );

    const labels = quads
      .filter((q) => q.predicate.value === IMB.optionLabel.value)
      .map((q) => q.object.value)
      .sort();
    expect(labels).toEqual(["Done", "In Progress"]);
  });

  it("does NOT emit imb:childBoard for non-TableInTable fields", () => {
    const board = makeBoard({
      fields: [
        {
          id: "f-text",
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
    });
    const quads = boardToQuads(board);
    expect(
      quads.find((q) => q.predicate.value === IMB.childBoard.value),
    ).toBeUndefined();
  });
});

describe("rdf-mapper — boardItemToQuads", () => {
  function makeItem(overrides: Partial<BoardItem> = {}): BoardItem {
    return {
      _id: "item-1",
      id: "item-1",
      business_unit_id: "bu-1",
      organization_id: "org-1",
      board_id: "board-1",
      created_type: CreateType.MANUAL,
      fields: { "f-text": "Hello", "f-num": 42 },
      related_board_item_list: [],
      conversation_ids: [],
      created_at: new Date("2026-05-01T00:00:00Z"),
      updated_at: new Date("2026-05-01T00:00:00Z"),
      ...overrides,
    } as BoardItem;
  }

  it("emits belongsToBoard and one fieldValue blank-node per scalar field", () => {
    const quads = boardItemToQuads(makeItem());

    const belongs = quads.filter(
      (q) => q.predicate.value === IMB.belongsToBoard.value,
    );
    expect(belongs).toHaveLength(1);
    expect(belongs[0].object.value).toBe("urn:imbrace:board:board-1");

    const fieldValues = quads.filter(
      (q) => q.predicate.value === IMB.fieldValue.value,
    );
    expect(fieldValues).toHaveLength(2);
    fieldValues.forEach((q) => expect(q.object.termType).toBe("BlankNode"));
  });

  it("skips null/undefined field values", () => {
    const item = {
      ...{
        _id: "item-1",
        id: "item-1",
        business_unit_id: "bu-1",
        organization_id: "org-1",
        board_id: "board-1",
        created_type: CreateType.MANUAL,
        fields: { a: null, b: undefined, c: "ok" },
        related_board_item_list: [],
        conversation_ids: [],
        created_at: new Date(),
        updated_at: new Date(),
      },
    } as unknown as BoardItem;
    const quads = boardItemToQuads(item);
    const fvs = quads.filter((q) => q.predicate.value === IMB.fieldValue.value);
    expect(fvs).toHaveLength(1);
  });
});

describe("rdf-mapper — tableInColumnToQuads", () => {
  it("emits hasChild and viaField for a link", () => {
    const link: TableInColumn = {
      _id: "tic-1",
      id: "tic-1",
      parent_board_id: "board-1",
      parent_board_item_id: "item-parent",
      parent_board_field_id: "f-tit",
      child_board_id: "child-1",
      child_board_item_id: "item-child",
      created_at: new Date(),
      updated_at: new Date(),
    };
    const quads = tableInColumnToQuads(link);
    expect(quads).toHaveLength(2);
    const hasChild = quads.find((q) => q.predicate.value === IMB.hasChild.value);
    expect(hasChild?.subject.value).toBe("urn:imbrace:item:item-parent");
    expect(hasChild?.object.value).toBe("urn:imbrace:item:item-child");
    const via = quads.find((q) => q.predicate.value === IMB.viaField.value);
    expect(via?.subject.value).toBe("urn:imbrace:item:item-child");
    expect(via?.object.value).toBe("urn:imbrace:field:board-1/f-tit");
  });
});
