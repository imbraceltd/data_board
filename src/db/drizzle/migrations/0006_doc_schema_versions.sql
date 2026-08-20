-- Document AI — Schema Versioning
-- Adds doc_schema_versions table to persist immutable snapshots of doc_schemas
-- state for the FE "Versions" tab + revert flow. FK ON DELETE CASCADE so
-- versions disappear with their parent schema.

CREATE TABLE "doc_schema_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"schema_id" text NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"change_note" text,
	"diff_summary" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
ALTER TABLE "doc_schema_versions"
  ADD CONSTRAINT "doc_schema_versions_schema_id_doc_schemas_id_fk"
  FOREIGN KEY ("schema_id") REFERENCES "public"."doc_schemas"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "doc_schema_versions_schema_idx" ON "doc_schema_versions" USING btree ("schema_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_schema_versions_schema_version_uk" ON "doc_schema_versions" USING btree ("schema_id", "version");
