/**
 * CSV export helpers ported from legacy backend exportCsv.
 * Kept dependency-free (no moment/dayjs) — uses Intl.DateTimeFormat.
 */

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function escapeCsvField(data: any): string {
  if (data === null || data === undefined) return '""';
  const s = String(data);
  return `"${s.replace(/"/g, '""')}"`;
}

function getTzParts(
  d: Date,
  tz: string,
): { year: string; month: string; day: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
  };
}

export function formatDateInTz(date: any, tz: string, fmt: string): string {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return "";
  const p = getTzParts(d, tz);
  return fmt.replace(
    /YYYY|MM|DD|HH|mm/g,
    (m) => ({ YYYY: p.year, MM: p.month, DD: p.day, HH: p.hour, mm: p.minute })[m]!,
  );
}

export function ymdInTz(d: Date, tz: string): string {
  const p = getTzParts(d, tz);
  return `${p.year}${p.month}${p.day}`;
}

function tzOffsetMs(d: Date, tz: string): number {
  // Compute the offset (tz - UTC) in ms by diffing the same instant formatted as UTC vs tz.
  const dtfUtc = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const dtfTz = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const asUtc = toMsFromParts(dtfUtc.formatToParts(d));
  const asTz = toMsFromParts(dtfTz.formatToParts(d));
  return asTz - asUtc;
}

function toMsFromParts(parts: Intl.DateTimeFormatPart[]): number {
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const hour = get("hour") === 24 ? 0 : get("hour");
  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
}

export function startOfDayInTz(d: Date, tz: string): Date {
  const p = getTzParts(d, tz);
  // "YYYY-MM-DDT00:00:00" as if it were UTC, then shift by tz offset to get the UTC instant of midnight-in-tz
  const asUtcMidnight = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
  );
  return new Date(asUtcMidnight - tzOffsetMs(d, tz));
}

export function endOfDayInTz(d: Date, tz: string): Date {
  const p = getTzParts(d, tz);
  const asUtcEnd = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    23,
    59,
    59,
    999,
  );
  return new Date(asUtcEnd - tzOffsetMs(d, tz));
}

export function startOfMonthInTz(d: Date, tz: string): Date {
  const p = getTzParts(d, tz);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, 1);
  return new Date(asUtc - tzOffsetMs(d, tz));
}

export function endOfMonthInTz(d: Date, tz: string): Date {
  const p = getTzParts(d, tz);
  const nextMonth = Date.UTC(Number(p.year), Number(p.month), 1);
  const lastInstant = nextMonth - 1;
  return new Date(lastInstant - tzOffsetMs(d, tz));
}

export function subtractDays(d: Date, n: number): Date {
  return new Date(d.getTime() - n * 86_400_000);
}

export function subtractMonths(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() - n);
  return r;
}

function safeJoin(value: any): string {
  if (Array.isArray(value)) return value.filter((v) => v != null).join(", ");
  return value == null ? "" : String(value);
}

/**
 * Parse a raw export_csv query into normalized date-range + options.
 * Centralizes the quick_range / start_date / end_date / time / all logic
 * shared by GET and POST.
 */
export interface ExportCsvOptions {
  tz: string;
  by: "creation" | "updated";
  all: boolean;
  quickRange?: string;
  startDate: Date | null;
  endDate: Date | null;
  time?: string;
  sort?: string;
}

export interface ResolvedRange {
  fromDate: Date | null;
  toDate: Date;
}

export function parseExportCsvOptions(
  q: Record<string, string | undefined>,
): ExportCsvOptions {
  return {
    tz: q.tz && isValidTz(q.tz) ? q.tz : "UTC",
    by: q.by === "updated" ? "updated" : "creation",
    all: q.all === "true" || q.all === "1",
    quickRange: q.quick_range,
    startDate: q.start_date ? new Date(q.start_date) : null,
    endDate: q.end_date ? new Date(q.end_date) : null,
    time: q.time,
    sort: q.sort,
  };
}

