/**
 * Zod validators for Document AI Schema endpoints.
 */

import { z } from "zod";
import { BoardFieldType } from "../../domain/shared/board.types";

const fieldDataItemSchema = z.object({
  id: z.string().optional(),
  value: z.string(),
  color: z.string().optional(),
  order: z.number().optional(),
});

const fieldSettingsSchema = z.record(z.string(), z.any()).optional();

/**
 * Accept the canonical BoardFieldType values plus the spec-only alias
 * `RichText` (mapped to `LongText`). `Time` is now a first-class
 * BoardFieldType, so no alias needed for it.
 */
const attributeTypeSchema = z
  .union([z.nativeEnum(BoardFieldType), z.literal("RichText")])
  .transform((t) => {
    if (t === "RichText") return BoardFieldType.LONG_TEXT;
    return t;
  });

export const attributeSchema = z.object({
  id: z.string().optional(),
  _id: z.string().optional(),
  name: z.string().min(1, "Attribute name is required"),
  description: z.string().optional(),
  type: attributeTypeSchema,
  isUniqueIdentifier: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  defaultFieldName: z.string().optional(),
  hidden: z.boolean().optional(),
  hiddenOnRecord: z.boolean().optional(),
  contactField: z.string().optional(),
  isIdentifier: z.boolean().optional(),
  data: z.array(fieldDataItemSchema).optional(),
  settings: fieldSettingsSchema,
  extractionPrompt: z.string().optional(),
  sampleData: z.string().optional(),
  order: z.number().optional(),
  role: z.string().optional(),
});

export const docSchemaListQuerySchema = z.object({
  search: z.string().optional(),
  categoryId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

export const createDocSchemaSchema = z.object({
  name: z.string().min(1, "Schema name is required"),
  // Schema-level objective ("Suggested Model Objective").
  description: z.string().nullable().optional(),
  // `category` per spec is sent as an id string on create/update.
  category: z.string().nullable().optional(),
  // FE may send `accessTeam` (single, per spec) or `accessTeams` (array) —
  // both are normalised to a string[] by the controller.
  accessTeam: z.string().nullable().optional(),
  accessTeams: z.array(z.string()).nullable().optional(),
  attributes: z.array(attributeSchema).optional(),
  // Agents/databoards arrive as full objects from FE; we persist IDs only.
  agents: z
    .array(z.union([z.string(), z.object({ _id: z.string() }).passthrough()]))
    .optional(),
  databoards: z
    .array(z.union([z.string(), z.object({ _id: z.string() }).passthrough()]))
    .optional(),
  // Commit-message-style note attached to the version row created by this save.
  change_note: z.string().optional(),
});

export const updateDocSchemaSchema = createDocSchemaSchema.partial();

export const updateAttributeSchema = attributeSchema
  .partial()
  .extend({ change_note: z.string().optional() })
  .refine(
    (v) => {
      const keys = Object.keys(v).filter((k) => k !== "change_note");
      return keys.length > 0;
    },
    { message: "Provide at least one attribute field to update" },
  );

export const extractAttributesSchema = z.object({
  file_urls: z
    .array(z.string().url("Each file_url must be a valid URL"))
    .min(1, "At least one file URL is required")
    .max(5, "Maximum 5 files per request"),
  provider_id: z.string().optional(),
  model_name: z.string().optional(),
  board_schema_url: z.string().url().optional(),
});

export const linkAssistantSchema = z.object({
  assistant_id: z.string().min(1, "assistant_id is required"),
  // One entry per schema to provision a board for. `data_board_name` (optional)
  // names that schema's board; it falls back to the schema name when omitted.
  schemas: z
    .array(
      z.object({
        schema_id: z.string().min(1),
        data_board_name: z.string().trim().min(1).optional(),
        // The provisioned board's category (a `type:'databoard'` category id).
        // Omitted/empty → the board lands in the auto-created "Doc Agent" category.
        board_category_id: z.string().trim().min(1).optional(),
        // The provisioned board's deployment access as team ids. Omitted/empty →
        // all teams (no manager restriction). Mirrors the /databoards `team_ids`.
        board_deployment_access: z.array(z.string()).optional(),
      }),
    )
    .min(1, "At least one schema is required"),
  change_note: z.string().optional(),
});

/** Body for POST /api/schemas/_unlink-assistant-from-all-schemas — cross-service
 * cleanup when an assistant is deleted upstream (marketplace/AI service).
 * Removes the assistant from EVERY schema in the org. */
export const unlinkAssistantFromAllSchemasSchema = z.object({
  assistant_id: z.string().min(1, "assistant_id is required"),
});

/** Body for POST /api/schemas/_unlink-schema-from-assistant — a still-live
 * assistant had specific schemas removed from it (chat-ai update). Drops the
 * assistant (and its per-schema board) from ONLY the listed schemas. */
export const unlinkSchemaFromAssistantSchema = z.object({
  assistant_id: z.string().min(1, "assistant_id is required"),
  schemas: z
    .array(
      z.object({
        schema_id: z.string().min(1),
        board_id: z.string().optional(),
      }),
    )
    .min(1, "At least one schema is required"),
});

export const listVersionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

export const revertVersionSchema = z
  .object({ change_note: z.string().optional() })
  .optional();

/** Limits for POST /api/schemas/_extract-attributes (Document AI section 13). */
export const EXTRACT_ATTRIBUTES_LIMITS = {
  maxFiles: 5,
  maxBytesPerFile: 10 * 1024 * 1024,
  allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"] as const,
};

/** Normalize FE-shaped Agent[]/Databoard[] (objects or ids) to id arrays. */
export function extractIds(
  list: Array<string | { _id: string }> | undefined,
): string[] | undefined {
  if (!list) return undefined;
  return list.map((x) => (typeof x === "string" ? x : x._id));
}
