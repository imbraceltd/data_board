-- Manual rollback for 0007_boards_from_schema.sql.
-- After running this SQL:
--   1. delete src/db/drizzle/migrations/0007_boards_from_schema.sql
--   2. remove the idx=7 entry from src/db/drizzle/migrations/meta/_journal.json
--   3. DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<hash logged at apply>'

DROP INDEX IF EXISTS "boards_from_schema_idx";
ALTER TABLE "boards" DROP COLUMN IF EXISTS "from_schema_id";
