-- Manual rollback for 0009_doc_categories_type.sql.
-- Drizzle Kit does NOT auto-generate or auto-run down migrations.
-- After running this SQL:
--   1. delete src/db/drizzle/migrations/0009_doc_categories_type.sql
--   2. remove the idx=9 entry from src/db/drizzle/migrations/meta/_journal.json
--   3. DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<hash logged at apply>'

DROP INDEX IF EXISTS "doc_categories_org_type_idx";
ALTER TABLE "doc_categories" DROP COLUMN IF EXISTS "type";
