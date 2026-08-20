-- Document AI — Schema Versions: add `created_by_name` so the FE can render
-- a human-readable author on the Versions tab without having to lookup user
-- ids. Resolved server-side from the platform `/api/platform/v1/account`
-- endpoint at write time so the value is frozen as-of-snapshot (an audit-log
-- friendly behaviour — if the user renames later, old versions still show
-- the name as it was when the version was created).

ALTER TABLE "doc_schema_versions" ADD COLUMN "created_by_name" text;
