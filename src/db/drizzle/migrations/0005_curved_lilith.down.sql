-- Manual rollback for 0005_curved_lilith.sql (Document AI: doc_categories + doc_schemas).
-- Drizzle Kit does NOT auto-generate or auto-run down migrations.
-- To roll back, run this SQL by hand against the target DB, then:
--   1. delete src/db/drizzle/migrations/0005_curved_lilith.sql
--   2. delete src/db/drizzle/migrations/meta/0005_snapshot.json
--   3. remove the idx=5 entry from src/db/drizzle/migrations/meta/_journal.json
--   4. DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<hash logged at apply time>'

DROP INDEX IF EXISTS "doc_schemas_category_idx";
DROP INDEX IF EXISTS "doc_schemas_organization_idx";
DROP INDEX IF EXISTS "doc_categories_parent_idx";
DROP INDEX IF EXISTS "doc_categories_organization_idx";
DROP TABLE IF EXISTS "doc_schemas";
DROP TABLE IF EXISTS "doc_categories";
