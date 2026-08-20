/**
 * Pure transformer from the introspection SPARQL bindings to the compact
 * LLM-friendly schema JSON returned by GET /api/boards/:boardId/rdf-schema.
 *
 * Also exports the canonical introspection SPARQL and the static
 * VOCABULARY block that the response embeds so external agents can compose
 * follow-up queries without hardcoding RDF predicates.
 */

import type { Store } from "oxigraph";
import type { SparqlSelectResults } from "./sparql.service";
import {
  IMB,
  iriForField,
  parseBoardIri,
  parseFieldIri,
} from "./vocab";

export const INTROSPECTION_SPARQL = `PREFIX imb: <urn:imbrace:vocab#>
SELECT ?board ?boardName ?field ?fieldName ?fieldType ?childBoard ?childBoardName (COUNT(DISTINCT ?item) AS ?itemCount)
WHERE {
  ?board a imb:Board ;
         imb:name      ?boardName ;
         imb:hasField  ?field .
  ?field  imb:fieldName ?fieldName ;
          imb:fieldType ?fieldType .
  OPTIONAL {
    ?field      imb:childBoard ?childBoard .
    ?childBoard imb:name        ?childBoardName .
  }
  OPTIONAL { ?item imb:belongsToBoard ?board . }
}
GROUP BY ?board ?boardName ?field ?fieldName ?fieldType ?childBoard ?childBoardName
ORDER BY ?boardName ?fieldName`;

