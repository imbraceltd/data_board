-- doc_schemas.description: schema-level objective ("Suggested Model Objective").
--
-- A one-line summary of what a Document Model is meant to extract (e.g.
-- "Extract two-way confidentiality terms, active windows, and governing laws.").
-- Nullable — existing schemas, and any saved without an objective, hydrate as
-- null. Populated by the default-doc-schemas seeder run on org creation and
-- (later) by the Build-a-model form. No index: never filtered/sorted on.

ALTER TABLE "doc_schemas" ADD COLUMN "description" text;
