/**
 * AI Proxy Router for Hono
 * Proxies requests from /ai-service/v1/* to the AI service
 */

import { Hono } from "hono";
import config from "../../config";
import logger from "../../infrastructure/logging/logger";

const aiProxyRouter = new Hono();

aiProxyRouter.all("/ai-service/v1/*", async (c) => {
  try {
    const url = new URL(
      c.req.path.replace("/ai-service", ""),
      config.aiProxyUrl,
    );
    const targetUrl =
      url.toString() +
      (url.search ? url.search : "") +
      (c.req.query()
        ? "?" + new URLSearchParams(c.req.query()).toString()
        : "");

    // Actually, Hono c.req.path includes the path.
    // The previous implementation replaced '/ai-service' with empty string.
    // So /ai-service/v1/something -> /v1/something.
    // targetUrl = config.aiProxyUrl + /v1/something.

    // Hono's query handling:
    // c.req.url contains the full URL.
    // We can just construct the target URL from path and query.

    // Let's be precise:
    const originalPath = c.req.path; // e.g. /ai-service/v1/chat
    const targetPath = originalPath.replace("/ai-service", ""); // e.g. /v1/chat

    const targetUrlObj = new URL(targetPath, config.aiProxyUrl);

    // Append query params
    const query = c.req.query();
    Object.keys(query).forEach((key) =>
      targetUrlObj.searchParams.append(key, query[key]),
    );

    const headers: Record<string, string> = {
      "content-type": c.req.header("content-type") || "application/json",
      "user-agent": c.req.header("user-agent") || "data-board-proxy-hono",
      accept: c.req.header("accept") || "*/*",
    };

    // Forward identity headers — AI service is private and only needs org/user context
    const orgId = c.req.header("x-organization-id");
    const userId = c.req.header("x-user-id");
    if (orgId) headers["x-organization-id"] = orgId;
    if (userId) headers["x-user-id"] = userId;

    // Do NOT set Host header manually usually, fetch handles it.
    // But original code did `headers.host = ...`.

    const method = c.req.method;
    let body: any = undefined;

    if (method !== "GET" && method !== "HEAD") {
      // Try to get body.
      // If content-type is json, parse and stringify to match original behavior.
      // Or better, just forward the text/buffer to be generic.
      // Original code: JSON.stringify(req.body). This implies req.body was an object.
      // Hono: c.req.parseBody() or c.req.json().

      // If we want to strictly match "JSON.stringify(req.body)", we should try to parse as JSON first.
      const contentType = c.req.header("content-type");
      if (contentType && contentType.includes("application/json")) {
        try {
          const json = await c.req.json();
          body = JSON.stringify(json);
        } catch (e) {
          // If fails (maybe empty), ignore or check text
          body = await c.req.text();
        }
      } else {
        // For other types, just text
        body = await c.req.text();
      }
    }

    const response = await fetch(targetUrlObj.toString(), {
      method,
      headers,
      body,
    });

    // Copy response status
    c.status(response.status as any);

    // Copy headers
    response.headers.forEach((value, key) => {
      c.header(key, value);
    });

    // Send response
    const responseBody = await response.text();
    return c.body(responseBody);
  } catch (error) {
    logger.error("AI Proxy error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default aiProxyRouter;
