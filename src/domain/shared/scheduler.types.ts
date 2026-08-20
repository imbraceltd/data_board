/**
 * Scheduler types mirror IPS so a copied row deserializes without surprise.
 * `job` is intentionally typed loosely (jsonb) — the consumer cares about
 * `topic`, `workflow_id`, `data.board_id`, `data.id`, `scheduler_id` keys,
 * but the column also carries channel info for webhook jobs we never run.
 */

export const SchedulerType = {
  NON_RECURRING: "non_recurring",
  RECURRING: "recurring",
} as const;
export type SchedulerTypeValue =
  (typeof SchedulerType)[keyof typeof SchedulerType];

export const EventType = {
  BOARD_AUTOMATION: "board_automation",
} as const;

export const JobTriggerType = {
  KAFKA: "kafka",
  WEBHOOK: "webhook",
} as const;

export const DefaultMinuteFrequency = {
  MIN: 10,
  MAX: 1440,
} as const;

export interface SchedulerJob {
  type: string; // JobTriggerType
  topic?: string;
  workflow_id?: string;
  scheduler_id?: string;
  data?: Record<string, any>;
  url?: string;
  method?: string;
  is_formdata?: boolean;
  files?: any[];
}

export interface Scheduler {
  id: string;
  _id?: string;
  type: SchedulerTypeValue | string;
  name: string;
  event_type: string;
  description?: string | null;
  options?: any;
  job: SchedulerJob;
  organization_id: string;
  internal_id?: string | null;
  trigger_frequency_unit?: string | null;
  trigger_frequency_value?: number | null;
  trigger_time?: string | null;
  trigger_day_of_week?: string | null;
  trigger_day_of_month?: string | null;
  triger_month_and_day?: string | null;
  start_date?: string | null;
  start_time?: string | null;
  start_datetime?: string | null;
  is_paused: boolean;
  is_finished: boolean;
  channel_source?: string | null;
  one_time_schedule_type?: string | null;
  one_time_schedule_frequency_unit?: string | null;
  one_time_schedule_frequency_value?: number | null;
  one_time_schedule_frequency_time?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: Date | null;
  updated_at?: Date | null;
}

export interface CreateSchedulerDTO
  extends Omit<Partial<Scheduler>, "id" | "_id" | "is_paused" | "is_finished"> {
  type: string;
  name: string;
  event_type: string;
  job: SchedulerJob;
  organization_id: string;
  is_paused?: boolean;
  is_finished?: boolean;
}
