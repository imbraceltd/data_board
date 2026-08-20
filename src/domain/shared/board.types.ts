/**
 * Board Domain Types
 * Core entity types for Board functionality
 */

/**
 * Board Types Enum
 */
export enum BoardType {
  CONTACTS = "Contacts",
  COMPANIES = "Companies",
  OPPORTUNITIES = "Opportunities",
  OPT_OUT = "OptOut",
  TASKS = "Tasks",
  SYSTEM = "System",
  GENERAL = "General",
  KNOWLEDGE_HUB = "KnowledgeHub",
  DOCUMENT_AI = "DocumentAI",
}

/**
 * Board Field Types Enum
 */
export enum BoardFieldType {
  SHORT_TEXT = "ShortText",
  LONG_TEXT = "LongText",
  NUMBER = "Number",
  EMAIL = "Email",
  PHONE = "Phone",
  DATE = "Date",
  DATETIME = "Datetime",
  TIME = "Time",
  SINGLE_SELECTION = "SingleSelection",
  MULTI_SELECTION = "MultipleSelection",
  ASSIGNEE = "Assignee",
  MULTI_ASSIGNEE = "MultipleAssignee",
  PRIORITY = "Priority",
  CURRENCY = "Currency",
  LINK = "Link",
  ATTACHMENT = "Attachment",
  NOTES = "Notes",
  COUNTRY = "Country",
  ORIGIN = "Origin",
  MAP_TO_BOARD = "MapToBoard",
  TABLE_IN_TABLE = "TableInTable",
  CHECKBOX = "Checkbox",
  FORMULA = "Formula",
  RATING = "Rating",
}

/**
 * Field data structure for dropdowns/selections
 */
export interface FieldData {
  // `id` is generated server-side and not always present in inbound payloads.
  // The Mongoose model (`board.model.ts`) types it as `String` (no `required:true`),
  // and the bulk-update path (`board.controller.ts` PUT /:boardId/fields/bulk)
  // already accepts items without `id`. Keep optional so create/update routes
  // don't reject the same shape that update-bulk accepts.
  id?: string;
  value: string;
  color?: string;
  order?: number;
}

/**
 * Field settings for specific field types
 */
export interface FieldSettings {
  // For NUMBER fields
  decimalPlaces?: number;
  min?: number;
  max?: number;

  // For CURRENCY fields
  currencyCode?: string;
  currencySymbol?: string;

  // For PHONE fields
  countryCode?: string;

  // For MAP_TO_BOARD fields
  targetBoardId?: string;
  targetBoardName?: string;
  allowMultiple?: boolean;

  // For TABLE_IN_TABLE fields
  childBoardId?: string;
  childBoardName?: string;

  columns?: { name: string; type: BoardFieldType }[];

  // For FORMULA fields
  formula?: string;

  // For DATE/DATETIME fields
  includeTime?: boolean;
  format?: string;

  // For LINK fields
  urlPattern?: string;

  // For RATING fields
  maxRating?: number;
  icon?: string;
}

/**
 * Board Field Definition
 */
export interface BoardField {
  id: string;
  name: string;
  description?: string;
  type: BoardFieldType;
  isUniqueIdentifier: boolean;
  isDefault: boolean;
  defaultFieldName?: string;
  hidden: boolean;
  hiddenOnRecord: boolean;
  contactField?: string;
  isIdentifier: boolean;
  data?: FieldData[];
  settings?: FieldSettings;
  promptAI?: string;
  isDeprecated: boolean;
  oldFieldId?: string;
  order?: number;
  /**
   * Opaque role string (e.g. "Officer (Level 1)") required to view this
   * column. FE compares against the current user's role and hides the column
   * if not matched. Null/undefined = visible to everyone. Set either directly
   * via field CRUD endpoints or propagated from `DocAttribute.role` when the
   * board is provisioned from a schema via POST /api/schemas/_link-assistant.
   */
  role?: string;
}

