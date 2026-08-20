import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import config from "../../config";
import { getContext } from "./request-context";

/**
 * Structured logging — single-line JSON to stdout (Promtail/Loki friendly).
 *
 * Canonical log shape (agreed field spec — all keys lowercase):
 *   ip, request_id, date_time (ISO 8601 UTC), time (epoch ms), method_request,
 *   request_path, service_name, env, type_of_entity, function_of_code,
 *   description_message, response_time, status_code, proxy, level
 *
 * Per-request fields (ip/request_id/method_request/request_path/proxy) are
 * pulled automatically from AsyncLocalStorage, so call sites only pass what
 * they know, using the short ergonomic keys:
 *   logger.info("Added_Profile_to_the_queue_for_processing",
 *               { function: "enqueueProfile", entity: "AGENT" });
 *
 * Recognized meta keys (short -> emitted as):
 *   function       -> function_of_code
 *   entity         -> type_of_entity
 *   status_code    -> status_code
 *   response_time  -> response_time   (also accepts response_time_ms)
 * Any other meta keys are preserved under `meta` alongside the canonical fields.
 */

const SERVICE_NAME = process.env.SERVICE_NAME || "data-board";

// Deployment tier for log filtering (Loki `{env="dev"}`). Decoupled from
// NODE_ENV (which gates behavior): prefer the explicit DEPLOY_ENV, else
// normalize whatever native env value exists to dev/staging/prodv2.
const normalizeEnv = (raw?: string): string => {
  const v = (raw || "").toLowerCase();
  if (v.includes("prod")) return "prodv2";
  if (v.includes("stag") || v === "stg") return "staging";
  if (v.includes("dev") || v.includes("local")) return "dev";
  return v || "dev";
};
const ENV =
  process.env.DEPLOY_ENV || normalizeEnv(process.env.NODE_ENV || process.env.ENV);

// Winston stashes positional args (beyond the message) under this symbol.
const SPLAT = Symbol.for("splat");

// Entities recognized for the `entity` field. EMPTY when not applicable.
export type LogEntity =
  | "POST"
  | "ARTICLE"
  | "COMMENT"
  | "USER"
  | "AGENT"
  | "BOARD"
  | "EMPTY";

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// JSON.stringify replacer: break circular refs and unwrap Error objects (whose
// own enumerable props are usually empty). Without this, logging an axios/http
// error crashes the process because ClientRequest <-> IncomingMessage cycle.
const safeReplacer = () => {
  const seen = new WeakSet<object>();
  return (_key: string, val: unknown) => {
    if (val instanceof Error) {
      return { name: val.name, message: val.message, stack: val.stack };
    }
    if (typeof val === "object" && val !== null) {
      if (seen.has(val as object)) return "[Circular]";
      seen.add(val as object);
    }
    if (typeof val === "bigint") return val.toString();
    return val;
  };
};

/**
 * Build the canonical, ordered log object for one line.
 * Pulls per-request fields from ALS; merges per-call meta.
 */
const canonicalFormat = winston.format.printf((info) => {
  const { level, message, timestamp, ...meta } = info as Record<
    string,
    unknown
  > & { level: string; message: string; timestamp: string };

  const ctx = getContext();

  const {
    function: fn,
    entity,
    status_code,
    response_time,
    response_time_ms,
    ...rest
  } = meta as {
    function?: string;
    entity?: string;
    status_code?: number;
    response_time?: number;
    response_time_ms?: number;
    [k: string]: unknown;
  };

  const line: Record<string, unknown> = {
    ip: ctx?.ip ?? "",
    request_id: ctx?.requestId ?? "",
    date_time: timestamp, // ISO 8601 UTC, human-readable
    time: new Date(timestamp).getTime(), // epoch ms, for sorting/Loki
    method_request: ctx?.method ?? "",
    request_path: ctx?.path ?? "",
    service_name: SERVICE_NAME,
    env: ENV,
    type_of_entity: entity ?? "EMPTY",
    function_of_code: fn ?? "",
    description_message: message,
    response_time: response_time ?? response_time_ms ?? undefined,
    status_code: status_code ?? undefined,
    proxy: ctx?.proxy ?? "",
    level,
  };

  // Keep any extra structured fields the caller passed (e.g. board_id).
  if (Object.keys(rest).length > 0) line.meta = rest;

  // Capture positional extras from console-style calls, e.g.
  //   logger.error("HTTP Status:", 500)  ->  details: [500]
  // Winston merges a trailing object into `rest` (above) and folds an Error's
  // message/stack into `description_message`/`meta.stack`, so here we only keep
  // primitives and any further non-merged values — never duplicating those.
  const splat = (info as Record<symbol, unknown>)[SPLAT];
  if (Array.isArray(splat)) {
    const isStandardMeta =
      splat.length === 1 &&
      typeof splat[0] === "object" &&
      splat[0] !== null &&
      !(splat[0] instanceof Error) &&
      !Array.isArray(splat[0]);
    if (!isStandardMeta) {
      const details = splat.filter((v) => {
        if (v instanceof Error) return false; // already in message/meta.stack
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          return Object.keys(v as object).length > 0; // drop {} / merged object
        }
        return true; // primitives, arrays
      });
      if (details.length > 0) line.details = details;
    }
  }

  return JSON.stringify(line, safeReplacer());
});

// ISO 8601 UTC, e.g. 2026-06-02T14:30:15.123Z
const baseFormat = winston.format.combine(
  winston.format.timestamp(), // default: ISO 8601 with ms (Zulu)
  canonicalFormat,
);

const transports: winston.transport[] = [
  // stdout — the source of truth for centralized logging (Promtail tails this).
  new winston.transports.Console({ format: baseFormat }),
  // Local rotated files — same JSON shape, handy for on-host debugging.
  new DailyRotateFile({
    filename: "logs/error-%DATE%.log",
    level: "error",
    format: baseFormat,
    datePattern: "YYYY-MM-DD",
    maxSize: "20m",
    maxFiles: "14d",
  }),
  new DailyRotateFile({
    filename: "logs/all-%DATE%.log",
    format: baseFormat,
    datePattern: "YYYY-MM-DD",
    maxSize: "20m",
    maxFiles: "14d",
  }),
];

const logger = winston.createLogger({
  level: config.environment === "development" ? "debug" : "info",
  levels,
  transports,
});

export default logger;
