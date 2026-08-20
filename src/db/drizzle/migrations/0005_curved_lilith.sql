-- Document AI — Categories & Schemas
-- Adds two new tables: doc_categories (adjacency-list tree) and doc_schemas
-- (with embedded attributes + access_teams / agent_ids / databoard_ids arrays).
--
-- NOTE: The auto-generated migration also tried to re-create board_items
-- (hash-partitioned, owned by 0001) and re-add boards.attached_from (owned by
-- 0002). Both were stripped manually — those tables already exist in prod and
-- 0002 is not tracked in drizzle meta. If you regenerate, trim those again.

CREATE TABLE "doc_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"parent_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_schemas" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"category_id" text,
	"access_teams" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attributes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"databoard_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "doc_categories_organization_idx" ON "doc_categories" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "doc_categories_parent_idx" ON "doc_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "doc_schemas_organization_idx" ON "doc_schemas" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "doc_schemas_category_idx" ON "doc_schemas" USING btree ("category_id");
