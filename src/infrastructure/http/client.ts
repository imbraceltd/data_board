/**
 * Outbound HTTP correlation — request-id propagation for axios.
 *
 * So the cross-service trace doesn't split (OBSERVABILITY_DESIGN.md §5.2, §10),
 * every outbound call must carry, from the current AsyncLocalStorage context:
 *   - `x-request-id`: the inbound correlation id (so the downstream reuses it)
 *   - `x-proxy`: this service's name (so the downstream records who called it)
 *
 * Outside an HTTP request (cron jobs, queue consumers) there's no context, so
 * no id is attached — the downstream origin-mints one.
 *
 * Two ways this is applied:
 *  1. A GLOBAL interceptor on the default axios instance (`installCorrelation`,
 *     called once at startup) — covers every existing `axios.get/post/...` call
 *     site and dynamic `import("axios")`, with no per-file changes.
 *  2. A pre-configured `httpClient` instance for new code.
 *
 * NOTE: `axios.create()` instances do NOT inherit the global interceptor, so
 * any future created instance must either use this module's interceptor or be
 * the exported `httpClient`.
 */

import axios, { type InternalAxiosRequestConfig } from "axios";
import {
  getContext,
  REQUEST_ID_HEADER,
  PROXY_HEADER,
} from "../logging/request-context";

const SERVICE_NAME = process.env.SERVICE_NAME || "data-board";

function attachCorrelation(cfg: InternalAxiosRequestConfig) {
  const ctx = getContext();
  if (ctx?.requestId) {
    cfg.headers.set(REQUEST_ID_HEADER, ctx.requestId);
    cfg.headers.set(PROXY_HEADER, SERVICE_NAME);
  }
  return cfg;
}

/**
 * Register the correlation interceptor on the global default axios instance.
 * Idempotent — safe to call once from the app entry point.
 */
let installed = false;
export function installCorrelation() {
  if (installed) return;
  axios.interceptors.request.use(attachCorrelation);
  installed = true;
}

/** Pre-configured client for new code. Inherits its own interceptor. */
const httpClient = axios.create();
httpClient.interceptors.request.use(attachCorrelation);

export default httpClient;
