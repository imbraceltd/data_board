-- Manual rollback for 0006_doc_schema_versions.sql.
-- Drizzle Kit does NOT auto-generate or auto-run down migrations.
-- After running this SQL:
--   1. delete src/db/drizzle/migrations/0006_doc_schema_versions.sql
--   2. delete src/db/drizzle/migrations/meta/0006_snapshot.json (if exists)
--   3. remove the idx=6 entry from src/db/drizzle/migrations/meta/_journal.json
--   4. DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<hash logged at apply>'

DROP INDEX IF EXISTS "doc_schema_versions_schema_version_uk";
DROP INDEX IF EXISTS "doc_schema_versions_schema_idx";
DROP TABLE IF EXISTS "doc_schema_versions";
