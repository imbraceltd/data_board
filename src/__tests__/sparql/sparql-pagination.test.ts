/**
 * Pagination + hydrate-cap behavior for runQuery.
 *
 * Guards the fix for the 413 / context-overflow incident: a hydrated SELECT
 * over a large board (production: 2,762 news items ≈ 6.6 MB) must be bounded
 * server-side so it never balloons into the LLM request body. We slice BEFORE
 * hydrating and report `results.meta` so agents can page deterministically.
 */
import { describe, it, expect } from "vitest";
import { Store } from "oxigraph";
import { runQuery } from "../../core/rdf/sparql.service";
import { boardItemToQuads, boardToQuads } from "../../core/rdf/rdf-mapper";
import {
  BoardFieldType,
  BoardType,
  type Board,
} from "../../domain/shared/board.types";
import { CreateType, type BoardItem } from "../../domain/shared/board-item.types";

const BOARD_ID = "board-news";

/** Build a store with one board holding `n` items (titled "Item 000"…). */
function buildBoardWithItems(n: number): Store {
  const board: Board = {
    _id: BOARD_ID,
    id: BOARD_ID,
    business_unit_id: "bu",
    organization_id: "org",
    name: "News",
    type: BoardType.GENERAL,
    order: 0,
    hidden: false,
    fields: [
      {
        id: "f-title",
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
    managers: [],
    show_id: false,
    is_child_table: false,
    created_at: new Date("2026-05-01T00:00:00Z"),
    updated_at: new Date("2026-05-01T00:00:00Z"),
  } as Board;

  const store = new Store();
  for (const q of boardToQuads(board)) store.add(q);
  for (let i = 0; i < n; i++) {
    const id = `n${String(i).padStart(3, "0")}`;
    const item: BoardItem = {
      _id: id,
      id,
      business_unit_id: "bu",
      organization_id: "org",
      board_id: BOARD_ID,
      created_type: CreateType.MANUAL,
      fields: { "f-title": `Item ${String(i).padStart(3, "0")}` },
      related_board_item_list: [],
      conversation_ids: [],
      created_at: new Date("2026-05-01T00:00:00Z"),
      updated_at: new Date("2026-05-01T00:00:00Z"),
    } as BoardItem;
    for (const q of boardItemToQuads(item)) store.add(q);
  }
  return store;
}

const SELECT_ITEMS = `PREFIX imb: <urn:imbrace:vocab#>
  SELECT ?item WHERE { ?item imb:belongsToBoard <urn:imbrace:board:${BOARD_ID}> } ORDER BY ?item`;

describe("runQuery — pagination", () => {
  // Expected use: explicit limit/offset slice the result and report meta so an
  // agent can loop to the next page.
  it("slices by limit/offset and reports pagination meta", () => {
    const store = buildBoardWithItems(10);

    const first = runQuery(store, SELECT_ITEMS, { limit: 4, offset: 0 });
    expect(first.kind).toBe("select");
    if (first.kind !== "select") return;
    expect(first.data.results.bindings).toHaveLength(4);
    expect(first.data.meta).toEqual({
      totalRows: 10,
      offset: 0,
      limit: 4,
      returned: 4,
      hasMore: true,
    });

    // Next page via offset = previous offset + returned.
    const second = runQuery(store, SELECT_ITEMS, { limit: 4, offset: 4 });
    if (second.kind !== "select") return;
    expect(second.data.meta?.offset).toBe(4);
    expect(second.data.meta?.hasMore).toBe(true);
    // Deterministic order → no overlap with the first page.
    expect(second.data.results.bindings[0].item.value).toBe("urn:imbrace:item:n004");
  });

  // Edge case: offset beyond the data returns an empty page, hasMore false.
  it("returns an empty final page when offset runs past the end", () => {
    const store = buildBoardWithItems(10);
    const result = runQuery(store, SELECT_ITEMS, { limit: 4, offset: 12 });
    if (result.kind !== "select") return;
    expect(result.data.results.bindings).toHaveLength(0);
    expect(result.data.meta).toMatchObject({ returned: 0, hasMore: false, totalRows: 10 });
  });

  // Default page size applies when neither caller nor query specifies a LIMIT.
  it("applies the default page limit (50) when none is given", () => {
    const store = buildBoardWithItems(60);
    const result = runQuery(store, SELECT_ITEMS, {});
    if (result.kind !== "select") return;
    expect(result.data.results.bindings).toHaveLength(50);
    expect(result.data.meta).toMatchObject({ totalRows: 60, limit: 50, hasMore: true });
  });

  // Hard cap: a hydrated page can never exceed 50 rows, even if a bigger limit
  // is requested — this is what prevents the multi-MB payload.
  it("hard-caps hydrated pages at 50 rows regardless of requested limit", () => {
    const store = buildBoardWithItems(60);
    const result = runQuery(store, SELECT_ITEMS, { hydrate: true, limit: 100 });
    if (result.kind !== "select") return;
    expect(result.data.results.bindings).toHaveLength(50);
    expect(result.data.meta?.limit).toBe(50);
    // Only the returned page was hydrated.
    expect(result.data.results.bindings[0]._items).toBeDefined();
  });

  // Non-hydrated pages may exceed 50 (lightweight rows) up to the requested
  // limit — confirms the cap is hydrate-specific.
  it("allows non-hydrated pages above 50 rows", () => {
    const store = buildBoardWithItems(60);
    const result = runQuery(store, SELECT_ITEMS, { limit: 100 });
    if (result.kind !== "select") return;
    expect(result.data.results.bindings).toHaveLength(60);
    expect(result.data.meta).toMatchObject({ returned: 60, hasMore: false });
  });
});