export const VOCABULARY = {
  prefix: "urn:imbrace:vocab#",
  iri_shapes: {
    board: "urn:imbrace:board:{boardId}",
    item: "urn:imbrace:item:{itemId}",
    field: "urn:imbrace:field:{boardId}/{fieldId}",
  },
  predicates: [
    {
      name: "imb:belongsToBoard",
      subject: "item",
      object: "board",
      description: "Item → its owning board",
    },
    {
      name: "imb:hasField",
      subject: "board",
      object: "field",
      description: "Board → one of its field definitions",
    },
    {
      name: "imb:fieldValue",
      subject: "item",
      object: "blank",
      description: "Item → blank node carrying (imb:field, imb:value)",
    },
    {
      name: "imb:hasChild",
      subject: "item",
      object: "item",
      description: "Parent item → child item via TableInTable",
    },
    {
      name: "imb:viaField",
      subject: "item",
      object: "field",
      description:
        "Child item → the parent field IRI it was linked through",
    },
    {
      name: "imb:childBoard",
      subject: "field",
      object: "board",
      description: "TableInTable field → the board it nests",
    },
    {
      name: "imb:isDefault",
      subject: "field",
      object: "xsd:boolean",
      description:
        "Field flag — when true, this field is the board's display/title field. Use it to filter items by a user-supplied label.",
    },
    {
      name: "imb:isUniqueIdentifier",
      subject: "field",
      object: "xsd:boolean",
      description: "Field flag — this field uniquely identifies an item.",
    },
    {
      name: "imb:isIdentifier",
      subject: "field",
      object: "xsd:boolean",
      description:
        "Field flag — this field is a secondary identifier (e.g., human-friendly code).",
    },
    {
      name: "imb:hasOption",
      subject: "field",
      object: "blank",
      description:
        "SingleSelection/MultipleSelection field → blank node carrying (imb:optionId, imb:optionLabel)",
    },
    {
      name: "imb:optionId",
      subject: "blank",
      object: "literal",
      description:
        "Option blank node → option id. This is the value stored on items (NOT the label).",
    },
    {
      name: "imb:optionLabel",
      subject: "blank",
      object: "literal",
      description: "Option blank node → human-readable label of the option.",
    },
  ],
  // For each BoardFieldType, document what the value looks like in
  // `imb:value` (storage) and the SPARQL literal pattern to emit when
  // filtering on it (literal). The agent uses `field_types[<type>].literal`
  // as a template — see query_construction_steps.
  field_types: {
    "ShortText|LongText|Email|Phone|Link|Origin|Notes": {
      storage: "plain string",
      literal: '"<value>"',
      notes: "Quote the user's value verbatim.",
    },
    Country: {
      storage:
        'JSON object literal — the raw value is `{"country_name":"<name>"}`',
      literal:
        'FILTER(CONTAINS(STR(?v), "<name>")) — bind ?v to imb:value, then filter, because the stored literal is a JSON-serialized object',
      notes:
        "Direct `imb:value \"...\"` equality won't match. Bind the value, then CONTAINS on the country name.",
    },
    "Number|Currency|Rating": {
      storage: "numeric literal (xsd:integer or xsd:decimal)",
      literal: "<number>",
      notes: "No quotes. SPARQL parses `42` and `3.14` as typed numbers.",
    },
    Checkbox: {
      storage: "xsd:boolean literal",
      literal: "true | false",
      notes: "Bare boolean literal, no quotes.",
    },
    "Date|Datetime": {
      storage: "xsd:dateTime ISO 8601 string literal",
      literal: '"<ISO-datetime>"^^xsd:dateTime',
      notes: "Use the full datatype suffix to enable typed comparison.",
    },
    "SingleSelection|MultipleSelection": {
      storage: "string — either the option label or option id from options[]",
      literal: '"<options[].label>"',
      notes:
        "Prefer the human label (e.g. the value the user said) since it maps directly from user intent. Look up the field's `options[].label` to find the exact spelling. Fall back to `options[].id` only if multiple options share a label.",
    },
    "Assignee|MultipleAssignee": {
      storage: "user or team id string",
      literal: '"<userId>"',
      notes:
        "These are opaque identifiers, not labels. The schema doesn't currently surface a name → id map; treat as id-only.",
    },
    Priority: {
      storage: "string literal of the priority label",
      literal: '"<priority>"',
      notes: 'e.g. `"Low" | "Medium" | "High" | "Urgent"`.',
    },
    "TableInTable|MapToBoard": {
      storage: "array of child item IDs (hydrated on read)",
      literal: "(do not match on imb:value)",
      notes:
        "Traverse via `imb:hasChild` (direct) or `imb:hasChild+` (transitive). Use `imb:viaField <field-IRI>` to scope by which parent field linked the children.",
    },
    "Attachment|Formula": {
      storage: "opaque — value shape depends on definition",
      literal: '"<string>"',
      notes:
        "Treat as plain string literal; semantics vary per field configuration.",
    },
  },
  // Generic procedure for translating a user request into SPARQL given
  // the board schema above. Strictly board/field-agnostic — every step
  // applies to any future board.
  query_construction_steps: [
    "1. Resolve nouns in the user's request to `boards[].name`. The target board is the most specific noun match.",
    "2. Resolve qualifiers/filters to fields on the target board. Match against `fields[].name` (case-insensitive) and `fields[].type`.",
    "3. For each filter, emit `?item imb:fieldValue [ imb:field <field-IRI> ; imb:value <literal> ]`. Construct <literal> using `field_types[<field.type>].literal`.",
    "4. For SingleSelection / MultipleSelection filters, the literal is the option label — look it up in the field's `options[].label`.",
    "5. Always scope each item to its board: `?item imb:belongsToBoard <board-IRI>`.",
    "6. For aggregations use `SELECT (COUNT(?item) AS ?count)`; for lists, ALSO project each field the user asked about by chaining `imb:fieldValue` patterns — see the 'list items with several field values' example. A bare `SELECT ?item` returns only opaque IRIs.",
    "7. Alternatively (or in addition), append `?hydrate=true` to the /sparql request URL. The server resolves every binding whose value is an `urn:imbrace:item:…` IRI into a full `_items` map on the row: id, board_id, board_name, and labeled fields. Useful when you want item context without writing multi-pattern projections.",
    "8. For cross-board navigation use `?parent imb:hasChild ?child` (or `imb:hasChild+` for transitive). Use `imb:viaField` to scope by which parent field linked them.",
  ],
  examples: [
    {
      purpose: "list items in a board with one field value",
      query:
        "PREFIX imb: <urn:imbrace:vocab#>\nSELECT ?item ?title WHERE {\n  ?item imb:belongsToBoard <urn:imbrace:board:BOARD_ID> ;\n        imb:fieldValue [ imb:field <urn:imbrace:field:BOARD_ID/FIELD_ID> ; imb:value ?title ] .\n}",
    },
    {
      purpose:
        "list items with SEVERAL field values projected (chain multiple imb:fieldValue patterns)",
      query:
        "PREFIX imb: <urn:imbrace:vocab#>\nSELECT ?item ?name ?status ?total WHERE {\n  ?item imb:belongsToBoard <urn:imbrace:board:BOARD_ID> ;\n        imb:fieldValue [ imb:field <urn:imbrace:field:BOARD_ID/NAME_FIELD_ID>   ; imb:value ?name ] ;\n        imb:fieldValue [ imb:field <urn:imbrace:field:BOARD_ID/STATUS_FIELD_ID> ; imb:value ?status ] ;\n        imb:fieldValue [ imb:field <urn:imbrace:field:BOARD_ID/TOTAL_FIELD_ID>  ; imb:value ?total ] .\n}",
      notes:
        "Add one `imb:fieldValue [ imb:field <field-IRI> ; imb:value ?var ]` clause per field you want to project. A bare `SELECT ?item` only returns opaque item IRIs. If you'd rather skip the multi-pattern projection, call the endpoint with `?hydrate=true` and the server inlines all fields per binding.",
    },
    {
      purpose: "parent items with their TableInTable children",
      query:
        "PREFIX imb: <urn:imbrace:vocab#>\nSELECT ?parent ?child WHERE {\n  ?parent imb:hasChild ?child .\n  ?child  imb:viaField  <urn:imbrace:field:BOARD_ID/FIELD_ID> .\n}",
    },
    {
      purpose:
        "filter items in a board by a field value (generic template — works for any non-TableInTable type)",
      query:
        "PREFIX imb: <urn:imbrace:vocab#>\nSELECT ?item WHERE {\n  ?item imb:belongsToBoard <urn:imbrace:board:BOARD_ID> ;\n        imb:fieldValue [ imb:field <urn:imbrace:field:BOARD_ID/FIELD_ID> ; imb:value <LITERAL> ] .\n}",
      notes:
        "Substitute <LITERAL> using `field_types[<field.type>].literal`. For SingleSelection use the option label from options[]. For Country, replace the inline pattern with the bind-then-FILTER form documented in field_types.Country.",
    },
    {
      purpose:
        "all descendants of a starting item via the TableInTable closure (any depth)",
      query:
        "PREFIX imb: <urn:imbrace:vocab#>\nSELECT ?desc WHERE {\n  <urn:imbrace:item:ITEM_ID> imb:hasChild+ ?desc .\n  ?desc imb:belongsToBoard <urn:imbrace:board:LEAF_BOARD_ID> .\n}",
    },
    {
      purpose:
        "lookup an item by name then traverse to grandchildren in a specific child board",
      query:
        'PREFIX imb: <urn:imbrace:vocab#>\nSELECT ?gc ?gcName WHERE {\n  ?p imb:fieldValue [ imb:field <urn:imbrace:field:ROOT_BOARD_ID/NAME_FIELD_ID> ; imb:value "Parent 1" ] .\n  ?p imb:hasChild/imb:hasChild ?gc .\n  ?gc imb:belongsToBoard <urn:imbrace:board:GRANDCHILD_BOARD_ID> ;\n      imb:fieldValue [ imb:field <urn:imbrace:field:GRANDCHILD_BOARD_ID/NAME_FIELD_ID> ; imb:value ?gcName ] .\n}',
    },
  ],
} as const;

