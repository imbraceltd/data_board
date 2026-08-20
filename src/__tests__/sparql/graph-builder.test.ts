import { describe, it, expect } from "vitest";
import {
  buildGraph,
  GraphTooLargeError,
} from "../../core/rdf/graph-builder";
import { NotFoundError } from "../../domain/shared/errors";
import type {
  DatabaseClient,
  WhereClause,
} from "../../infrastructure/database/types";
import { BoardFieldType, BoardType } from "../../domain/shared/board.types";
import { CreateType } from "../../domain/shared/board-item.types";

// ---------------------------------------------------------------------------
// Minimal in-memory DatabaseClient used for these tests.
// Implements only `findMany` (the only call buildGraph makes), with support
// for the `$in` and equality operators it relies on.
// ---------------------------------------------------------------------------

interface Fixtures {
  boards: any[];
  board_items: any[];
  table_in_columns: any[];
}

function fakeDb(fx: Fixtures): DatabaseClient {
  function rowMatches(row: any, where: WhereClause | undefined): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (k.startsWith("$")) continue;
      if (
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        "$in" in (v as any)
      ) {
        if (!(v as any).$in.includes(row[k])) return false;
      } else if (row[k] !== v) {
        return false;
      }
    }
    return true;
  }
  return {
    async findMany<T>(table: string, where?: WhereClause): Promise<T[]> {
      const rows = (fx as any)[table] as any[];
      if (!rows) return [] as T[];
      return rows.filter((r) => rowMatches(r, where)) as T[];
    },
  } as unknown as DatabaseClient;
}

const baseDates = {
  created_at: new Date("2026-05-01T00:00:00Z"),
  updated_at: new Date("2026-05-01T00:00:00Z"),
};

function board(id: string, fields: any[] = []) {
  return {
    id,
    business_unit_id: "bu",
    organization_id: "org",
    name: `Board ${id}`,
    type: BoardType.GENERAL,
    order: 0,
    hidden: false,
    fields,
    managers: [],
    show_id: false,
    is_child_table: false,
    ...baseDates,
  };
}

function titField(id: string, childBoardId: string) {
  return {
    id,
    name: "Children",
    type: BoardFieldType.TABLE_IN_TABLE,
    isUniqueIdentifier: false,
    isDefault: false,
    hidden: false,
    hiddenOnRecord: false,
    isIdentifier: false,
    isDeprecated: false,
    settings: { childBoardId },
  };
}

function item(id: string, boardId: string, fields: Record<string, any> = {}) {
  return {
    id,
    business_unit_id: "bu",
    organization_id: "org",
    board_id: boardId,
    created_type: CreateType.MANUAL,
    fields,
    related_board_item_list: [],
    conversation_ids: [],
    ...baseDates,
  };
}

function tic(p: {
  parent_board_id: string;
  parent_board_item_id: string;
  parent_board_field_id: string;
  child_board_id: string;
  child_board_item_id: string;
}) {
  return { id: `tic-${Math.random()}`, ...p, ...baseDates };
}

describe("graph-builder — BFS over TableInTable", () => {
  it("loads the root board only when maxDepth=1", async () => {
    const db = fakeDb({
      boards: [
        board("A", [titField("fA", "B")]),
        board("B", [titField("fB", "C")]),
        board("C"),
      ],
      board_items: [item("a1", "A"), item("b1", "B"), item("c1", "C")],
      table_in_columns: [],
    });
    const result = await buildGraph(db, {
      rootBoardId: "A",
      organizationId: "org",
      maxDepth: 1,
    });
    expect(result.boardIds).toEqual(["A"]);
    // Only items in A should be loaded.
    expect(result.itemCount).toBe(1);
  });

  it("expands transitively up to maxDepth", async () => {
    const db = fakeDb({
      boards: [
        board("A", [titField("fA", "B")]),
        board("B", [titField("fB", "C")]),
        board("C"),
      ],
      board_items: [item("a1", "A"), item("b1", "B"), item("c1", "C")],
      table_in_columns: [
        tic({
          parent_board_id: "A",
          parent_board_item_id: "a1",
          parent_board_field_id: "fA",
          child_board_id: "B",
          child_board_item_id: "b1",
        }),
      ],
    });
    const result = await buildGraph(db, {
      rootBoardId: "A",
      organizationId: "org",
      maxDepth: 5,
    });
    expect(result.boardIds.sort()).toEqual(["A", "B", "C"]);
    expect(result.itemCount).toBe(3);
    expect(result.linkCount).toBe(1);
  });

  it("discovers per-row child boards via table_in_columns (not just via field.settings.childBoardId)", async () => {
    // "Subitems" pattern: parent board A has a TIT field whose template
    // points to template board B, but each parent item has its OWN private
    // child board (B1, B2) reachable only via the junction table.
    const db = fakeDb({
      boards: [
        board("A", [titField("fA", "B-template")]),
        // B-template is the schema-only board referenced by settings.childBoardId
        board("B-template"),
        // B1 and B2 are per-row child boards — only reachable via TIC
        board("B1"),
        board("B2"),
      ],
      board_items: [
        item("a1", "A"),
        item("a2", "A"),
        item("b1-item", "B1"),
        item("b2-item", "B2"),
      ],
      table_in_columns: [
        tic({
          parent_board_id: "A",
          parent_board_item_id: "a1",
          parent_board_field_id: "fA",
          child_board_id: "B1",
          child_board_item_id: "b1-item",
        }),
        tic({
          parent_board_id: "A",
          parent_board_item_id: "a2",
          parent_board_field_id: "fA",
          child_board_id: "B2",
          child_board_item_id: "b2-item",
        }),
      ],
    });
    const result = await buildGraph(db, {
      rootBoardId: "A",
      organizationId: "org",
      maxDepth: 5,
    });
    // The graph should include the template AND both per-row child boards.
    expect(result.boardIds.sort()).toEqual(["A", "B-template", "B1", "B2"]);
    // Items from per-row boards must be loaded too.
    expect(result.itemCount).toBe(4);
    expect(result.linkCount).toBe(2);
  });

  it("terminates on cyclic TableInTable references", async () => {
    const db = fakeDb({
      boards: [
        board("A", [titField("fA", "B")]),
        board("B", [titField("fB", "A")]),
      ],
      board_items: [item("a1", "A"), item("b1", "B")],
      table_in_columns: [],
    });
    const result = await buildGraph(db, {
      rootBoardId: "A",
      organizationId: "org",
      maxDepth: 10,
    });
    expect(result.boardIds.sort()).toEqual(["A", "B"]);
  });

  it("throws NotFoundError when root board does not exist in the org", async () => {
    const db = fakeDb({
      boards: [
        { ...board("A"), organization_id: "other-org" },
      ],
      board_items: [],
      table_in_columns: [],
    });
    await expect(
      buildGraph(db, {
        rootBoardId: "A",
        organizationId: "org",
        maxDepth: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws GraphTooLargeError when maxQuads is exceeded", async () => {
    const items = Array.from({ length: 200 }, (_, i) =>
      item(`i${i}`, "A", { f: `value-${i}` }),
    );
    const db = fakeDb({
      boards: [board("A")],
      board_items: items,
      table_in_columns: [],
    });
    await expect(
      buildGraph(db, {
        rootBoardId: "A",
        organizationId: "org",
        maxDepth: 1,
        maxQuads: 50,
      }),
    ).rejects.toBeInstanceOf(GraphTooLargeError);
  });
});
