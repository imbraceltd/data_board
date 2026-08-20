-- Document AI — Categories: add `type` namespace ("schema" | "databoard").
--
-- Existing rows predate the multi-type split and belong to the original
-- schema-builder feature, so they migrate to 'schema'. The NOT NULL + DEFAULT
-- 'schema' column add backfills every existing row in a single statement —
-- this is the data migration for requirement #5 (no separate backfill needed).
--
-- New categories must supply `type` explicitly at the API layer (the create
-- endpoint rejects a missing/invalid type with 400); the DB default only
-- exists so this ALTER can run against a populated table.

ALTER TABLE "doc_categories" ADD COLUMN "type" varchar(20) DEFAULT 'schema' NOT NULL;--> statement-breakpoint
CREATE INDEX "doc_categories_org_type_idx" ON "doc_categories" USING btree ("organization_id","type");
