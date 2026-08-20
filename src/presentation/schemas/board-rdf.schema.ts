/**
 * Zod schemas for the RDF/SPARQL endpoints on /boards/:boardId.
 */

import { z } from "zod";

// Default to the ceiling so multi-layer board schemas are fully resolved
// out of the box. The 500k-quad safety cap in graph-builder is the real
// guard against runaway materialization; depth is a soft upper bound that
// callers can lower when they want faster responses on broad graphs.
const depth = z.coerce.number().int().min(1).max(50).default(50);

// LLM-agent callers can opt into YAML for ~25-40% token savings on the
// same payload shape. Only affects JSON-returning responses; CONSTRUCT /
// DESCRIBE keep their RDF body regardless.
//
// Tolerant of common variations: case-insensitive, trims whitespace,
// accepts `yml` as an alias for `yaml`, and unwraps single-value arrays
// (some clients send `format=yaml` twice).
export type ResponseFormat = "json" | "yaml";
const format = z
  .preprocess((v) => {
    const raw = Array.isArray(v) ? v[0] : v;
    if (typeof raw !== "string") return raw;
    const normalized = raw.trim().toLowerCase();
    return normalized === "yml" ? "yaml" : normalized;
  }, z.enum(["json", "yaml"]))
  .default("json");

export const withRelationsQuerySchema = z.object({
  depth,
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  // When provided, the response contains only this single item and its
  // TableInTable descendants. The item must live somewhere in the
  // materialized closure rooted at :boardId; otherwise data is empty.
  item_id: z.string().min(1).optional(),
  format,
});

// Tolerant boolean preprocessing for ?hydrate=true|false (query params are
// always strings; z.coerce.boolean() treats any non-empty string as truthy).
const hydrate = z
  .preprocess((v) => {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      const norm = v.trim().toLowerCase();
      if (norm === "true" || norm === "1") return true;
      if (norm === "false" || norm === "0" || norm === "") return false;
    }
    return v;
  }, z.boolean())
  .default(false);

export const sparqlQuerySchema = z.object({
  depth,
  format,
  // When true, /sparql post-processes SELECT bindings: for each row, every
  // binding whose value is a `urn:imbrace:item:…` IRI gets resolved into
  // an `_items` map containing the item's id, board_id, board_name, and
  // labeled fields. Lets naive `SELECT ?item` queries return meaningful
  // data without writing multi-`imb:fieldValue` projections.
  hydrate,
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

export const sparqlBodySchema = z.object({
  query: z.string().min(1).max(16_384),
});

export const rdfSchemaQuerySchema = z.object({
  depth,
  format,
});