export interface SchemaFieldOption {
  id: string;
  label: string;
}

export interface SchemaFieldDescriptor {
  id: string;
  name: string;
  type: string;
  is_default?: boolean;
  is_unique_identifier?: boolean;
  is_identifier?: boolean;
  childBoard?: { id: string; name: string };
  options?: SchemaFieldOption[];
}

export interface SchemaBoardDescriptor {
  id: string;
  name: string;
  itemCount: number;
  fields: SchemaFieldDescriptor[];
}

export interface SchemaSummary {
  rootBoardId: string;
  boards: SchemaBoardDescriptor[];
  vocabulary: typeof VOCABULARY;
}

export function schemaSummaryFromBindings(
  results: SparqlSelectResults,
  store: Store,
  rootBoardId: string,
): SchemaSummary {
  const boards = new Map<string, SchemaBoardDescriptor>();

  for (const row of results.results.bindings) {
    const boardIri = row.board?.value;
    if (!boardIri) continue;
    const boardId = parseBoardIri(boardIri);
    if (!boardId) continue;

    let board = boards.get(boardId);
    if (!board) {
      board = {
        id: boardId,
        name: row.boardName?.value ?? "",
        itemCount: row.itemCount ? Number(row.itemCount.value) || 0 : 0,
        fields: [],
      };
      boards.set(boardId, board);
    }

    const fieldIri = row.field?.value;
    if (!fieldIri) continue;
    const parsed = parseFieldIri(fieldIri);
    if (!parsed) continue;

    const fieldDescriptor: SchemaFieldDescriptor = {
      id: parsed.fieldId,
      name: row.fieldName?.value ?? "",
      type: row.fieldType?.value ?? "",
    };

    enrichFieldFromStore(
      fieldDescriptor,
      store,
      parsed.boardId,
      parsed.fieldId,
    );

    const childBoardIri = row.childBoard?.value;
    if (childBoardIri) {
      const childId = parseBoardIri(childBoardIri);
      if (childId) {
        fieldDescriptor.childBoard = {
          id: childId,
          name: row.childBoardName?.value ?? "",
        };
      }
    }

    board.fields.push(fieldDescriptor);
  }

  // Surface the root board first, then the rest in the order they appeared
  // (which is alphabetic-by-board-name per the introspection ORDER BY).
  const ordered: SchemaBoardDescriptor[] = [];
  const root = boards.get(rootBoardId);
  if (root) ordered.push(root);
  for (const [id, b] of boards) {
    if (id !== rootBoardId) ordered.push(b);
  }

  return {
    rootBoardId,
    boards: ordered,
    vocabulary: VOCABULARY,
  };
}

