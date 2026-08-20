/**
 * Document AI Schema — Domain Types
 *
 * A Schema is a reusable construction of attributes that can be attached to
 * one or more Boards. Attributes mirror BoardField with two AI-specific
 * additions: `extractionPrompt` and `sampleData`.
 *
 * Sync semantics (Schema -> Board fields) are NOT implemented in this phase;
 * Phase 4 will introduce `schemaAttributeId` + `isOverridden` flags on
 * BoardField and propagation logic.
 */

import { BoardFieldType, FieldData, FieldSettings } from "./board.types";

/**
 * Attribute — a single column definition on a Schema.
 *
 * Mirrors BoardField (camelCase) with AI extensions. The `_id` plus `id`
 * dual-property convention matches BoardField behaviour elsewhere; both
 * resolve to the same UUID.
 */
export interface DocAttribute {
  id: string;
  _id?: string;
  name: string;
  description?: string;
  type: BoardFieldType;
  isUniqueIdentifier?: boolean;
  isDefault?: boolean;
  defaultFieldName?: string;
  hidden?: boolean;
  hiddenOnRecord?: boolean;
  contactField?: string;
  isIdentifier?: boolean;
  data?: FieldData[];
  settings?: FieldSettings;
  /** AI extraction prompt (BoardField calls this `promptAI`). */
  extractionPrompt?: string;
  /** Sample value (or JSON-string for TableInTable) returned by the extractor. */
  sampleData?: string;
  /** Order within the parent Schema. */
  order?: number;
  /**
   * Opaque role string (e.g. "Officer (Level 1)") required to view this
   * column on a provisioned board. Propagated as-is to `BoardField.role`
   * when the schema materialises into a board. Null/undefined = visible to
   * everyone.
   */
  role?: string;
}

export interface DocSchema {
  _id: string;
  id?: string;
  organization_id: string;
  name: string;
  /**
   * Schema-level objective ("Suggested Model Objective"): a one-line summary of
   * what this Document Model is meant to extract. Null when unset.
   */
  description: string | null;
  /** Category id (single category). */
  category_id: string | null;
  /** Team IDs allowed to access this Schema (array of teamIds). */
  access_teams: string[];
  attributes: DocAttribute[];
  /** Linked agent IDs (full Agent objects come from marketplace). */
  agent_ids: string[];
  /** Linked board IDs (full Board objects come from board service). */
  databoard_ids: string[];
  created_at: Date;
  updated_at: Date;
}

export interface DocSchemaFilters {
  search?: string;
  categoryId?: string;
  /** Pre-resolved set of category ids (the controller expands subtree via DocCategoryService). */
  categoryIds?: string[];
  limit?: number;
  skip?: number;
}

export interface CreateDocSchemaDTO {
  organization_id: string;
  name: string;
  description?: string | null;
  category_id?: string | null;
  access_teams?: string[];
  attributes?: DocAttribute[];
  agent_ids?: string[];
  databoard_ids?: string[];
}

export interface UpdateDocSchemaDTO {
  name?: string;
  description?: string | null;
  category_id?: string | null;
  access_teams?: string[];
  attributes?: DocAttribute[];
  agent_ids?: string[];
  databoard_ids?: string[];
}