export function resolveDateRange(
  opts: ExportCsvOptions,
  now: Date,
): ResolvedRange {
  let fromDate: Date | null = null;
  let toDate: Date = now;
  if (opts.all) return { fromDate, toDate };
  const { quickRange, startDate, endDate, tz, time } = opts;
  if (quickRange === "week") {
    fromDate = startOfDayInTz(subtractDays(now, 7), tz);
  } else if (quickRange === "month") {
    fromDate = startOfDayInTz(subtractMonths(now, 1), tz);
  } else if (quickRange === "3months") {
    fromDate = startOfDayInTz(subtractMonths(now, 3), tz);
  } else if (quickRange === "6months") {
    fromDate = startOfDayInTz(subtractMonths(now, 6), tz);
  } else if (quickRange === "12months") {
    fromDate = startOfDayInTz(subtractMonths(now, 12), tz);
  } else if (startDate && endDate) {
    fromDate = startOfDayInTz(startDate, tz);
    toDate = endOfDayInTz(endDate, tz);
  } else if (startDate) {
    fromDate = startOfDayInTz(startDate, tz);
  } else if (endDate) {
    fromDate = null;
    toDate = endOfDayInTz(endDate, tz);
  } else if (time) {
    const t = new Date(time);
    fromDate = startOfMonthInTz(t, tz);
    toDate = endOfMonthInTz(t, tz);
  } else {
    fromDate = startOfDayInTz(subtractMonths(now, 1), tz);
  }
  return { fromDate, toDate };
}

/**
 * Render a full CSV (headers + rows) for a board and its items.
 */
export function renderBoardCsv(
  board: { name: string; fields?: Array<any> },
  items: Array<{ fields?: Record<string, any>; created_at: any; updated_at: any }>,
  tz: string,
): string {
  const fields = Array.isArray(board.fields) ? board.fields : [];
  const headers = [
    ...fields.map((f) => f.name),
    "Record Created On",
    "Lasted Updated On",
  ]
    .map(escapeCsvField)
    .join(",");

  const rows = items.map((item) => {
    const itemFields: Record<string, any> = item.fields || {};
    const rendered = fields.map((field: any) => {
      const value = itemFields[field.id ?? field._id];
      return renderField(field.type, value, tz);
    });
    rendered.push(formatDateInTz(item.created_at, tz, "MM/DD/YYYY HH:mm"));
    rendered.push(
      formatDateInTz(item.updated_at || item.created_at, tz, "MM/DD/YYYY HH:mm"),
    );
    return rendered.join(",");
  });

  return [headers, ...rows].join("\n");
}

export function buildExportFileName(
  board: { name: string },
  range: ResolvedRange,
  opts: ExportCsvOptions,
  now: Date,
): string {
  let rangeLabel = "all";
  if (!opts.all && (range.fromDate || range.toDate)) {
    rangeLabel = `${range.fromDate ? ymdInTz(range.fromDate, opts.tz) : "begin"}-${range.toDate ? ymdInTz(range.toDate, opts.tz) : "now"}`;
  }
  const boardName = board.name ?? "board";
  return `${boardName}_${ymdInTz(now, opts.tz)}_for-${rangeLabel}_by-${opts.by}.csv`;
}

export function renderField(type: string, value: any, tz: string): string {
  switch (type) {
    case "Attachment": {
      // Stored as [{ type, data: { url, … } }]. Emit the URL(s) joined by
      // "; " so a re-import (processFieldValue → ATTACHMENT) reconstructs the
      // attachment objects symmetrically.
      if (!Array.isArray(value)) return escapeCsvField("");
      const urls = value.map((a: any) => a?.data?.url).filter(Boolean);
      return escapeCsvField(urls.join("; "));
    }
    case "Notes":
    case "RichText":
      return '"(the field format is not supported in export)"';
    case "Origin":
      return escapeCsvField(value?.data?.name);
    case "Assignee":
      return escapeCsvField(value?.display_name);
    case "Phone":
      return escapeCsvField(value?.calling_code_with_number);
    case "Country":
      return escapeCsvField(value?.country_name);
    case "Date":
      return escapeCsvField(formatDateInTz(value, tz, "MM/DD/YYYY"));
    case "Time":
      return escapeCsvField(formatDateInTz(value, tz, "HH:mm"));
    case "Datetime":
      return escapeCsvField(formatDateInTz(value, tz, "MM/DD/YYYY HH:mm"));
    case "MultipleSelection":
      return escapeCsvField(safeJoin(value));
    case "Currency":
      if (value && typeof value === "object" && "currency_code" in value && "amounts" in value) {
        try {
          return escapeCsvField(
            new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: value.currency_code,
              currencyDisplay: "code",
              minimumFractionDigits: 0,
              maximumFractionDigits: 3,
            }).format(value.amounts),
          );
        } catch {
          return escapeCsvField(`${value.currency_code ?? ""} ${value.amounts ?? ""}`.trim());
        }
      }
      return '""';
    case "Checkbox":
      return escapeCsvField(value ? "Checked" : "Not checked");
    default:
      return escapeCsvField(value);
  }
}
