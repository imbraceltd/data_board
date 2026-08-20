/**
 * HTTP Access Logger Middleware for Hono
 *
 * Emits exactly ONE structured access line per request, after the handler runs,
 * carrying status_code and response_time. The per-request correlation fields
 * (ip, request_id, method_request, request_path, proxy) come from
 * AsyncLocalStorage via the logger, so they must be populated first by the
 * `requestContext` middleware.
 */

import type { Context, Next } from "hono";
import logger from "../../infrastructure/logging/logger";
import { getContext } from "../../infrastructure/logging/request-context";

export const httpLogger = async (c: Context, next: Next) => {
  await next();

  const ctx = getContext();
  const responseTime = ctx ? Date.now() - ctx.startTime : undefined;
  const status = c.res.status;

  // Level reflects the outcome: 5xx -> error, 4xx -> warn, else info.
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";

  logger.log(level, "http_request_completed", {
    function: "httpLogger",
    entity: "EMPTY",
    status_code: status,
    response_time: responseTime,
  });
};
