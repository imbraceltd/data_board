/**
 * Mirror of IPS `validateSchedulerSettings`. Returns either a
 * `{ code, message, message_code? }` error or a clean object with
 * normalized trigger fields + `year_frequency`. We keep the exact same
 * shape so the frontend sees identical 400 responses on misuse.
 */

import {
  TRIGGER_FREQUENCY_UNIT,
  TRIGGER_DAY_OF_WEEK,
  isValidTime,
  isValidDayOfMonth,
  isValidMonthAndDay,
  isValidDateAndNotPast,
  isValidInteger,
  isValidStartDatetime,
} from "../utils/date-utils";
import { DefaultMinuteFrequency } from "../../domain/shared/scheduler.types";

interface ErrorShape {
  message: string;
  code: number;
  message_code?: string;
}

export const SchedulerErrors: Record<string, ErrorShape> = {
  MISSING_ORGANIZATION_INFO: {
    message: "x-organization-id is required.",
    code: 401,
  },
  INVALID_TRIGGER_FREQUENCY_UNIT: {
    message: "trigger_frequency_unit is invalid.",
    code: 400,
  },
  INVALID_TRIGGER_FREQUENCY_VALUE: {
    message:
      "trigger_frequency_value is invalid. It should be a postive integer.",
    code: 400,
  },
  INVALID_MINUTE_TRIGGER_FREQUENCY_VALUE: {
    message:
      "trigger_frequency_value is invalid. It should be between 30 and 1440 minutes.",
    code: 400,
  },
  MISSING_TRIGGER_TIME: {
    message:
      "trigger_time is required when trigger_frequency_unit is days, weeks, months and years.",
    code: 400,
  },
  INVALID_TRIGGER_TIME: { message: "trigger_time is invalid.", code: 400 },
  MISSING_TRIGGER_DAY_OF_WEEK: {
    message:
      "trigger_day_of_week is required when trigger_frequency_unit is weeks.",
    code: 400,
  },
  INVALID_TRIGGER_DAY_OF_WEEK: {
    message: "trigger_day_of_week is invalid.",
    code: 400,
  },
  MISSING_TRIGGER_DAY_OF_MONTH: {
    message:
      "trigger_day_of_month is required when trigger_frequency_unit is months.",
    code: 400,
  },
  INVALID_TRIGGER_DAY_OF_MONTH: {
    message: "trigger_day_of_month is invalid.",
    code: 400,
  },
  MISSING_TRIGGER_MONTH_AND_DAY: {
    message:
      "triger_month_and_day is required when trigger_frequency_unit is years.",
    code: 400,
  },
  INVALID_TRIGGER_MONTH_AND_DAY: {
    message: "triger_month_and_day is invalid.",
    code: 400,
  },
  INVALID_START_DATE: {
    message: "start_date is invalid or in the past.",
    code: 400,
  },
  INVALID_START_TIME: { message: "start_time is invalid.", code: 400 },
};

export interface ValidatedScheduler {
  trigger_frequency_unit: string;
  trigger_frequency_value: number;
  trigger_time?: string;
  trigger_day_of_week?: string;
  trigger_day_of_month?: string;
  triger_month_and_day?: string;
  start_date: string;
  start_time: string;
  year_frequency: number;
}

export function validateSchedulerSettings(
  data: any,
): ErrorShape | ValidatedScheduler {
  const {
    trigger_frequency_unit,
    trigger_frequency_value,
    trigger_time,
    trigger_day_of_week,
    trigger_day_of_month,
    triger_month_and_day,
    start_datetime,
  } = data;

  if (
    !Object.prototype.hasOwnProperty.call(
      TRIGGER_FREQUENCY_UNIT,
      trigger_frequency_unit,
    )
  ) {
    return SchedulerErrors.INVALID_TRIGGER_FREQUENCY_UNIT;
  }

  if (
    !trigger_frequency_value ||
    trigger_frequency_value <= 0 ||
    !isValidInteger(trigger_frequency_value)
  ) {
    return SchedulerErrors.INVALID_TRIGGER_FREQUENCY_VALUE;
  }

  const isMin = trigger_frequency_unit === TRIGGER_FREQUENCY_UNIT.minutes;
  const isSec = trigger_frequency_unit === TRIGGER_FREQUENCY_UNIT.seconds;
  if (
    (isSec || isMin) &&
    (trigger_frequency_value > DefaultMinuteFrequency.MAX ||
      trigger_frequency_value < DefaultMinuteFrequency.MIN)
  ) {
    return SchedulerErrors.INVALID_MINUTE_TRIGGER_FREQUENCY_VALUE;
  }

  const isTriggerTimeRequired =
    trigger_frequency_unit === TRIGGER_FREQUENCY_UNIT.days ||
    trigger_frequency_unit === TRIGGER_FREQUENCY_UNIT.weeks ||
    trigger_frequency_unit === TRIGGER_FREQUENCY_UNIT.months ||
    trigger_frequency_unit === TRIGGER_FREQUENCY_UNIT.years;

  if (isTriggerTimeRequired && !trigger_time)
    return SchedulerErrors.MISSING_TRIGGER_TIME;
  if (isTriggerTimeRequired && !isValidTime(trigger_time))
    return SchedulerErrors.INVALID_TRIGGER_TIME;

  const isDayOfWeekRequired =
    trigger_frequency_unit === TRIGGER_FREQUENCY_UNIT.weeks;
  if (isDayOfWeekRequired && !trigger_day_of_week)
    return SchedulerErrors.MISSING_TRIGGER_DAY_OF_WEEK;
  if (
    isDayOfWeekRequired &&
    !Object.prototype.hasOwnProperty.call(
      TRIGGER_DAY_OF_WEEK,
      trigger_day_of_week,
    )
  ) {
    return SchedulerErrors.INVALID_TRIGGER_DAY_OF_WEEK;
  }

  const isDayOfMonthRequired =
    trigger_frequency_unit === TRIGGER_FREQUENCY_UNIT.months;
  if (isDayOfMonthRequired && !trigger_day_of_month)
    return SchedulerErrors.MISSING_TRIGGER_DAY_OF_MONTH;
  if (isDayOfMonthRequired && !isValidDayOfMonth(trigger_day_of_month))
    return SchedulerErrors.INVALID_TRIGGER_DAY_OF_MONTH;

  const isMonthAndDayRequired =
    trigger_frequency_unit === TRIGGER_FREQUENCY_UNIT.years;
  if (isMonthAndDayRequired && !triger_month_and_day)
    return SchedulerErrors.MISSING_TRIGGER_MONTH_AND_DAY;
  if (isMonthAndDayRequired && !isValidMonthAndDay(triger_month_and_day))
    return SchedulerErrors.INVALID_TRIGGER_MONTH_AND_DAY;

  const start_date = start_datetime;
  const start_time = start_datetime;

  if (!isValidDateAndNotPast(start_date)) return SchedulerErrors.INVALID_START_DATE;
  if (!isValidTime(start_time)) return SchedulerErrors.INVALID_START_TIME;
  if (!isValidStartDatetime(start_date, start_time)) {
    return {
      code: 400,
      message: "start_date and start_time should be in the future.",
      message_code: "INVALID_START_DATETIME",
    };
  }

  return {
    trigger_frequency_unit,
    trigger_frequency_value,
    trigger_time,
    trigger_day_of_week,
    trigger_day_of_month,
    triger_month_and_day,
    start_date,
    start_time,
    year_frequency: isMonthAndDayRequired ? trigger_frequency_value : 1,
  };
}

export function isErrorShape(v: any): v is ErrorShape {
  return v && typeof v.code === "number" && typeof v.message === "string";
}
