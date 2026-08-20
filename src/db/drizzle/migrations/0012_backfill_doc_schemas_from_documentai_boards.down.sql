-- Reverse 0012: drop the schemas/categories synthesised from legacy DocumentAI
-- boards and clear the board->schema pointers we set. Scoped strictly to the
-- deterministic ids this migration produces (`sch_<board.id>` /
-- `cat_schema_docagent_<org>`), so manually-created schemas/categories and
-- pointers set by the normal app flow are left untouched.

UPDATE "boards" AS b
SET "from_schema_id" = NULL,
    "updated_at" = NOW()
WHERE b."from_schema_id" = 'sch_' || b."id";
--> statement-breakpoint

DELETE FROM "doc_schemas" s
WHERE s."id" LIKE 'sch_%'
  AND EXISTS (
    SELECT 1 FROM "boards" b
    WHERE 'sch_' || b."id" = s."id"
      AND b."type" = 'DocumentAI'
  );
--> statement-breakpoint

-- Drop the per-org "Doc Agent" schema category only if it carries the
-- deterministic id minted here AND no schema still points at it.
DELETE FROM "doc_categories" c
WHERE c."id" = 'cat_schema_docagent_' || c."organization_id"
  AND c."type" = 'schema'
  AND c."name" = 'Doc Agent'
  AND NOT EXISTS (
    SELECT 1 FROM "doc_schemas" s WHERE s."category_id" = c."id"
  );
