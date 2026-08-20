-- =============================================================================
-- Add `schedulers` table — node-schedule recurring/non-recurring jobs migrated
-- from IPS. Shape is a 1:1 mirror of `ips.schedulers` (29 columns) so the
-- migration script can copy rows across with no transformation.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "schedulers" (
  "id" text PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "name" text NOT NULL,
  "event_type" text NOT NULL,
  "description" text,
  "options" jsonb,
  "job" jsonb NOT NULL,
  "organization_id" text NOT NULL,
  "internal_id" text,
  "trigger_frequency_unit" text,
  "trigger_frequency_value" integer,
  "trigger_time" text,
  "trigger_day_of_week" text,
  "trigger_day_of_month" text,
  "triger_month_and_day" text,
  "start_date" text,
  "start_time" text,
  "start_datetime" text,
  "is_paused" boolean DEFAULT false,
  "is_finished" boolean DEFAULT false,
  "channel_source" text,
  "one_time_schedule_type" text,
  "one_time_schedule_frequency_unit" text,
  "one_time_schedule_frequency_value" integer,
  "one_time_schedule_frequency_time" text,
  "created_by" text,
  "updated_by" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "schedulers_internal_idx" ON "schedulers" ("internal_id");
CREATE INDEX IF NOT EXISTS "schedulers_organization_idx" ON "schedulers" ("organization_id");
CREATE INDEX IF NOT EXISTS "schedulers_paused_idx" ON "schedulers" ("is_paused");
