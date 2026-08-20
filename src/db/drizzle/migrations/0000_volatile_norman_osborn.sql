-- Baseline schema for data_board. Captured by `drizzle-kit pull` against the dev
-- Postgres on 2026-04-28. Applies to an empty database to produce the same shape
-- as dev. The hash-partitioned `board_items` table is created by the next
-- migration (0001_partition_board_items) — partition DDL can't be expressed in
-- drizzle's schema definition, so it lives in a hand-authored custom migration.
CREATE TABLE "board_file_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"organization_id" text NOT NULL,
	"board_id" text NOT NULL,
	"last_updated_by_display_name" text NOT NULL,
	"last_updated_by_email" text NOT NULL,
	"sync_timestamp" timestamp DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"file_type" text NOT NULL,
	"file_size" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dropbox_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" integer NOT NULL,
	"account_id" text,
	"organization_id" text,
	"cursor" text,
	"user_email" text,
	"user_display_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "dropbox_sessions_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"organization_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"source_type" varchar(50) DEFAULT 'local' NOT NULL,
	"external_id" text,
	"external_source" varchar(50),
	"synced" boolean DEFAULT true,
	"last_sync_at" timestamp,
	"key" text NOT NULL,
	"file_type" text NOT NULL,
	"file_size" integer NOT NULL,
	"tags" text[],
	"remarks" text,
	"last_updated_by_display_name" text,
	"last_updated_by_email" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"organization_id" text NOT NULL,
	"description" text,
	"tags" text[],
	"auto_tagging" boolean DEFAULT false,
	"parent_folder_id" text NOT NULL,
	"source_type" varchar(50) NOT NULL,
	"external_id" text,
	"external_source" varchar(50),
	"session_id" text,
	"delta_link" text,
	"synced" boolean DEFAULT true,
	"is_sync_enabled" boolean DEFAULT false,
	"last_sync_at" timestamp,
	"sync_timestamp" timestamp DEFAULT now() NOT NULL,
	"file_count" integer DEFAULT 0,
	"path" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_drive_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" integer NOT NULL,
	"start_page_token" text,
	"organization_id" text,
	"user_email" text,
	"user_display_name" text,
	"channel_id" text,
	"channel_resource_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "google_drive_sessions_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "google_drive_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"webhook_url" text NOT NULL,
	"channel_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"start_page_token" text NOT NULL,
	"expiration_date_time" timestamp NOT NULL,
	"active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "google_drive_subscriptions_channel_id_unique" UNIQUE("channel_id")
);
--> statement-breakpoint
CREATE TABLE "ingestion_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"error_code" text,
	"retry_count" integer DEFAULT 0,
	"max_retries" integer DEFAULT 3,
	"next_retry_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"id" text PRIMARY KEY NOT NULL,
	"business_unit_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"type" varchar(50) NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false,
	"created_by" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"managers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"journey" jsonb,
	"show_id" boolean DEFAULT false,
	"is_child_table" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onedrive_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" integer NOT NULL,
	"expires_in" integer,
	"organization_id" text,
	"user_email" text,
	"user_display_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "onedrive_sessions_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "onedrive_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"session_id" text NOT NULL,
	"resource" text NOT NULL,
	"change_type" text DEFAULT 'updated' NOT NULL,
	"notification_url" text NOT NULL,
	"expiration_date_time" timestamp NOT NULL,
	"client_state" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "onedrive_subscriptions_subscription_id_unique" UNIQUE("subscription_id")
);
--> statement-breakpoint
CREATE TABLE "table_in_columns" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_board_id" text NOT NULL,
	"parent_board_item_id" text NOT NULL,
	"parent_board_field_id" text NOT NULL,
	"child_board_id" text NOT NULL,
	"child_board_item_id" text NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segmentations" (
	"id" text PRIMARY KEY NOT NULL,
	"business_unit_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"board_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text,
	"description" text,
	"filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "boards_order_idx" ON "boards" USING btree ("order" int4_ops);--> statement-breakpoint
CREATE INDEX "boards_organization_idx" ON "boards" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "boards_type_idx" ON "boards" USING btree ("type" text_ops);--> statement-breakpoint
CREATE INDEX "tic_child_board_idx" ON "table_in_columns" USING btree ("child_board_id" text_ops);--> statement-breakpoint
CREATE INDEX "tic_child_item_idx" ON "table_in_columns" USING btree ("child_board_item_id" text_ops);--> statement-breakpoint
CREATE INDEX "tic_parent_board_idx" ON "table_in_columns" USING btree ("parent_board_id" text_ops);--> statement-breakpoint
CREATE INDEX "tic_parent_item_idx" ON "table_in_columns" USING btree ("parent_board_item_id" text_ops);--> statement-breakpoint
CREATE INDEX "segmentations_board_idx" ON "segmentations" USING btree ("board_id" text_ops);--> statement-breakpoint
CREATE INDEX "segmentations_organization_idx" ON "segmentations" USING btree ("organization_id" text_ops);