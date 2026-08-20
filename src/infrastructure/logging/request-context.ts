/**
 * Request Context (AsyncLocalStorage)
 *
 * Holds per-request correlation data so that ANY code on the call stack — deep
 * service functions that never see the Hono `Context` — can attach the same
 * `request_id`, `ip`, `method`, `path` and `proxy` to its log lines and to
 * outbound HTTP calls.
 *
 * Populated once per request by `requestContext.middleware.ts`, read by the
 * Winston logger format (`logger.ts`) and the shared axios client
 * (`infrastructure/http/client.ts`).
 *
 * This is the reusable core of the observability rollout (see
 * OBSERVABILITY_DESIGN.md §5) adapted for Hono.
 */

import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";

/** Canonical correlation-id header. Same name on every service & every hop. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Header naming the immediate upstream service that proxied this request
 * (fills the `proxy` log field). Set by our outbound axios client; read here.
 */
export const PROXY_HEADER = "x-proxy";

export interface RequestContext {
  /** Correlation id — propagated unchanged across every hop. */
  requestId: string;
  /** Client / caller IP. */
  ip: string;
  /** HTTP method of the inbound request. */
  method: string;
  /** Inbound request path. */
  path: string;
  /** Immediate upstream that forwarded us (e.g. "app-gateway"), or "client". */
  proxy: string;
  /** epoch ms when the request entered — used for response_time_ms. */
  startTime: number;
}

const als = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with the given request context bound for its entire async tree. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** Current request context, or undefined outside an HTTP request (e.g. cron). */
export function getContext(): RequestContext | undefined {
  return als.getStore();
}

/** Convenience: current request id, or undefined. */
export function getRequestId(): string | undefined {
  return als.getStore()?.requestId;
}

/**
 * Run a non-HTTP unit of work (cron tick, Kafka consumer, queue job, startup
 * task) inside a freshly-minted correlation context, so every log line it emits
 * shares one `request_id` and any outbound call it makes propagates that id.
 *
 *   runWithJobContext("onedrive-poll", () => this.pollForChanges());
 *
 * If the work was triggered by an upstream that already carried a request id
 * (e.g. a Kafka message envelope), pass it as `incomingRequestId` to keep the
 * trace continuous across the async hop.
 */
export function runWithJobContext<T>(
  jobName: string,
  fn: () => T,
  opts?: { incomingRequestId?: string },
): T {
  const ctx: RequestContext = {
    requestId: opts?.incomingRequestId || randomUUID(),
    ip: "",
    method: "JOB", // synthetic marker — not an HTTP method
    path: jobName, // e.g. "onedrive-poll" — what this run is
    proxy: "cron", // marks the originator (cron/worker/consumer)
    startTime: Date.now(),
  };
  return runWithContext(ctx, fn);
}
