-- Backfill `boards.from_schema_id` for boards that were provisioned from a
-- Doc Schema before the BoardRepository.create() fix — the previous code
-- silently dropped `from_schema_id` from the insert payload, so every board
-- created via POST /api/schemas/_link-assistant landed in DB with
-- `from_schema_id = NULL`. The schema side of the link
-- (doc_schemas.databoard_ids) is intact and acts as the source of truth for
-- this repair.
--
-- For each schema, expand its `databoard_ids` JSONB array and set the
-- matching board's `from_schema_id` to that schema. Scoped to the same
-- organization as a safety belt — boards and schemas live per-org and a
-- cross-org link is always a data bug, not an intentional pointer.
--
-- Idempotent — only touches rows where `from_schema_id IS NULL`, so re-running
-- after a partial failure (or against a DB that already has the fix in place)
-- is a safe no-op.

UPDATE "boards" AS b
SET "from_schema_id" = s."id",
    "updated_at" = NOW()
FROM "doc_schemas" AS s,
     jsonb_array_elements_text(s."databoard_ids") AS d(board_id)
WHERE b."id" = d.board_id
  AND b."organization_id" = s."organization_id"
  AND b."from_schema_id" IS NULL;
