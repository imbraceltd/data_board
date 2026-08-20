-- Reverse the backfill: clear `from_schema_id` for any board whose pointer
-- exactly matches a schema currently listing it in `databoard_ids`. Anything
-- else (manually-set pointers, or boards no longer referenced by their schema)
-- is left untouched.

UPDATE "boards" AS b
SET "from_schema_id" = NULL,
    "updated_at" = NOW()
FROM "doc_schemas" AS s,
     jsonb_array_elements_text(s."databoard_ids") AS d(board_id)
WHERE b."id" = d.board_id
  AND b."organization_id" = s."organization_id"
  AND b."from_schema_id" = s."id";
