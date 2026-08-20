-- Best-effort reverse of 0013. The forward migration discards the original
-- `type`, so DocumentAI boards cannot all be recovered. We only restore the
-- ones the 0012 backfill unambiguously linked — those whose schema carries the
-- deterministic id `sch_<board.id>` — since only legacy DocumentAI boards ever
-- got that pointer. Boards whose schema was since deleted (from_schema_id
-- cleared) or that never had a schema are NOT reverted here; re-derive them
-- from chatai DocumentAI assistants if a full rollback is ever required.

UPDATE "boards" AS b
SET "type" = 'DocumentAI',
    "updated_at" = NOW()
WHERE b."type" = 'General'
  AND b."from_schema_id" = 'sch_' || b."id";
