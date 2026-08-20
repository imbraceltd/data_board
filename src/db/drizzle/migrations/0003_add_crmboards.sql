-- =============================================================================
-- Add `crmboards` table — CRMBoard automations migrated from IPS.
-- Schema is a 1:1 mirror of IPS `crmboards` so existing rows can be copied
-- across with `\copy` (see scripts/migrate-crmboards-from-ips.ts) without
-- any column transformation. Indexes target the hot lookups used by the
-- consumer dispatch path and by the frontend automations page.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "crmboards" (
  "id" text PRIMARY KEY NOT NULL,
  "board_id" text NOT NULL,
  "type" text NOT NULL,
  "workflow_id" text NOT NULL,
  "folder_ids" jsonb,
  "is_knowledge_base" boolean DEFAULT false,
  "description" text,
  "name" text NOT NULL,
  "organization_id" text NOT NULL,
  "field_id" text,
  "trigger_frequency_unit" text,
  "trigger_frequency_value" integer,
  "trigger_time" text,
  "trigger_day_of_week" text,
  "trigger_day_of_month" text,
  "triger_month_and_day" text,
  "start_date" text,
  "start_time" text,
  "start_datetime" text,
  "is_paused" boolean DEFAULT false
);

CREATE INDEX IF NOT EXISTS "crmboards_board_idx" ON "crmboards" ("board_id");
CREATE INDEX IF NOT EXISTS "crmboards_board_type_idx" ON "crmboards" ("board_id", "type");
CREATE INDEX IF NOT EXISTS "crmboards_organization_idx" ON "crmboards" ("organization_id");
CREATE INDEX IF NOT EXISTS "crmboards_workflow_idx" ON "crmboards" ("workflow_id");
CREATE INDEX IF NOT EXISTS "crmboards_field_idx" ON "crmboards" ("field_id");
