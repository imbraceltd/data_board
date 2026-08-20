/**
 * Date helpers — ported from IPS `src/utility.js` so scheduler cron-string
 * shapes match exactly. Behavior preserved verbatim; only TypeScript types
 * + named exports differ.
 */

export const TRIGGER_FREQUENCY_UNIT = {
  seconds: "seconds",
  minutes: "minutes",
  hours: "hours",
  days: "days",
  weeks: "weeks",
  months: "months",
  years: "years",
} as const;
export type TriggerFrequencyUnit =
  (typeof TRIGGER_FREQUENCY_UNIT)[keyof typeof TRIGGER_FREQUENCY_UNIT];

export const TRIGGER_DAY_OF_WEEK = {
  sunday: "sunday",
  monday: "monday",
  tuesday: "tuesday",
  wednesday: "wednesday",
  thursday: "thursday",
  friday: "friday",
  saturday: "saturday",
} as const;

export const TRIGGER_TYPES = {
  SCHEDULED: "scheduled",
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
} as const;

export function isValidInteger(str: any): boolean {
  return Number(str) === parseInt(str);
}

export function formatTime(input: any): string {
  const date = new Date(input);
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function formatDate(input: any): string {
  const date = new Date(input);
  const year = date.getUTCFullYear();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${month}/${day}/${year}`;
}

export function formatMonthAndDay(input: any): string {
  const date = new Date(input);
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${month}/${day}`;
}

export function toUTC(dateString: string, timeString: string): Date {
  const [month, day, year] = dateString.split("/");
  const [hours, minutes] = timeString.split(":");
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
  );
}

export function isValidTime(time = ""): boolean {
  const formattedTime = formatTime(time);
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(formattedTime);
}

export function isValidDayOfMonth(dayOfMonth = ""): boolean {
  return /^(first|last|second_last|[2-9]|1[0-9]|2[0-9]|3[0-1])$/.test(
    dayOfMonth,
  );
}

export function isValidMonthAndDay(date = ""): boolean {
  const formatted = formatMonthAndDay(date);
  return /^(0[1-9]|1[0-2])\/(0[1-9]|[12][0-9]|3[01])$/.test(formatted);
}

export function isValidDateAndNotPast(date = ""): boolean {
  const formatted = formatDate(date);
  return /^(0[1-9]|1[0-2])\/(0[1-9]|[12][0-9]|3[01])\/(19|20)\d{2}$/.test(
    formatted,
  );
}

export function isValidStartDatetime(date = "", time = ""): boolean {
  const formattedDate = formatDate(date);
  const formattedTime = formatTime(time);
  const startDatetime = toUTC(formattedDate, formattedTime);
  return startDatetime.getTime() - Date.now() > 0;
}

export function setCronTimeMinutes(minutes = 30): string {
  if (minutes === 1) return "* * * * *";
  return `*/${minutes} * * * *`;
}

export function setCronTimeSeconds(seconds = 10): string {
  if (seconds === 1) return "* * * * * *";
  return `*/${seconds} * * * * *`;
}

export function setCronTimeHours(hours = 1): string {
  if (hours === 1) return "0 * * * *";
  return `0 */${hours} * * *`;
}

export function setCronTimeDays(days = 1, time = "00:00"): string {
  const [hours, minutes] = time.split(":");
  if (days === 1) return `${minutes} ${hours} * * *`;
  return `${minutes} ${hours} */${days} * *`;
}

export function setCronTimeWeeks(
  weeks = 1,
  time = "00:00",
  dayOfWeek: string = TRIGGER_DAY_OF_WEEK.monday,
): string {
  const [hours, minutes] = time.split(":");
  const days = [
    TRIGGER_DAY_OF_WEEK.sunday,
    TRIGGER_DAY_OF_WEEK.monday,
    TRIGGER_DAY_OF_WEEK.tuesday,
    TRIGGER_DAY_OF_WEEK.wednesday,
    TRIGGER_DAY_OF_WEEK.thursday,
    TRIGGER_DAY_OF_WEEK.friday,
    TRIGGER_DAY_OF_WEEK.saturday,
  ];
  const dayNumber = days.indexOf(dayOfWeek as any);
  if (dayNumber === -1) throw new Error("invalid day of the week");
  if (weeks === 1) return `${minutes} ${hours} * * ${dayNumber}`;
  return `${minutes} ${hours} */${7 * weeks} * ${dayNumber}`;
}

export function setCronTimeMonths(
  months = 1,
  time = "00:00",
  dayOfMonth = "first",
): string {
  const [hours, minutes] = time.split(":");
  let day: string;
  switch (dayOfMonth.toLowerCase()) {
    case "first":
      day = "1";
      break;
    case "last":
      day = "28-31";
      break;
    case "second_last":
      day = "27-30";
      break;
    default:
      day = dayOfMonth;
  }
  if (months === 1) return `${minutes} ${hours} ${day} * *`;
  return `${minutes} ${hours} ${day} */${months} *`;
}

export function setCronTimeYears(time = "00:00", date = "01/01"): string {
  const [hours, minutes] = time.split(":");
  const [month, day] = date.split("/");
  return `${minutes} ${hours} ${day} ${month} *`;
}

export function correctPastDate(
  startDate: Date,
  unit: string,
  value: number,
): Date {
  const now = new Date();
  const delay = startDate.getTime() - now.getTime();
  if (delay > 0) return startDate;
  if (unit === "minutes") {
    const minutesSinceStart = Math.floor(
      (now.getTime() - startDate.getTime()) / (1000 * 60),
    );
    const nextRunMinutes = Math.ceil(minutesSinceStart / value) * value;
    return new Date(startDate.getTime() + nextRunMinutes * 60 * 1000);
  }
  if (unit === "hours") {
    const hoursSinceLastRun =
      ((now.getTime() - startDate.getTime()) / (1000 * 60 * 60)) % value;
    const nextRunHours = value - hoursSinceLastRun;
    return new Date(now.getTime() + nextRunHours * 60 * 60 * 1000);
  }
  return startDate;
}