function enrichFieldFromStore(
  descriptor: SchemaFieldDescriptor,
  store: Store,
  boardId: string,
  fieldId: string,
): void {
  const fieldIri = iriForField(boardId, fieldId);

  if (matchTrueFlag(store, fieldIri, IMB.isDefault)) {
    descriptor.is_default = true;
  }
  if (matchTrueFlag(store, fieldIri, IMB.isUniqueIdentifier)) {
    descriptor.is_unique_identifier = true;
  }
  if (matchTrueFlag(store, fieldIri, IMB.isIdentifier)) {
    descriptor.is_identifier = true;
  }

  const optionQuads = store.match(fieldIri, IMB.hasOption, null);
  if (optionQuads.length === 0) return;

  type RankedOption = SchemaFieldOption & { order: number; seq: number };
  const options: RankedOption[] = [];
  optionQuads.forEach((oq, seq) => {
    if (oq.object.termType !== "BlankNode") return;
    const optNode = oq.object;
    const idQuad = store.match(optNode, IMB.optionId, null)[0];
    const labelQuad = store.match(optNode, IMB.optionLabel, null)[0];
    if (!idQuad || idQuad.object.termType !== "Literal") return;
    const labelValue =
      labelQuad && labelQuad.object.termType === "Literal"
        ? labelQuad.object.value
        : "";
    const orderQuad = store.match(optNode, IMB.optionOrder, null)[0];
    const order =
      orderQuad && orderQuad.object.termType === "Literal"
        ? Number(orderQuad.object.value)
        : Number.POSITIVE_INFINITY;
    options.push({
      id: idQuad.object.value,
      label: labelValue,
      order: Number.isFinite(order) ? order : Number.POSITIVE_INFINITY,
      seq,
    });
  });
  options.sort((a, b) => (a.order - b.order) || (a.seq - b.seq));
  descriptor.options = options.map(({ id, label }) => ({ id, label }));
}

function matchTrueFlag(
  store: Store,
  fieldIri: ReturnType<typeof iriForField>,
  predicate: (typeof IMB)[keyof typeof IMB],
): boolean {
  const q = store.match(fieldIri, predicate, null)[0];
  return !!q && q.object.termType === "Literal" && q.object.value === "true";
}
