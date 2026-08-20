-- Convert legacy DocumentAI boards to General.
--
-- In the new Document-AI design a doc-agent's data lives in a normal General
-- board: boards provisioned via POST /api/schemas/_link-assistant are created
-- with type='General' (see doc-schema.service.ts linkAssistantAndProvisionBoards
-- and board.service.ts createBoard default). Environments upgraded from the old
-- design still carry boards with the legacy type='DocumentAI' — the 0012
-- backfill synthesised a schema from each such board but deliberately left the
-- board's `type` untouched. As a result those boards never show up in the
-- General board listing (GET /api/boards?types=General filters `type` exactly),
-- even though they ARE the data boards backing a doc schema.
--
-- This migration unifies them so the two designs converge: every DocumentAI
-- board becomes a General board (children included, so a TABLE_IN_TABLE child
-- keeps the same type as its parent). Nothing in the app branches on
-- type='DocumentAI' at runtime — it is only a legacy enum value (BoardType) —
-- so the change is behaviour-preserving apart from making these boards visible
-- in the General listing.
--
-- Ordering: runs AFTER 0012, whose schema backfill keys off type='DocumentAI';
-- by the time this flips the type, every schema has already been created.
--
-- Idempotent: a re-run (or a DB that has no DocumentAI boards) is a safe no-op.

UPDATE "boards"
SET "type" = 'General',
    "updated_at" = NOW()
WHERE "type" = 'DocumentAI';
