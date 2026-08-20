/**
 * Request/Response types for Board APIs
 */

import { z } from "zod";
import { BoardType, BoardFieldType } from "../../domain/shared/board.types";

/**
 * Field settings schema (type-specific)
 */
export const fieldSettingsSchema = z
  .object({
    options: z
      .array(z.object({ id: z.string(), value: z.string() }))
      .optional(),
    mapToBoardId: z.string().optional(),
    countryCode: z.string().optional(),
    currency: z.string().optional(),
    format: z.string().optional(),
    // Sample value for the field (type-specific; JSON-string for structured types).
    // Mirrors the document-models schema editor's `sampleData`. Stored as a free-form
    // string under settings (board-field `settings` is Mixed in the model). For
    // TableInTable this holds the sample rows (JSON), keyed by column name.
    sampleData: z.string().optional(),
  })
  .optional();

// Option items for SingleSelection / MultiSelection / etc.
// `id` is generated server-side (Mongoose doesn't require it on insert), and
// the frontend may not have one yet for newly-added options — see `data[].id`
// in `board.model.ts:32-39`, which only types `id` as String (no required:true).
// The PUT /boards/:id/fields/bulk path already accepts this loose shape via
// `bulkFieldsSchema` (`z.array(z.any())`), so create/update now match.
const fieldDataItemSchema = z.object({
  id: z.string().optional(),
  value: z.string(),
  color: z.string().optional(),
  order: z.number().optional(),
});

/**
 * Create board field schema
 * Uses z.lazy to allow TABLE_IN_TABLE fields to carry nested fields recursively.
 */
export const createBoardFieldSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    name: z.string().min(1, "Field name is required"),
    description: z.string().optional(),
    type: z.nativeEnum(BoardFieldType),
    isUniqueIdentifier: z.boolean().default(false),
    isDefault: z.boolean().default(false),
    settings: fieldSettingsSchema,
    data: z.array(fieldDataItemSchema).optional(),
    fields: z.array(createBoardFieldSchema).optional(), // nested fields for TABLE_IN_TABLE
    role: z.string().optional(),
  }),
);

/**
 * Create board schema
 */
export const createBoardSchema = z.object({
  name: z.string().min(1, "Board name is required"),
  description: z.string().optional(),
  type: z.nativeEnum(BoardType).optional().default(BoardType.GENERAL),
  hidden: z.boolean().default(false),
  fields: z.array(createBoardFieldSchema).optional(),
  team_ids: z.array(z.string()).optional(),
  managers: z
    .array(
      z.object({
        teamId: z.string(),
        teamName: z.string(),
        permissions: z.object({
          read: z.boolean(),
          write: z.boolean(),
          delete: z.boolean().optional(),
        }),
      }),
    )
    .optional(),
  journey: z
    .object({
      enabled: z.boolean(),
      stages: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          order: z.number(),
        }),
      ),
    })
    .optional(),
  order: z.number().optional(),
  show_id: z.boolean().optional(),
  is_child_table: z.boolean().optional(),
  // Category is sent as an id string (or null to clear) and mapped to `category_id`
  // in the controller. Mirrors the /schemas convention (write `category`, read `category_id`).
  category: z.string().nullable().optional(),
});

/**
 * Update board schema
 *
 * z.partial() makes fields optional but does NOT strip `.default(...)`.
 * Without the omit+extend below, every PATCH/PUT that didn't explicitly
 * send `type`/`hidden` got `type:"General"` and `hidden:false` injected
 * by Zod and overwrote the row (e.g. aiv2's PUT when adding a CRM board
 * to an AI agent — only sent the touched fields, board type silently
 * flipped to General).
 */
export const updateBoardSchema = createBoardSchema
  .partial()
  .omit({ type: true, hidden: true })
  .extend({
    type: z.nativeEnum(BoardType).optional(),
    hidden: z.boolean().optional(),
  });

/**
 * Update board field schema
 */
export const updateBoardFieldSchema = z.object({
  name: z.string().min(1, "Field name is required").optional(),
  description: z.string().optional(),
  type: z.nativeEnum(BoardFieldType).optional(),
  isUniqueIdentifier: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  hidden: z.boolean().optional(),
  hiddenOnRecord: z.boolean().optional(),
  settings: fieldSettingsSchema,
  data: z.array(fieldDataItemSchema).optional(),
  promptAI: z.string().optional(),
  isDeprecated: z.boolean().optional(),
  role: z.string().optional(),
});

/**
 * Reorder fields schema
 */
// The frontend (and the legacy Mongo backend it was ported from) send the
// ordered IDs under `fields`, while the PG port renamed the key to `fieldIds`.
// Accept either and normalise to `fieldIds` so the controller stays unchanged.
export const reorderFieldsSchema = z
  .object({
    fieldIds: z.array(z.string()).optional(),
    fields: z.array(z.string()).optional(),
  })
  .transform((v) => ({ fieldIds: v.fieldIds ?? v.fields ?? [] }))
  .refine((v) => v.fieldIds.length > 0, {
    message: "At least one field ID is required",
  });

