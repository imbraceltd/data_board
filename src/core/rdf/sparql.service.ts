/**
 * SPARQL query execution + the convenience tree builder.
 *
 * Both APIs operate on an oxigraph Store produced by graph-builder. The
 * convenience tree builder walks the same in-memory store using RDF/JS-style
 * `match()` calls (which is the Store API surface oxigraph exposes for
 * iteration), so the two endpoints share the same underlying RDF view.
 */

import { namedNode } from "oxigraph";
import type { Store, Term, NamedNode, BlankNode } from "oxigraph";
import {
  IMB,
  PREFIX,
  iriForBoard,
  iriForField,
  iriForItem,
  parseFieldIri,
} from "./vocab";

export interface SparqlSelectResults {
  head: { vars: string[] };
  results: { bindings: Array<Record<string, SparqlBindingValue>> };
  /**
   * Pagination metadata. Present on every SELECT result so callers (LLM agents)
   * can page deterministically: when `hasMore` is true, re-run the same query
   * with `offset = offset + returned` to fetch the next page.
   */
  meta?: {
    totalRows: number;
    offset: number;
    limit: number;
    returned: number;
    hasMore: boolean;
  };
}

export interface SparqlAskResult {
  head: Record<string, never>;
  boolean: boolean;
}

export type SparqlResultsJson = SparqlSelectResults | SparqlAskResult;

interface SparqlBindingValue {
  type: "uri" | "literal" | "bnode";
  value: string;
  datatype?: string;
  "xml:lang"?: string;
}

const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "DELETE",
  "LOAD",
  "CLEAR",
  "DROP",
  "CREATE",
  "ADD",
  "MOVE",
  "COPY",
];

export class SparqlForbiddenError extends Error {
  constructor(keyword: string) {
    super(`SPARQL update operation '${keyword}' is not allowed`);
    this.name = "SparqlForbiddenError";
  }
}

export function assertReadOnlyQuery(query: string): void {
  // Strip line and block comments before scanning so commented-out keywords
  // don't trip the guard.
  const stripped = query
    .replace(/#[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`(?:^|[^A-Za-z0-9_])${kw}(?:[^A-Za-z0-9_]|$)`, "i");
    if (re.test(stripped)) throw new SparqlForbiddenError(kw);
  }
}

export interface RunQueryOptions {
  /** Format hint for CONSTRUCT/DESCRIBE serialization. Defaults to N-Triples. */
  rdfFormat?: "application/n-triples" | "text/turtle";
  /**
   * If true, attach an `_items` map to each SELECT binding row containing
   * resolved item data for every binding whose value is a
   * `urn:imbrace:item:…` IRI. Lets naive agent queries (`SELECT ?item …`)
   * return meaningful field values without writing multi-pattern projections.
   */
  hydrate?: boolean;
  offset?: number;
  limit?: number;
}

/** Default page size when neither the caller nor the query specifies a LIMIT. */
const DEFAULT_PAGE_LIMIT = 50;
/** Hard ceiling for hydrated pages (each row inlines full field data — heavy). */
const MAX_HYDRATE_PAGE = 50;
/** Hard ceiling for non-hydrated pages (rows are lightweight IRIs/literals). */
const MAX_PAGE = 1000;

export type RunQueryResult =
  | { kind: "select"; data: SparqlSelectResults }
  | { kind: "ask"; data: SparqlAskResult }
  | { kind: "graph"; format: string; data: string };

