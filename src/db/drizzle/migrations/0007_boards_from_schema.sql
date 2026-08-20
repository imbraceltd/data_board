-- Boards provisioned from a Document AI Schema: track origin.
-- `from_schema_id` is nullable; only set for boards created via
-- POST /api/schemas/_link-assistant (boards from POST /api/boards leave null).
-- FE checks this flag (truthy = hide BoardSchema tab on the board detail page).
-- No FK to doc_schemas.id so deleting a schema doesn't blow away historical
-- boards; the column stays as a soft pointer.

ALTER TABLE "boards" ADD COLUMN "from_schema_id" text;
--> statement-breakpoint
CREATE INDEX "boards_from_schema_idx" ON "boards" USING btree ("from_schema_id");
