import {
  pgTable,
  text,
  boolean,
  timestamp,
  integer,
  bigint,
  varchar,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  BoardField,
  BoardManager,
  BoardJourney,
  BoardAttachedFrom,
} from "../../domain/shared/board.types";
import type { SchemaSnapshot } from "../../domain/shared/doc-schema-version.types";

export const folders = pgTable("folders", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  organization_id: text("organization_id").notNull(),
  description: text("description"),
  tags: text("tags").array(), // Requires Postgres
  auto_tagging: boolean("auto_tagging").default(false),
  parent_folder_id: text("parent_folder_id").notNull(),
  source_type: varchar("source_type", { length: 50 }).notNull(),
  external_id: text("external_id"),
  external_source: varchar("external_source", { length: 50 }),
  session_id: text("session_id"),
  delta_link: text("delta_link"),
  synced: boolean("synced").default(true),
  is_sync_enabled: boolean("is_sync_enabled").default(false),
  last_sync_at: timestamp("last_sync_at"),
  sync_timestamp: timestamp("sync_timestamp").defaultNow().notNull(),
  file_count: integer("file_count").default(0),
  path: text("path").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const files = pgTable("files", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  organization_id: text("organization_id").notNull(),
  folder_id: text("folder_id").notNull(),
  source_type: varchar("source_type", { length: 50 })
    .notNull()
    .default("local"),
  external_id: text("external_id"),
  external_source: varchar("external_source", { length: 50 }),
  synced: boolean("synced").default(true),
  last_sync_at: timestamp("last_sync_at"),
  key: text("key").notNull(),
  file_type: text("file_type").notNull(),
  file_size: integer("file_size").notNull(),
  tags: text("tags").array(), // Array of tags
  remarks: text("remarks"), // User notes/comments
  last_updated_by_display_name: text("last_updated_by_display_name"),
  last_updated_by_email: text("last_updated_by_email"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const ingestionJobs = pgTable("ingestion_jobs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  fileId: text("file_id").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  errorMessage: text("error_message"),
  errorCode: text("error_code"),
  retryCount: integer("retry_count").default(0),
  maxRetries: integer("max_retries").default(3),
  nextRetryAt: timestamp("next_retry_at"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const boardFileUploads = pgTable("board_file_uploads", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  organization_id: text("organization_id").notNull(),
  board_id: text("board_id").notNull(),
  last_updated_by_display_name: text("last_updated_by_display_name").notNull(),
  last_updated_by_email: text("last_updated_by_email").notNull(),
  sync_timestamp: timestamp("sync_timestamp").defaultNow().notNull(),
  key: text("key").notNull(),
  file_type: text("file_type").notNull(),
  file_size: integer("file_size").notNull(),
});

export const onedriveSessions = pgTable("onedrive_sessions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id").notNull().unique(),
  access_token: text("access_token").notNull(),
  refresh_token: text("refresh_token"),
  expires_at: bigint("expires_at", { mode: "number" }).notNull(),
  expires_in: integer("expires_in"),
  organization_id: text("organization_id"),
  user_email: text("user_email"),
  user_display_name: text("user_display_name"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const onedriveSubscriptions = pgTable("onedrive_subscriptions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  subscriptionId: text("subscription_id").notNull().unique(),
  sessionId: text("session_id").notNull(),
  resource: text("resource").notNull(),
  changeType: text("change_type").notNull().default("updated"),
  notificationUrl: text("notification_url").notNull(),
  expirationDateTime: timestamp("expiration_date_time").notNull(),
  clientState: text("client_state").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const googleDriveSessions = pgTable("google_drive_sessions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id").notNull().unique(),
  access_token: text("access_token").notNull(),
  refresh_token: text("refresh_token"),
  expires_at: bigint("expires_at", { mode: "number" }).notNull(),
  start_page_token: text("start_page_token"),
  organization_id: text("organization_id"),
  user_email: text("user_email"),
  user_display_name: text("user_display_name"),
  channel_id: text("channel_id"),
  channel_resource_id: text("channel_resource_id"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const googleDriveSubscriptions = pgTable("google_drive_subscriptions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id").notNull(),
  webhookUrl: text("webhook_url").notNull(),
  channelId: text("channel_id").notNull().unique(),
  resourceId: text("resource_id").notNull(),
  startPageToken: text("start_page_token").notNull(),
  expirationDateTime: timestamp("expiration_date_time").notNull(),
  active: boolean("active").default(true),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const dropboxSessions = pgTable("dropbox_sessions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id").notNull().unique(),
  access_token: text("access_token").notNull(),
  refresh_token: text("refresh_token"),
  expires_at: bigint("expires_at", { mode: "number" }).notNull(),
  account_id: text("account_id"),
  organization_id: text("organization_id"),
  cursor: text("cursor"),
  user_email: text("user_email"),
  user_display_name: text("user_display_name"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

// ========================================
// Board Tables
// ========================================

export const boards = pgTable(
  "boards",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    business_unit_id: text("business_unit_id").notNull(),
    organization_id: text("organization_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    type: varchar("type", { length: 50 }).notNull(), // BoardType enum
    order: integer("order").notNull().default(0),
    hidden: boolean("hidden").default(false),
    created_by: text("created_by"),
    fields: jsonb("fields").notNull().$type<BoardField[]>().default([]),
    managers: jsonb("managers").notNull().$type<BoardManager[]>().default([]),
    journey: jsonb("journey").$type<BoardJourney>(),
    show_id: boolean("show_id").default(false),
    is_child_table: boolean("is_child_table").default(false),
    attached_from: jsonb("attached_from").$type<BoardAttachedFrom | null>(),
    from_schema_id: text("from_schema_id"),
    category_id: text("category_id"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    organizationIdx: index("boards_organization_idx").on(table.organization_id),
    typeIdx: index("boards_type_idx").on(table.type),
    orderIdx: index("boards_order_idx").on(table.order),
    fromSchemaIdx: index("boards_from_schema_idx").on(table.from_schema_id),
    categoryIdx: index("boards_category_idx").on(
      table.organization_id,
      table.category_id,
    ),
  }),
);

// board_items is hash-partitioned by board_id (64 partitions: board_items_p0..p63).
// DDL is in drizzle/migrations/0001_partition_board_items.sql (custom migration);
// the table is excluded from drizzle-kit pull/push via tablesFilter in
// drizzle.config.ts so generate/push don't fight the partition setup.
// PK is composite (id, board_id) — required by PG hash partition constraints.
// The FK board_id → boards.id does NOT exist at the DB level (PG 14 limitation on
// partitioned tables); cascade-delete of board_items when a board is deleted must be
// handled in the service layer.
export const boardItems = pgTable(
  "board_items",
  {
    id: text("id")
      .$defaultFn(() => crypto.randomUUID())
      .notNull(),
    business_unit_id: text("business_unit_id").notNull(),
    organization_id: text("organization_id").notNull(),
    // Note: .references() is declared for TypeScript/relational query awareness only.
    // The actual DB constraint does not exist — see comment above.
    board_id: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    created_by: text("created_by"),
    created_type: varchar("created_type", { length: 20 })
      .notNull()
      .default("manual"),
    fields: jsonb("fields").notNull().$type<Record<string, any>>().default({}),
    related_board_item_id: text("related_board_item_id"),
    related_board_item_list: jsonb("related_board_item_list")
      .$type<string[]>()
      .default([]),
    conversation_ids: jsonb("conversation_ids").$type<string[]>().default([]),
    logo_url: text("logo_url"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    organizationIdx: index("board_items_organization_idx").on(
      table.organization_id,
    ),
    boardIdx: index("board_items_board_idx").on(table.board_id),
    relatedIdx: index("board_items_related_idx").on(
      table.related_board_item_id,
    ),
    createdAtIdx: index("board_items_created_at_idx").on(table.created_at),
  }),
);

export const tableInColumns = pgTable(
  "table_in_columns",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    parent_board_id: text("parent_board_id").notNull(),
    parent_board_item_id: text("parent_board_item_id").notNull(),
    parent_board_field_id: text("parent_board_field_id").notNull(),
    child_board_id: text("child_board_id").notNull(),
    child_board_item_id: text("child_board_item_id").notNull(),
    created_by: text("created_by"),
    updated_by: text("updated_by"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    parentBoardIdx: index("tic_parent_board_idx").on(table.parent_board_id),
    parentItemIdx: index("tic_parent_item_idx").on(table.parent_board_item_id),
    childBoardIdx: index("tic_child_board_idx").on(table.child_board_id),
    childItemIdx: index("tic_child_item_idx").on(table.child_board_item_id),
  }),
);

/**
 * CRMBoard automations migrated from IPS. Column shape (text timestamps,
 * nullable trigger_* fields, jsonb folder_ids) mirrors the existing IPS
 * `crmboards` table 1:1 so data can be copied across without transformation.
 */
export const crmboards = pgTable(
  "crmboards",
  {
    id: text("id").primaryKey(),
    board_id: text("board_id").notNull(),
    type: text("type").notNull(),
    workflow_id: text("workflow_id").notNull(),
    folder_ids: jsonb("folder_ids"),
    is_knowledge_base: boolean("is_knowledge_base").default(false),
    description: text("description"),
    name: text("name").notNull(),
    organization_id: text("organization_id").notNull(),
    field_id: text("field_id"),
    trigger_frequency_unit: text("trigger_frequency_unit"),
    trigger_frequency_value: integer("trigger_frequency_value"),
    trigger_time: text("trigger_time"),
    trigger_day_of_week: text("trigger_day_of_week"),
    trigger_day_of_month: text("trigger_day_of_month"),
    triger_month_and_day: text("triger_month_and_day"),
    start_date: text("start_date"),
    start_time: text("start_time"),
    start_datetime: text("start_datetime"),
    is_paused: boolean("is_paused").default(false),
  },
  (table) => ({
    boardIdx: index("crmboards_board_idx").on(table.board_id),
    boardTypeIdx: index("crmboards_board_type_idx").on(
      table.board_id,
      table.type,
    ),
    organizationIdx: index("crmboards_organization_idx").on(
      table.organization_id,
    ),
    workflowIdx: index("crmboards_workflow_idx").on(table.workflow_id),
    fieldIdx: index("crmboards_field_idx").on(table.field_id),
  }),
);

/**
 * Schedulers migrated from IPS. Column shape mirrors `ips.schedulers` 1:1
 * so the migration script can copy rows across without transformation.
 * `job` and `options` are jsonb (job holds Kafka topic, workflow_id,
 * board_id, etc.; options is free-form per scheduler type).
 */
export const schedulers = pgTable(
  "schedulers",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    name: text("name").notNull(),
    event_type: text("event_type").notNull(),
    description: text("description"),
    options: jsonb("options"),
    job: jsonb("job").notNull(),
    organization_id: text("organization_id").notNull(),
    internal_id: text("internal_id"),
    trigger_frequency_unit: text("trigger_frequency_unit"),
    trigger_frequency_value: integer("trigger_frequency_value"),
    trigger_time: text("trigger_time"),
    trigger_day_of_week: text("trigger_day_of_week"),
    trigger_day_of_month: text("trigger_day_of_month"),
    triger_month_and_day: text("triger_month_and_day"),
    start_date: text("start_date"),
    start_time: text("start_time"),
    start_datetime: text("start_datetime"),
    is_paused: boolean("is_paused").default(false),
    is_finished: boolean("is_finished").default(false),
    channel_source: text("channel_source"),
    one_time_schedule_type: text("one_time_schedule_type"),
    one_time_schedule_frequency_unit: text("one_time_schedule_frequency_unit"),
    one_time_schedule_frequency_value: integer(
      "one_time_schedule_frequency_value",
    ),
    one_time_schedule_frequency_time: text("one_time_schedule_frequency_time"),
    created_by: text("created_by"),
    updated_by: text("updated_by"),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  },
  (table) => ({
    internalIdx: index("schedulers_internal_idx").on(table.internal_id),
    organizationIdx: index("schedulers_organization_idx").on(
      table.organization_id,
    ),
    pausedIdx: index("schedulers_paused_idx").on(table.is_paused),
  }),
);

export const segmentations = pgTable(
  "segmentations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `sg_${crypto.randomUUID()}`),
    business_unit_id: text("business_unit_id").notNull(),
    organization_id: text("organization_id").notNull(),
    board_id: text("board_id").notNull(),
    user_id: text("user_id").notNull(),
    name: text("name"),
    description: text("description"),
    filters: jsonb("filters")
      .$type<
        Array<{
          field_id?: string;
          operator?: string;
          value?: any;
          condition?: string;
        }>
      >()
      .notNull()
      .default([]),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    boardIdx: index("segmentations_board_idx").on(table.board_id),
    organizationIdx: index("segmentations_organization_idx").on(
      table.organization_id,
    ),
  }),
);

// ========================================
// Document AI — Categories & Schemas
// ========================================

export const docCategories = pgTable(
  "doc_categories",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organization_id: text("organization_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    // "schema" | "databoard" — see DocCategoryType. Defaults to "schema" so
    // pre-existing rows backfill to the original (schema-only) namespace.
    type: varchar("type", { length: 20 }).notNull().default("schema"),
    parent_id: text("parent_id"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    organizationIdx: index("doc_categories_organization_idx").on(
      table.organization_id,
    ),
    parentIdx: index("doc_categories_parent_idx").on(table.parent_id),
    // List queries always filter by (organization_id, type).
    orgTypeIdx: index("doc_categories_org_type_idx").on(
      table.organization_id,
      table.type,
    ),
  }),
);

export const docSchemas = pgTable(
  "doc_schemas",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organization_id: text("organization_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    // Schema-level objective ("Suggested Model Objective"). Nullable — boards/
    // schemas created before this column, and any schema saved without one,
    // hydrate as null. Populated by the default-doc-schemas seeder and (later)
    // the FE form.
    description: text("description"),
    category_id: text("category_id"),
    access_teams: jsonb("access_teams")
      .$type<string[]>()
      .notNull()
      .default([]),
    attributes: jsonb("attributes")
      .$type<unknown[]>()
      .notNull()
      .default([]),
    agent_ids: jsonb("agent_ids").$type<string[]>().notNull().default([]),
    databoard_ids: jsonb("databoard_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    organizationIdx: index("doc_schemas_organization_idx").on(
      table.organization_id,
    ),
    categoryIdx: index("doc_schemas_category_idx").on(table.category_id),
  }),
);

export const docSchemaVersions = pgTable(
  "doc_schema_versions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    schema_id: text("schema_id").notNull(),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").notNull().$type<SchemaSnapshot>(),
    change_note: text("change_note"),
    diff_summary: text("diff_summary"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    created_by: text("created_by"),
    created_by_name: text("created_by_name"),
  },
  (table) => ({
    schemaIdx: index("doc_schema_versions_schema_idx").on(table.schema_id),
    // Per-schema unique version number — enforced at app level too.
    uniqueSchemaVersion: index("doc_schema_versions_schema_version_uk").on(
      table.schema_id,
      table.version,
    ),
  }),
);

// ========================================
// Type Exports
// ========================================

export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;
export type File = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;
export type IngestionJob = typeof ingestionJobs.$inferSelect;
export type NewIngestionJob = typeof ingestionJobs.$inferInsert;
export type BoardFileUpload = typeof boardFileUploads.$inferSelect;
export type NewBoardFileUpload = typeof boardFileUploads.$inferInsert;
export type OneDriveSession = typeof onedriveSessions.$inferSelect;
export type NewOneDriveSession = typeof onedriveSessions.$inferInsert;
export type OneDriveSubscription = typeof onedriveSubscriptions.$inferSelect;
export type NewOneDriveSubscription = typeof onedriveSubscriptions.$inferInsert;
export type GoogleDriveSession = typeof googleDriveSessions.$inferSelect;
export type NewGoogleDriveSession = typeof googleDriveSessions.$inferInsert;
export type GoogleDriveSubscription =
  typeof googleDriveSubscriptions.$inferSelect;
export type NewGoogleDriveSubscription =
  typeof googleDriveSubscriptions.$inferInsert;
export type DropboxSession = typeof dropboxSessions.$inferSelect;
export type NewDropboxSession = typeof dropboxSessions.$inferInsert;

// Board type exports
export type Board = typeof boards.$inferSelect;
export type NewBoard = typeof boards.$inferInsert;
export type BoardItem = typeof boardItems.$inferSelect;
export type NewBoardItem = typeof boardItems.$inferInsert;
export type TableInColumn = typeof tableInColumns.$inferSelect;
export type NewTableInColumn = typeof tableInColumns.$inferInsert;
export type Segmentation = typeof segmentations.$inferSelect;
export type NewSegmentation = typeof segmentations.$inferInsert;

// Document AI type exports
export type DocCategoryRow = typeof docCategories.$inferSelect;
export type NewDocCategoryRow = typeof docCategories.$inferInsert;
export type DocSchemaRow = typeof docSchemas.$inferSelect;
export type NewDocSchemaRow = typeof docSchemas.$inferInsert;
export type DocSchemaVersionRow = typeof docSchemaVersions.$inferSelect;
export type NewDocSchemaVersionRow = typeof docSchemaVersions.$inferInsert;