/**
 * Board Manager (Team-based access control)
 */
export interface BoardManager {
  teamId: string;
  teamName: string;
  permissions: {
    read: boolean;
    write: boolean;
    delete: boolean;
    manageFields: boolean;
  };
}

/**
 * Board Journey/Workflow Configuration
 */
export interface BoardJourney {
  enabled: boolean;
  stages?: Array<{
    id: string;
    name: string;
    order: number;
    color?: string;
  }>;
  automations?: Array<{
    id: string;
    name: string;
    trigger: string;
    action: string;
    conditions?: any;
  }>;
}

/**
 * Provenance stamped on a child board when it is attached to a parent
 * via POST /boards/:parentId/attach-child. Cleared (set null) on detach.
 */
export interface BoardAttachedFrom {
  parent_board_id: string;
  parent_board_field_id: string;
  attached_at: Date;
  attached_by: string;
}

/**
 * Core Board Entity
 */
export interface Board {
  _id: string;
  id?: string; // For Drizzle compatibility
  business_unit_id: string;
  organization_id: string;
  name: string;
  description?: string;
  type: BoardType;
  order: number;
  hidden: boolean;
  created_by?: string;
  fields: BoardField[];
  managers: BoardManager[];
  journey?: BoardJourney;
  show_id: boolean;
  is_child_table: boolean;
  attached_from?: BoardAttachedFrom | null;
  /**
   * Id of the source DocSchema if this board was provisioned via
   * POST /api/schemas/_link-assistant. Null for boards created directly
   * (POST /api/boards). FE checks truthy to hide the BoardSchema tab on the
   * detail page (the schema is the single source of truth for board's fields).
   */
  from_schema_id?: string | null;
  /**
   * Optional DocCategory the board belongs to. Must reference a category whose
   * `type === "databoard"`. Boards provisioned via _link-assistant land in the
   * "Doc Agent" databoard category by default; boards created via POST /boards
   * inherit it from the request body (null = uncategorised / "All" tab).
   */
  category_id?: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Board Filters for querying
 */
export interface BoardFilters {
  types?: BoardType[];
  hidden?: boolean;
  isDefault?: boolean;
  excludeChildTables?: boolean;
  search?: string;
  /** Filter to boards in this category (matches the `category_id` column). */
  category_id?: string;
  limit?: number;
  skip?: number;
}

/**
 * DTOs (Data Transfer Objects)
 */
export interface CreateBoardDTO {
  business_unit_id: string;
  organization_id: string;
  name: string;
  description?: string;
  type: BoardType;
  order?: number;
  hidden?: boolean;
  created_by?: string;
  fields?: BoardField[];
  managers?: BoardManager[];
  journey?: BoardJourney;
  show_id?: boolean;
  is_child_table?: boolean;
  from_schema_id?: string | null;
  category_id?: string | null;
}

export interface UpdateBoardDTO {
  name?: string;
  description?: string;
  type?: BoardType;
  order?: number;
  hidden?: boolean;
  managers?: BoardManager[];
  journey?: BoardJourney;
  show_id?: boolean;
  category_id?: string | null;
}

export interface CreateBoardFieldDTO {
  name: string;
  description?: string;
  type: BoardFieldType;
  isUniqueIdentifier?: boolean;
  hidden?: boolean;
  hiddenOnRecord?: boolean;
  contactField?: string;
  isIdentifier?: boolean;
  data?: FieldData[];
  settings?: FieldSettings;
  promptAI?: string;
  fields?: CreateBoardFieldDTO[]; // nested fields for TABLE_IN_TABLE child board
  id?: string;
  role?: string;
}

export interface UpdateBoardFieldDTO {
  name?: string;
  description?: string;
  hidden?: boolean;
  hiddenOnRecord?: boolean;
  data?: FieldData[];
  settings?: FieldSettings;
  promptAI?: string;
  isDeprecated?: boolean;
  role?: string;
}
