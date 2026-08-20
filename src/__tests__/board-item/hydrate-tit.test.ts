import { describe, it, expect } from "vitest";
import { BoardItemService } from "../../core/services/board-item.service";
import type {
  DatabaseClient,
  WhereClause,
  FindOptions,
} from "../../infrastructure/database/types";
import type { BoardItem } from "../../domain/shared/board-item.types";

// ---------------------------------------------------------------------------
// Minimal in-memory DatabaseClient. `hydrateTitForBoard` only exercises:
//   - findFirst("boards", { $or: [{id}, {_id}] })   — BoardRepository.findById
//   - findMany("board_items", { board_id, id: {$in} }) — itemRepository.findByFilter
//   - count("board_items", where)                    — findByBoard
// ---------------------------------------------------------------------------
interface Fixtures {
  boards: any[];
  board_items: any[];
}

function rowMatches(row: any, where: WhereClause | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "$or") {
      const ors = v as WhereClause[];
      if (!ors.some((clause) => rowMatches(row, clause))) return false;
      continue;
    }
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

function fakeDb(fx: Fixtures): DatabaseClient {
  return {
    async findFirst<T>(table: string, where?: WhereClause): Promise<T | null> {
      const rows = (fx as any)[table] as any[] | undefined;
      if (!rows) return null;
      return (rows.find((r) => rowMatches(r, where)) ?? null) as T | null;
    },
    async findMany<T>(
      table: string,
      where?: WhereClause,
      _options?: FindOptions,
    ): Promise<T[]> {
      const rows = (fx as any)[table] as any[] | undefined;
      if (!rows) return [] as T[];
      return rows.filter((r) => rowMatches(r, where)) as T[];
    },
    async count(table: string, where?: WhereClause): Promise<number> {
      const rows = (fx as any)[table] as any[] | undefined;
      if (!rows) return 0;
      return rows.filter((r) => rowMatches(r, where)).length;
    },
  } as unknown as DatabaseClient;
}

const TIT_FIELD_ID = "f-tit";
const PARENT_BOARD_ID = "parent-board";
const CHILD_BOARD_ID = "child-board";

function fixtures(): Fixtures {
  return {
    boards: [
      {
        id: PARENT_BOARD_ID,
        organization_id: "org",
        business_unit_id: "bu",
        name: "Parent",
        type: "General",
        order: 0,
        fields: [
          {
            id: "f-name",
            name: "Name",
            type: "ShortText",
            isDefault: true,
          },
          {
            id: TIT_FIELD_ID,
            name: "Children",
            type: "TableInTable",
            settings: { childBoardId: CHILD_BOARD_ID },
          },
        ],
        managers: [],
      },
    ],
    board_items: [
      {
        id: "c1",
        board_id: CHILD_BOARD_ID,
        organization_id: "org",
        business_unit_id: "bu",
        created_type: "manual",
        fields: { "cf-name": "Wireless Mouse", "cf-price": 39 },
      },
      {
        id: "c2",
        board_id: CHILD_BOARD_ID,
        organization_id: "org",
        business_unit_id: "bu",
        created_type: "manual",
        fields: { "cf-name": "Yoga Mat", "cf-price": 25 },
      },
    ],
  };
}

// A "search hit" — a raw parent item whose TIT field is still a child-id array.
function searchHit(titValue: unknown): BoardItem {
  return {
    _id: "p1",
    id: "p1",
    business_unit_id: "bu",
    organization_id: "org",
    board_id: PARENT_BOARD_ID,
    created_type: "manual" as any,
    fields: { "f-name": "Parent One", [TIT_FIELD_ID]: titValue },
    related_board_item_list: [],
    conversation_ids: [],
    created_at: new Date(),
    updated_at: new Date(),
  } as BoardItem;
}

describe("BoardItemService.hydrateTitForBoard", () => {
  it("hydrates a raw TIT id-array into { count, sum, data }", async () => {
    const svc = new BoardItemService({ db: fakeDb(fixtures()) });
    const hit = searchHit(["c1", "c2"]);

    await svc.hydrateTitForBoard(PARENT_BOARD_ID, [hit]);

    const hydrated = hit.fields[TIT_FIELD_ID] as any;
    expect(hydrated.count).toBe(2);
    // Two numeric "cf-price" values (39 + 25) → single summed value.
    expect(hydrated.sum).toBe(64);
    // `_id` is preserved so a FE round-trip (GET → PUT) recognises the row
    // as an existing child and updates in place instead of duplicating.
    expect(hydrated.data).toEqual([
      { _id: "c1", "cf-name": "Wireless Mouse", "cf-price": 39 },
      { _id: "c2", "cf-name": "Yoga Mat", "cf-price": 25 },
    ]);
    // The non-TIT field is untouched.
    expect(hit.fields["f-name"]).toBe("Parent One");
  });

  it("produces count 0 for an empty TIT array", async () => {
    const svc = new BoardItemService({ db: fakeDb(fixtures()) });
    const hit = searchHit([]);

    await svc.hydrateTitForBoard(PARENT_BOARD_ID, [hit]);

    const hydrated = hit.fields[TIT_FIELD_ID] as any;
    expect(hydrated).toEqual({ count: 0, sum: 0, data: [] });
  });

  it("is a no-op for an empty item list", async () => {
    const svc = new BoardItemService({ db: fakeDb(fixtures()) });
    // Should not throw, should not query.
    await expect(
      svc.hydrateTitForBoard(PARENT_BOARD_ID, []),
    ).resolves.toBeUndefined();
  });

  it("is a no-op (no throw) when the board can't be resolved", async () => {
    const svc = new BoardItemService({ db: fakeDb(fixtures()) });
    const hit = searchHit(["c1"]);

    await svc.hydrateTitForBoard("does-not-exist", [hit]);

    // TIT field left as the raw array — board unknown, nothing hydrated.
    expect(hit.fields[TIT_FIELD_ID]).toEqual(["c1"]);
  });
});