export function runQuery(
  store: Store,
  query: string,
  opts: RunQueryOptions = {},
): RunQueryResult {
  assertReadOnlyQuery(query);
  const result = store.query(query);

  // ASK
  if (typeof result === "boolean") {
    return { kind: "ask", data: { head: {}, boolean: result } };
  }

  // SELECT
  if (Array.isArray(result) && (result.length === 0 || result[0] instanceof Map)) {
    const bindings = result as Map<string, Term>[];
    const rows: Array<Record<string, SparqlBindingValue>> = [];
    for (const row of bindings) {
      const obj: Record<string, SparqlBindingValue> = {};
      for (const [k, term] of row) {
        obj[k] = termToBinding(term);
      }
      rows.push(obj);
    }
    // Derive `vars` from the SELECT clause so the response is correct even
    // when there are zero bindings — matches the SPARQL 1.1 results spec.
    // Falls back to the observed binding keys if extraction fails (very
    // unusual queries) so we never lose information.
    const projected = extractSelectVars(query);
    const fallback = new Set<string>();
    for (const row of bindings) {
      for (const k of row.keys()) fallback.add(k);
    }
    const vars =
      projected.length > 0 ? projected : Array.from(fallback);

    const totalRows = rows.length;
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const queryHasLimit = /\bLIMIT\s+\d+/i.test(query);
    const hardMax = opts.hydrate ? MAX_HYDRATE_PAGE : MAX_PAGE;
    // Default applies only when the caller passed no limit AND the query has
    // no LIMIT of its own; the hard ceiling always wins.
    const requested =
      opts.limit ?? (queryHasLimit ? totalRows : DEFAULT_PAGE_LIMIT);
    const effectiveLimit = Math.min(Math.max(1, requested), hardMax);

    const page = rows.slice(offset, offset + effectiveLimit);

    if (opts.hydrate) {
      attachHydratedItems(store, page);
    }

    return {
      kind: "select",
      data: {
        head: { vars },
        results: { bindings: page },
        meta: {
          totalRows,
          offset,
          limit: effectiveLimit,
          returned: page.length,
          hasMore: offset + page.length < totalRows,
        },
      },
    };
  }

  // CONSTRUCT / DESCRIBE — oxigraph returns Quad[] for these. Serialize via
  // the Store: load into a fresh store and dump in the requested format.
  if (Array.isArray(result)) {
    const tmp = new (store.constructor as { new (): Store })();
    for (const q of result as any[]) tmp.add(q);
    const format = opts.rdfFormat ?? "application/n-triples";
    return { kind: "graph", format, data: tmp.dump({ format }) };
  }

  // Older oxigraph builds return an already-serialized string. Pass through.
  return {
    kind: "graph",
    format: opts.rdfFormat ?? "application/n-triples",
    data: String(result),
  };
}

