-- Backfill new-design Document AI from legacy `type='DocumentAI'` boards.
--
-- Old design represented a "document-ai" purely as a board with
-- `type='DocumentAI'` (its column definitions living in `boards.fields[]`).
-- The new design adds dedicated `doc_schemas` (+ `doc_categories`) and links a
-- schema to its board both ways (`boards.from_schema_id` <->
-- `doc_schemas.databoard_ids`). Environments upgraded from the old design
-- (e.g. staging) therefore have DocumentAI boards but no schemas.
--
-- For every legacy DocumentAI board this migration:
--   1. ensures a per-org "Doc Agent" category (type='schema'),
--   2. creates one schema whose `attributes[]` are derived from the board's
--      `fields[]` (the inverse of toBoardField() in doc-schema.service.ts:552 —
--      only rename is BoardField.promptAI -> DocAttribute.extractionPrompt; the
--      field `id` is preserved verbatim so schema<->board sync keeps matching by
--      id, see schema-board-sync.ts),
--   3. links board -> schema via `databoard_ids` (set on insert) and
--      schema -> board via `boards.from_schema_id`.
--
-- Agent linkage (`agent_ids`) is NOT done here: resolving the assistant whose
-- `metadata.databoard == board.id` needs a network call to the AI service and
-- must not sit inside the boot migration transaction. See the companion
-- one-off `src/scripts/backfill-schema-agent-ids.ts`.
--
-- Idempotent: gated on `boards.from_schema_id IS NULL`, deterministic ids
-- (`sch_<board.id>` / `cat_schema_docagent_<org>`), `ON CONFLICT DO NOTHING`,
-- and a NOT EXISTS guard on the category — so a re-run (or a DB already on the
-- new design) is a safe no-op. Child boards (TABLE_IN_TABLE children) are
-- excluded; their structure is preserved inside the parent attribute's
-- `settings.columns`.

INSERT INTO "doc_categories" ("id", "organization_id", "name", "type", "parent_id", "created_at", "updated_at")
SELECT DISTINCT
  'cat_schema_docagent_' || b."organization_id",
  b."organization_id",
  'Doc Agent',
  'schema',
  NULL,
  NOW(),
  NOW()
FROM "boards" AS b
WHERE b."type" = 'DocumentAI'
  AND COALESCE(b."is_child_table", false) = false
  AND b."from_schema_id" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "doc_categories" c
    WHERE c."organization_id" = b."organization_id"
      AND c."type" = 'schema'
      AND c."name" = 'Doc Agent'
  )
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "doc_schemas" ("id", "organization_id", "name", "category_id", "access_teams", "attributes", "agent_ids", "databoard_ids", "created_at", "updated_at")
SELECT
  'sch_' || b."id",
  b."organization_id",
  b."name",
  (
    SELECT c."id" FROM "doc_categories" c
    WHERE c."organization_id" = b."organization_id"
      AND c."type" = 'schema'
      AND c."name" = 'Doc Agent'
    ORDER BY (c."id" = 'cat_schema_docagent_' || b."organization_id") DESC, c."created_at" ASC
    LIMIT 1
  ),
  '[]'::jsonb,
  COALESCE(
    (
      SELECT jsonb_agg(attr ORDER BY ord)
      FROM jsonb_array_elements(b."fields") WITH ORDINALITY AS t(f, ord),
      LATERAL (SELECT COALESCE(t.f->>'id', gen_random_uuid()::text) AS fid) ids,
      LATERAL (
        SELECT jsonb_strip_nulls(jsonb_build_object(
          'id', ids.fid,
          '_id', ids.fid,
          'name', t.f->>'name',
          'description', t.f->'description',
          'type', t.f->>'type',
          'isUniqueIdentifier', COALESCE((t.f->>'isUniqueIdentifier')::boolean, false),
          'isDefault', COALESCE((t.f->>'isDefault')::boolean, false),
          'hidden', COALESCE((t.f->>'hidden')::boolean, false),
          'hiddenOnRecord', COALESCE((t.f->>'hiddenOnRecord')::boolean, false),
          'isIdentifier', COALESCE((t.f->>'isIdentifier')::boolean, false),
          'defaultFieldName', t.f->'defaultFieldName',
          'contactField', t.f->'contactField',
          'data', t.f->'data',
          'settings', t.f->'settings',
          'role', t.f->'role',
          'extractionPrompt', t.f->'promptAI',
          'order', COALESCE((t.f->>'order')::int, (t.ord - 1)::int)
        )) AS attr
      ) build
    ),
    '[]'::jsonb
  ),
  '[]'::jsonb,
  jsonb_build_array(b."id"),
  NOW(),
  NOW()
FROM "boards" AS b
WHERE b."type" = 'DocumentAI'
  AND COALESCE(b."is_child_table", false) = false
  AND b."from_schema_id" IS NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

UPDATE "boards" AS b
SET "from_schema_id" = 'sch_' || b."id",
    "updated_at" = NOW()
WHERE b."type" = 'DocumentAI'
  AND COALESCE(b."is_child_table", false) = false
  AND b."from_schema_id" IS NULL
  AND EXISTS (SELECT 1 FROM "doc_schemas" s WHERE s."id" = 'sch_' || b."id");