/**
 * Reorder boards schema
 */
export const reorderBoardsSchema = z.object({
  boardIds: z.array(z.string()).min(1, "At least one board ID is required"),
});

/**
 * Board query filters
 */
const coerceToArray = <T>(schema: z.ZodType<T>) =>
  z.preprocess((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]), schema);

const coerceToBoolean = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}, z.boolean());

export const boardFiltersSchema = z.object({
  types: coerceToArray(z.array(z.nativeEnum(BoardType))).optional(),
  hidden: coerceToBoolean.optional(),
  teamIds: coerceToArray(z.array(z.string())).optional(),
  // Case-insensitive board-name search. Empty/whitespace becomes "" and is
  // treated as "no filter" by the repository (`if (filters.search)`).
  search: z.string().trim().optional(),
  // Restrict to a single category (board.category_id). Empty string = no filter.
  category_id: z.string().trim().optional(),
  // Page size. A request without `limit`, or with a non-numeric / out-of-range
  // value, falls back to 100. The hard ceiling of 500 prevents asking for a
  // huge page by accident.
  //
  // Special case `limit=0` = "no limit": return ALL matching boards. It maps to
  // `undefined`, which both repository paths treat as unbounded
  // (findByOrganization skips `options.limit`; the team-access path slices from
  // `skip` to the end). This is what the FE's `limit=0&include_all=true` intends
  // — previously 0 failed `min(1)` and silently fell back to 100, hiding every
  // board past the 100th in the `order ASC` listing.
  limit: z.coerce
    .number()
    .int()
    .min(0)
    .max(500)
    .catch(100)
    .transform((v) => (v === 0 ? undefined : v)),
  skip: z.coerce.number().int().min(0).default(0).catch(0),
});

/**
 * Bulk fields schema — create or update multiple fields at once
 *
 * For new TABLE_IN_TABLE fields (field_id empty), the frontend sends
 * `child_board_name` and a nested `fields` array describing the columns of the
 * child board. Both must round-trip through validation so the handler can
 * forward them to BoardService.addField, which auto-creates the child board.
 */
export const bulkFieldSchema = z.object({
  field_id: z.string().optional(),
  name: z.string().min(1, "Field name is required"),
  // Extraction prompt — without this the value is stripped by Zod and never persisted.
  description: z.string().optional(),
  type: z.string().min(1, "Field type is required"),
  is_unique_identifier: z.boolean().default(false),
  is_default: z.boolean().default(false),
  hidden: z.boolean().default(false),
  hidden_on_record: z.boolean().default(false),
  data: z.array(z.any()).optional(),
  child_board_name: z.string().optional(),
  fields: z.array(z.any()).optional(),
  role: z.string().optional(),
  // Field settings (sampleData, default_country_code, childBoardId, …) — permissive
  // record like doc-schema's settings; without this Zod strips the whole object and
  // sample data set in the field form is never persisted.
  settings: z.record(z.string(), z.any()).optional(),
});

export const bulkFieldsSchema = z.object({
  fields: z.array(bulkFieldSchema).min(1, "At least one field is required"),
});

/**
 * Aggregate / query schema
 */
export const aggregateSchema = z.object({
  query: z.any().optional(), // flexible — pass-through to service
});

/**
 * POST /boards/:parentId/attach-child
 *
 * Strict mode (matches legacy): every existing item of the child board MUST be
 * referenced in `item_mapping` — unmapped items raise `UNMAPPED_CHILD_ITEMS`.
 * `child_item_ids` may be empty (parent claims ownership without linking items).
 */
export const attachChildSchema = z.object({
  child_board_id: z.string().min(1, "child_board_id is required"),
  field_name: z.string().min(1, "field_name is required"),
  item_mapping: z
    .array(
      z.object({
        parent_item_id: z.string().min(1, "parent_item_id is required"),
        child_item_ids: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

/**
 * POST /boards/:parentId/detach-child/:childId
 *
 * `restore_as_independent` defaults to true: child board flips
 * `is_child_table=false` so it shows up in the standalone board list again.
 * Set false to keep the child marked as nested (orphaned but not surfaced).
 */
export const detachChildSchema = z.object({
  restore_as_independent: z.boolean().optional().default(true),
});

// Export types
export type CreateBoardRequest = z.infer<typeof createBoardSchema>;
export type UpdateBoardRequest = z.infer<typeof updateBoardSchema>;
export type CreateBoardFieldRequest = z.infer<typeof createBoardFieldSchema>;
export type UpdateBoardFieldRequest = z.infer<typeof updateBoardFieldSchema>;
export type ReorderFieldsRequest = z.infer<typeof reorderFieldsSchema>;
export type ReorderBoardsRequest = z.infer<typeof reorderBoardsSchema>;
export type BoardFiltersRequest = z.infer<typeof boardFiltersSchema>;
export type AttachChildRequest = z.infer<typeof attachChildSchema>;
export type DetachChildRequest = z.infer<typeof detachChildSchema>;
export type BulkFieldsRequest = z.infer<typeof bulkFieldsSchema>;
