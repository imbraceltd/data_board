/**
 * Request/Response types for BoardItem APIs
 */

import { z } from "zod";
import { CreateType } from "../../domain/shared/board-item.types";

/**
 * Create board item schema
 * Accepts two formats for `fields`:
 *   1. { fields: { fieldId: value } }                             — record format
 *   2. { fields: [{ board_field_id: fieldId, value: v }] }        — legacy array format
 */
export const createBoardItemSchema = z
  .object({
    board_id: z.string().optional(), // Can also be provided via URL param /:boardId
    organization_id: z.string().optional(),
    business_unit_id: z.string().optional(),
    fields: z.union([
      z.record(z.string(), z.any()),
      z.array(z.object({ board_field_id: z.string(), value: z.any() })),
    ]),
    related_board_item_id: z.string().optional(),
    created_type: z.nativeEnum(CreateType).default(CreateType.MANUAL),
    contact_id: z.string().optional(),
  })
  .transform((val) => {
    // Normalise legacy array format into a record
    if (Array.isArray(val.fields)) {
      const fromArray: Record<string, any> = {};
      for (const { board_field_id, value } of val.fields) {
        fromArray[board_field_id] = value;
      }
      return { ...val, fields: fromArray };
    }
    return val;
  });

/**
 * Update board item schema
 * Accepts two formats:
 *   1. { fields: { fieldId: value } }         — new format
 *   2. { data: [{ key: fieldId, value: v }] } — legacy frontend format
 */
export const updateBoardItemSchema = z
  .object({
    fields: z.record(z.string(), z.any()).optional(),
    data: z.array(z.object({ key: z.string(), value: z.any() })).optional(),
    related_board_item_id: z.string().optional(),
    contact_id: z.string().optional(),
  })
  .transform((val) => {
    // Normalise legacy `data` array into `fields` record
    if (val.data && val.data.length > 0) {
      const fromData: Record<string, any> = {};
      for (const { key, value } of val.data) {
        fromData[key] = value;
      }
      return {
        ...val,
        fields: { ...(val.fields || {}), ...fromData },
        data: undefined,
      };
    }
    return val;
  });

/**
 * Bulk create board items schema
 */
export const bulkCreateBoardItemsSchema = z.object({
  items: z.array(createBoardItemSchema).min(1, "At least one item is required"),
});

/**
 * Bulk update board items schema
 */
export const bulkUpdateBoardItemsSchema = z.object({
  ids: z.array(z.string()).min(1, "At least one ID is required"),
  updates: z
    .record(z.string(), z.any())
    .refine((obj) => Object.keys(obj).length > 0, {
      message: "At least one update field is required",
    }),
});

/**
 * Bulk delete board items schema
 */
export const bulkDeleteBoardItemsSchema = z.object({
  ids: z.array(z.string()).min(1, "At least one ID is required"),
});

/**
 * Update by filter schema
 */
export const updateByFilterSchema = z.object({
  filter: z
    .record(z.string(), z.any())
    .refine((obj) => Object.keys(obj).length > 0, {
      message: "Filter is required",
    }),
  updates: z
    .record(z.string(), z.any())
    .refine((obj) => Object.keys(obj).length > 0, {
      message: "Updates are required",
    }),
});

/**
 * Delete by filter schema
 */
export const deleteByFilterSchema = z.object({
  filter: z
    .record(z.string(), z.any())
    .refine((obj) => Object.keys(obj).length > 0, {
      message: "Filter is required",
    }),
});

/**
 * Query options schema
 */
// Legacy (Mongo-era) FE sends sort as a comma-separated string with optional
// `-` prefix for desc, e.g. `fields.<id>` or `-created_at,fields.<id>`. New
// callers may already pass a `{ key: 1|-1 }` record. Accept either and
// normalise to the record shape the repository expects.
const sortSchema = z
  .union([
    z.string(),
    z.record(z.string(), z.union([z.literal(1), z.literal(-1)])),
  ])
  .transform((value) => {
    if (typeof value !== "string") return value;
    const parsed: Record<string, 1 | -1> = {};
    for (const token of value.split(",")) {
      const t = token.trim();
      if (!t) continue;
      if (t.startsWith("-")) parsed[t.slice(1)] = -1;
      else parsed[t] = 1;
    }
    return parsed;
  })
  .optional();

export const queryOptionsSchema = z.object({
  skip: z.coerce.number().int().min(0).default(0),
  // limit=0 means "unlimited" (legacy Mongo "fetch all" convention still used
  // by callers like the Workflow "Get all records" action). The DB
  // adapters apply the LIMIT clause only when limit is truthy, so 0 flows
  // through as no limit. Positive limits are still capped at 1000.
  limit: z.coerce.number().int().min(0).max(1000).default(20),
  sort: sortSchema,
  filter: z.record(z.string(), z.any()).optional(),
  include_parent: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "true" || v === "1"),
});

/**
 * Link related items schema.
 *
 * Accepts two payload shapes:
 *   1. { relatedBoardId, relatedItemIds: [...] }  — canonical
 *   2. { ids: [...] }                              — the shape the web app
 *      actually POSTs (it passes relatedBoardId as an api-helper arg that gets
 *      dropped, and sends the selected ids under `ids`).
 * `relatedBoardId` is OPTIONAL because linking only appends ids to the source
 * item's `related_board_item_list` — the repository never reads relatedBoardId.
 * Requiring it (old schema) made every link from the app 400 with a ZodError.
 */
export const linkRelatedItemsSchema = z
  .object({
    relatedBoardId: z.string().optional(),
    relatedItemIds: z.array(z.string()).optional(),
    ids: z.array(z.string()).optional(),
  })
  .transform((v) => ({
    relatedBoardId: v.relatedBoardId ?? "",
    relatedItemIds:
      v.relatedItemIds && v.relatedItemIds.length > 0
        ? v.relatedItemIds
        : (v.ids ?? []),
  }))
  .refine((v) => v.relatedItemIds.length > 0, {
    message: "At least one related item ID is required (relatedItemIds | ids)",
  });

/**
 * Unlink related items schema
 */
export const unlinkRelatedItemsSchema = linkRelatedItemsSchema;

// Export types
export type CreateBoardItemRequest = z.infer<typeof createBoardItemSchema>;
export type UpdateBoardItemRequest = z.infer<typeof updateBoardItemSchema>;
export type BulkCreateBoardItemsRequest = z.infer<
  typeof bulkCreateBoardItemsSchema
>;
export type BulkUpdateBoardItemsRequest = z.infer<
  typeof bulkUpdateBoardItemsSchema
>;
export type BulkDeleteBoardItemsRequest = z.infer<
  typeof bulkDeleteBoardItemsSchema
>;
export type UpdateByFilterRequest = z.infer<typeof updateByFilterSchema>;
export type DeleteByFilterRequest = z.infer<typeof deleteByFilterSchema>;
export type QueryOptionsRequest = z.infer<typeof queryOptionsSchema>;
export type LinkRelatedItemsRequest = z.infer<typeof linkRelatedItemsSchema>;
export type UnlinkRelatedItemsRequest = z.infer<
  typeof unlinkRelatedItemsSchema
>;