// Parse the projection variables from a SPARQL SELECT clause. Used by
// runQuery to populate `head.vars` correctly when there are zero bindings
// (oxigraph returns `[]` for empty results, dropping the variable list).
//
// Handles:
//   - SELECT ?a ?b WHERE { ... }
//   - SELECT DISTINCT ?a ?b WHERE { ... }
//   - SELECT (COUNT(?x) AS ?cnt) ?a WHERE { ... }
//   - SELECT *  (falls back to scanning the whole query for ?var refs)
// Comments are stripped first so commented-out vars don't leak in.
export function extractSelectVars(query: string): string[] {
  const stripped = query
    .replace(/#[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");

  const selectMatch = stripped.match(
    /\bSELECT\s+(?:DISTINCT\s+|REDUCED\s+)?([\s\S]+?)(?=\s*(?:WHERE|FROM)\b|\s*\{)/i,
  );
  if (!selectMatch) return [];

  const projection = selectMatch[1].trim();

  if (projection === "*") {
    // Wildcard — collect every variable referenced anywhere in the query.
    const found = new Set<string>();
    const re = /\?([A-Za-z_][\w]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) found.add(m[1]);
    return Array.from(found);
  }

  // Walk the projection: bare `?var` at paren depth 0, or `AS ?var` at any
  // depth, is a projected variable. `?var` references inside expressions
  // like `COUNT(?x)` are NOT projected and must be ignored.
  const seen = new Set<string>();
  const out: string[] = [];
  const tokenRe = /\(|\)|\bAS\s+\?([A-Za-z_][\w]*)|\?([A-Za-z_][\w]*)/gi;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(projection)) !== null) {
    if (m[0] === "(") { depth++; continue; }
    if (m[0] === ")") { depth--; continue; }
    const aliasName = m[1];
    const bareName = m[2];
    const name = aliasName ?? (bareName && depth === 0 ? bareName : null);
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";

function termToBinding(term: Term): SparqlBindingValue {
  switch (term.termType) {
    case "NamedNode":
      return { type: "uri", value: term.value };
    case "BlankNode":
      return { type: "bnode", value: term.value };
    case "Literal": {
      const out: SparqlBindingValue = { type: "literal", value: term.value };
      if (term.language) {
        out["xml:lang"] = term.language;
      } else if (term.datatype && term.datatype.value !== XSD_STRING) {
        // xsd:string is the default datatype for plain literals — omit it
        // to keep responses compact for LLM consumers.
        out.datatype = term.datatype.value;
      }
      return out;
    }
    default:
      return { type: "literal", value: term.value };
  }
}

// ---------------------------------------------------------------------------
// Convenience tree builder for GET /:boardId/items-with-relations
// ---------------------------------------------------------------------------

export interface ItemFieldValue {
  name: string;
  type: string;
  // Omitted entirely for TableInTable fields — the connections live under
  // `children`, so surfacing the raw id-array on the value side is redundant.
  value?: unknown;
}

export interface ItemChildGroup {
  field_name: string;
  items: ItemTreeNode[];
}

export interface ItemTreeNode {
  id: string;
  board_id: string;
  board_name?: string;
  fields: Record<string, ItemFieldValue>;
  children: Record<string, ItemChildGroup>;
  created_at?: string;
  updated_at?: string;
  _cycle?: true;
}

export interface BuildTreeOptions {
  rootBoardId: string;
  limit: number;
  offset: number;
  /**
   * When set, the tree contains only this single item (with its
   * TableInTable descendants), regardless of which board it belongs to —
   * as long as the item lives somewhere in the materialized closure
   * rooted at rootBoardId. `count` is 0 or 1; pagination is ignored.
   */
  itemId?: string;
}

export interface BuildTreeResult {
  data: ItemTreeNode[];
  count: number;
}

interface FieldMeta {
  name: string;
  type: string;
}

interface LabelCache {
  boardName: (boardId: string) => string | undefined;
  fieldMeta: (boardId: string, fieldId: string) => FieldMeta;
}

const TIT_TYPE = "TableInTable";

export function buildItemTree(
  store: Store,
  opts: BuildTreeOptions,
): BuildTreeResult {
  const cache = makeLabelCache(store);

  // Single-item filter: just one node + its TableInTable descendants.
  if (opts.itemId) {
    const itemIri = iriForItem(opts.itemId);
    const exists = store.match(itemIri, IMB.belongsToBoard, null).length > 0;
    if (!exists) return { data: [], count: 0 };
    const node = buildNode(store, itemIri, new Set(), cache);
    return { data: [node], count: 1 };
  }

  const rootBoardIri = iriForBoard(opts.rootBoardId);

  // All items belonging to the root board.
  const belongQuads = store.match(null, IMB.belongsToBoard, rootBoardIri);
  const allRootItemIris: NamedNode[] = belongQuads
    .map((q) => q.subject)
    .filter((s): s is NamedNode => s.termType === "NamedNode");

  // Stable sort by created_at desc (string compare on ISO datetimes works).
  const withTime = allRootItemIris.map((iri) => {
    const cq = store.match(iri, IMB.createdAt, null)[0];
    const created =
      cq && cq.object.termType === "Literal" ? cq.object.value : "";
    return { iri, created };
  });
  withTime.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));

  const total = withTime.length;
  const page = withTime.slice(opts.offset, opts.offset + opts.limit);

  const data = page.map(({ iri }) => buildNode(store, iri, new Set(), cache));

  return { data, count: total };
}

