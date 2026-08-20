/**
 * CRMBoard automation types — migrated 1:1 from IPS so frontend can switch
 * the call target with no payload changes. Field names are snake_case to
 * match the wire shape the frontend (and downstream Kafka consumers) read.
 */

export const CRMBoardType = {
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
  SCHEDULED: "scheduled",
  CONDITION: "condition",
} as const;
export type CRMBoardTypeValue =
  (typeof CRMBoardType)[keyof typeof CRMBoardType];

export interface CRMBoard {
  id: string;
  /** Also surfaced as `_id` in JSON responses for legacy clients. */
  _id?: string;
  board_id: string;
  type: CRMBoardTypeValue | string;
  workflow_id: string;
  description?: string | null;
  name: string;
  organization_id: string;
  field_id?: string | null;
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
  is_knowledge_base: boolean;
  folder_ids?: string[] | null;
  updateNeeded?: boolean;
}

export interface CreateCRMBoardDTO {
  id?: string;
  board_id: string;
  type: string;
  workflow_id?: string;
  description?: string;
  name: string;
  organization_id: string;
  field_id?: string;
  trigger_frequency_unit?: string;
  trigger_frequency_value?: number;
  trigger_time?: string;
  trigger_day_of_week?: string;
  trigger_day_of_month?: string;
  triger_month_and_day?: string;
  start_date?: string;
  start_time?: string;
  start_datetime?: string;
  is_paused?: boolean;
  is_knowledge_base?: boolean;
  folder_ids?: string[] | null;
}

export type UpdateCRMBoardDTO = Partial<CreateCRMBoardDTO>;
