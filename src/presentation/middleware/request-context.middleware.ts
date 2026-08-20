/**
 * Request Context Middleware (Hono)
 *
 * Must be registered FIRST, before any other middleware/route.
 *
 * Responsibilities (OBSERVABILITY_DESIGN.md §4):
 *  - Reuse an inbound `x-request-id` if present & sane, else mint a UUIDv4.
 *  - Capture client IP and the immediate upstream (`x-proxy`).
 *  - Echo `x-request-id` back to the caller so clients can quote it in tickets.
 *  - Bind a RequestContext for the whole async call tree via AsyncLocalStorage
 *    so deep code and the logger pick up the same correlation fields.
 */

import { randomUUID } from "crypto";
import type { Context, Next } from "hono";
import {
  runWithContext,
  REQUEST_ID_HEADER,
  PROXY_HEADER,
  type RequestContext,
} from "../../infrastructure/logging/request-context";

/** First non-empty client IP from x-forwarded-for, else x-real-ip, else "". */
function resolveIp(c: Context): string {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return c.req.header("x-real-ip") ?? "";
}

export const requestContext = async (c: Context, next: Next) => {
  const incoming = c.req.header(REQUEST_ID_HEADER);
  // Reuse a sane inbound id, otherwise mint one (origin-mint, §4.1 rule 4).
  const requestId =
    incoming && incoming.length > 0 && incoming.length <= 64
      ? incoming
      : randomUUID();

  const ctx: RequestContext = {
    requestId,
    ip: resolveIp(c),
    method: c.req.method,
    path: c.req.path,
    proxy: c.req.header(PROXY_HEADER) ?? "client",
    startTime: Date.now(),
  };

  // Echo back so the caller/client can correlate.
  c.res.headers.set(REQUEST_ID_HEADER, requestId);
  // Also expose on Hono context for handlers that prefer c.get("requestId").
  c.set("requestId", requestId);

  await runWithContext(ctx, () => next());
};
