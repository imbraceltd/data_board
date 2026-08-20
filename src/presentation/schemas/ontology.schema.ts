/**
 * Ontology API request schemas (zod)
 *
 * Query params arrive as strings — booleans and numbers use z.coerce.* to
 * handle that round-trip cleanly.
 */

import { z } from "zod";

const optionalBool = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === "boolean") return v;
    return v === "true" || v === "1";
  })
  .optional();

const optionalNonNegativeInt = z.coerce
  .number()
  .int()
  .nonnegative()
  .optional();

export const ontologyQuerySchema = z.object({
  seed_board_id: z.string().min(1).optional(),
  seed_item_id: z.string().min(1).optional(),
  max_depth: optionalNonNegativeInt,
  include_hidden: optionalBool,
  include_child_tables: optionalBool,
  business_unit_id: z.string().min(1).optional(),
  include_items: optionalBool,
  item_limit_per_board: optionalNonNegativeInt,
});

export const connectionsQuerySchema = z.object({
  max_depth: optionalNonNegativeInt,
});

export type OntologyQueryRequest = z.infer<typeof ontologyQuerySchema>;
export type ConnectionsQueryRequest = z.infer<typeof connectionsQuerySchema>;
