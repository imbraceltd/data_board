-- boards.category_id: optional pointer to a DocCategory of type "databoard".
-- Nullable — boards created before this migration, and any new board not
-- explicitly assigned a category, hydrate as uncategorised ("All" tab on FE).
-- Boards provisioned via POST /api/schemas/_link-assistant auto-land in the
-- per-org default "Doc Agent" databoard category, so the column gets
-- populated for the new schema-driven flow without forcing a backfill of
-- legacy boards.
--
-- No FK to doc_categories — same soft-pointer style as boards.from_schema_id,
-- so deleting a category doesn't cascade-delete boards (we already paid the
-- price of carefully cleaning up category_id elsewhere in the delete flow).
--
-- Composite index (organization_id, category_id) speeds up the "list boards
-- in this category for this org" query the FE issues from the category sidebar.

ALTER TABLE "boards" ADD COLUMN "category_id" text;
--> statement-breakpoint
CREATE INDEX "boards_category_idx" ON "boards" USING btree ("organization_id", "category_id");