function makeLabelCache(store: Store): LabelCache {
  const boards = new Map<string, string>();
  const fields = new Map<string, FieldMeta>();

  return {
    boardName(boardId) {
      if (boards.has(boardId)) return boards.get(boardId);
      const q = store.match(iriForBoard(boardId), IMB.name, null)[0];
      const name = q && q.object.termType === "Literal" ? q.object.value : undefined;
      if (name !== undefined) boards.set(boardId, name);
      return name;
    },
    fieldMeta(boardId, fieldId) {
      const key = `${boardId} ${fieldId}`;
      const cached = fields.get(key);
      if (cached) return cached;
      const fieldIri = iriForField(boardId, fieldId);
      const nq = store.match(fieldIri, IMB.fieldName, null)[0];
      const tq = store.match(fieldIri, IMB.fieldType, null)[0];
      const meta: FieldMeta = {
        name: nq && nq.object.termType === "Literal" ? nq.object.value : fieldId,
        type: tq && tq.object.termType === "Literal" ? tq.object.value : "",
      };
      fields.set(key, meta);
      return meta;
    },
  };
}

// One item's data without TableInTable children — used both by `buildNode`
// (which then layers children on top) and by SPARQL response hydration.
export interface HydratedItem {
  id: string;
  board_id: string;
  board_name?: string;
  fields: Record<string, ItemFieldValue>;
  created_at?: string;
  updated_at?: string;
}

export function hydrateItem(
  store: Store,
  itemIri: NamedNode,
  cache: LabelCache,
): HydratedItem {
  const node: HydratedItem = {
    id: stripItemPrefix(itemIri.value),
    board_id: "",
    fields: {},
  };

  const belongs = store.match(itemIri, IMB.belongsToBoard, null);
  if (belongs.length > 0 && belongs[0].object.termType === "NamedNode") {
    node.board_id = stripBoardPrefix(belongs[0].object.value);
    const bn = cache.boardName(node.board_id);
    if (bn !== undefined) node.board_name = bn;
  }

  const c = store.match(itemIri, IMB.createdAt, null)[0];
  if (c && c.object.termType === "Literal") node.created_at = c.object.value;
  const u = store.match(itemIri, IMB.updatedAt, null)[0];
  if (u && u.object.termType === "Literal") node.updated_at = u.object.value;

  const fieldValueQuads = store.match(itemIri, IMB.fieldValue, null);
  for (const fvq of fieldValueQuads) {
    if (fvq.object.termType !== "BlankNode") continue;
    const fv = fvq.object as BlankNode;
    const fq = store.match(fv, IMB.field, null)[0];
    const vq = store.match(fv, IMB.value, null)[0];
    if (!fq || !vq) continue;
    if (fq.object.termType !== "NamedNode") continue;
    const parsed = parseFieldIri((fq.object as NamedNode).value);
    if (!parsed) continue;
    const meta = cache.fieldMeta(parsed.boardId, parsed.fieldId);
    const entry: ItemFieldValue = { name: meta.name, type: meta.type };
    // TableInTable values are stringified id arrays — redundant with the
    // `children` block built downstream, so drop the raw value here.
    if (meta.type !== TIT_TYPE) {
      const v = vq.object;
      if (v.termType === "Literal") {
        entry.value = coerceLiteral(v.value, v.datatype?.value);
      } else if (v.termType === "NamedNode") {
        entry.value = v.value;
      } else {
        entry.value = null;
      }
    }
    node.fields[parsed.fieldId] = entry;
  }

  return node;
}

// Exported so `runQuery` (and external callers) can share the same
// memoization with `buildItemTree`.
export { makeLabelCache };

