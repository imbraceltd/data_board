/**
 * RDF vocabulary for the Board domain.
 *
 * Defines stable IRI prefixes, predicate node constants, and a literal
 * coercion helper used by the RDF mapper. No DB or oxigraph Store
 * interaction lives here — this module is pure.
 */

import { namedNode, literal } from "oxigraph";
import type { NamedNode, Literal } from "oxigraph";

export const PREFIX = {
  imb: "urn:imbrace:vocab#",
  board: "urn:imbrace:board:",
  item: "urn:imbrace:item:",
  field: "urn:imbrace:field:",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
} as const;

export const RDF_TYPE = namedNode(PREFIX.rdf + "type");

export const XSD = {
  string: namedNode(PREFIX.xsd + "string"),
  integer: namedNode(PREFIX.xsd + "integer"),
  decimal: namedNode(PREFIX.xsd + "decimal"),
  boolean: namedNode(PREFIX.xsd + "boolean"),
  dateTime: namedNode(PREFIX.xsd + "dateTime"),
} as const;

export const IMB = {
  // Classes
  Board: namedNode(PREFIX.imb + "Board"),
  Field: namedNode(PREFIX.imb + "Field"),
  BoardItem: namedNode(PREFIX.imb + "BoardItem"),

  // Board predicates
  name: namedNode(PREFIX.imb + "name"),
  description: namedNode(PREFIX.imb + "description"),
  type: namedNode(PREFIX.imb + "type"),
  organizationId: namedNode(PREFIX.imb + "organizationId"),
  hasField: namedNode(PREFIX.imb + "hasField"),

  // Field predicates
  fieldName: namedNode(PREFIX.imb + "fieldName"),
  fieldType: namedNode(PREFIX.imb + "fieldType"),
  childBoard: namedNode(PREFIX.imb + "childBoard"),
  isDefault: namedNode(PREFIX.imb + "isDefault"),
  isUniqueIdentifier: namedNode(PREFIX.imb + "isUniqueIdentifier"),
  isIdentifier: namedNode(PREFIX.imb + "isIdentifier"),
  hasOption: namedNode(PREFIX.imb + "hasOption"),
  optionId: namedNode(PREFIX.imb + "optionId"),
  optionLabel: namedNode(PREFIX.imb + "optionLabel"),
  optionOrder: namedNode(PREFIX.imb + "optionOrder"),

  // Item predicates
  belongsToBoard: namedNode(PREFIX.imb + "belongsToBoard"),
  fieldValue: namedNode(PREFIX.imb + "fieldValue"),
  field: namedNode(PREFIX.imb + "field"),
  value: namedNode(PREFIX.imb + "value"),
  hasChild: namedNode(PREFIX.imb + "hasChild"),
  viaField: namedNode(PREFIX.imb + "viaField"),
  createdAt: namedNode(PREFIX.imb + "createdAt"),
  updatedAt: namedNode(PREFIX.imb + "updatedAt"),
} as const;

export function iriForBoard(boardId: string): NamedNode {
  return namedNode(PREFIX.board + encodeURIComponent(boardId));
}

export function iriForItem(itemId: string): NamedNode {
  return namedNode(PREFIX.item + encodeURIComponent(itemId));
}

export function iriForField(boardId: string, fieldId: string): NamedNode {
  return namedNode(
    PREFIX.field +
      encodeURIComponent(boardId) +
      "/" +
      encodeURIComponent(fieldId),
  );
}

// Reverses iriForField: returns { boardId, fieldId } or null when the IRI
// does not match the field IRI shape.
export function parseFieldIri(
  iri: string,
): { boardId: string; fieldId: string } | null {
  if (!iri.startsWith(PREFIX.field)) return null;
  const tail = iri.slice(PREFIX.field.length);
  const slash = tail.indexOf("/");
  if (slash === -1) return null;
  try {
    return {
      boardId: decodeURIComponent(tail.slice(0, slash)),
      fieldId: decodeURIComponent(tail.slice(slash + 1)),
    };
  } catch {
    return null;
  }
}

export function parseItemIri(iri: string): string | null {
  if (!iri.startsWith(PREFIX.item)) return null;
  try {
    return decodeURIComponent(iri.slice(PREFIX.item.length));
  } catch {
    return null;
  }
}

export function parseBoardIri(iri: string): string | null {
  if (!iri.startsWith(PREFIX.board)) return null;
  try {
    return decodeURIComponent(iri.slice(PREFIX.board.length));
  } catch {
    return null;
  }
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export function toLiteral(value: unknown): Literal | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") {
    return literal(value ? "true" : "false", XSD.boolean);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value)
      ? literal(String(value), XSD.integer)
      : literal(String(value), XSD.decimal);
  }
  if (value instanceof Date) {
    return literal(value.toISOString(), XSD.dateTime);
  }
  if (typeof value === "string") {
    if (ISO_DATETIME.test(value) && !Number.isNaN(Date.parse(value))) {
      return literal(value, XSD.dateTime);
    }
    return literal(value);
  }
  // Arrays / plain objects are serialized as a JSON string literal so they
  // remain queryable as opaque values without expanding into the graph.
  return literal(JSON.stringify(value));
}