// Walks the SELECT bindings and, for every binding whose value is an
// `urn:imbrace:item:…` IRI, attaches an `_items` map keyed by variable name
// to the same row. The map values are full `HydratedItem` records (id,
// board_id, board_name, fields with labels). Rows with no item-IRI bindings
// are left untouched. The hydration is in-place; the rows array is mutated.
function attachHydratedItems(
  store: Store,
  rows: Array<Record<string, SparqlBindingValue>>,
): void {
  if (rows.length === 0) return;
  const cache = makeLabelCache(store);
  for (const row of rows) {
    const items: Record<string, HydratedItem> = {};
    for (const [varName, binding] of Object.entries(row)) {
      if (
        binding &&
        typeof binding === "object" &&
        (binding as SparqlBindingValue).type === "uri" &&
        typeof (binding as SparqlBindingValue).value === "string" &&
        (binding as SparqlBindingValue).value.startsWith(PREFIX.item)
      ) {
        items[varName] = hydrateItem(
          store,
          namedNode((binding as SparqlBindingValue).value),
          cache,
        );
      }
    }
    if (Object.keys(items).length > 0) {
      (row as Record<string, unknown>)._items = items;
    }
  }
}

function buildNode(
  store: Store,
  itemIri: NamedNode,
  visiting: Set<string>,
  cache: LabelCache,
): ItemTreeNode {
  if (visiting.has(itemIri.value)) {
    // Cycle detected — emit a stub so we don't recurse forever.
    return {
      id: stripItemPrefix(itemIri.value),
      board_id: "",
      fields: {},
      children: {},
      _cycle: true,
    };
  }
  visiting.add(itemIri.value);

  const node: ItemTreeNode = {
    ...hydrateItem(store, itemIri, cache),
    children: {},
  };

  // children grouped by parent field id (recovered from imb:viaField).
  const childQuads = store.match(itemIri, IMB.hasChild, null);
  for (const cq of childQuads) {
    if (cq.object.termType !== "NamedNode") continue;
    const childIri = cq.object as NamedNode;
    let parentFieldId = "_unknown";
    let parentFieldBoardId = node.board_id;
    const viaQuads = store.match(childIri, IMB.viaField, null);
    for (const vqd of viaQuads) {
      if (vqd.object.termType !== "NamedNode") continue;
      const parsed = parseFieldIri((vqd.object as NamedNode).value);
      if (!parsed) continue;
      // viaField may include multiple parent contexts; keep the one whose
      // boardId matches this node's board_id when available.
      if (!node.board_id || parsed.boardId === node.board_id) {
        parentFieldId = parsed.fieldId;
        parentFieldBoardId = parsed.boardId;
        break;
      }
      parentFieldId = parsed.fieldId;
      parentFieldBoardId = parsed.boardId;
    }
    const childNode = buildNode(store, childIri, visiting, cache);
    if (!node.children[parentFieldId]) {
      const fieldName = parentFieldBoardId
        ? cache.fieldMeta(parentFieldBoardId, parentFieldId).name
        : parentFieldId;
      node.children[parentFieldId] = { field_name: fieldName, items: [] };
    }
    node.children[parentFieldId].items.push(childNode);
  }

  visiting.delete(itemIri.value);
  return node;
}

function coerceLiteral(value: string, datatype?: string): unknown {
  if (!datatype) return value;
  switch (datatype) {
    case "http://www.w3.org/2001/XMLSchema#integer":
      return parseInt(value, 10);
    case "http://www.w3.org/2001/XMLSchema#decimal":
      return parseFloat(value);
    case "http://www.w3.org/2001/XMLSchema#boolean":
      return value === "true";
    case "http://www.w3.org/2001/XMLSchema#dateTime":
      return value;
    default:
      return value;
  }
}

function stripItemPrefix(iri: string): string {
  const p = "urn:imbrace:item:";
  return iri.startsWith(p) ? decodeURIComponent(iri.slice(p.length)) : iri;
}

function stripBoardPrefix(iri: string): string {
  const p = "urn:imbrace:board:";
  return iri.startsWith(p) ? decodeURIComponent(iri.slice(p.length)) : iri;
}

// Re-export the iriForItem helper used by tests.
export { iriForItem };
