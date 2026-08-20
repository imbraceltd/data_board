/**
 * Context Middleware
 * Extracts user context from gateway headers
 */

import type { Context, Next } from "hono";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/drizzle/schema";
import logger from "../../infrastructure/logging/logger";
import { resolveUserTeamIds } from "../../core/services/platform-account.client";

/**
 * Middleware to inject database into context
 */
export function injectDatabase(db: NodePgDatabase<typeof schema>) {
  return async (c: Context, next: Next) => {
    c.set("db", db);
    await next();
  };
}

/**
 * Middleware to extract user context from gateway headers
 * Gateway should inject these headers after authentication
 */
export function extractUserContext() {
  return async (c: Context, next: Next) => {
    // Extract from headers injected by gateway
    const userId = c.req.header("x-user-id");
    const organizationId = c.req.header("x-organization-id");
    const businessUnitId = c.req.header("x-business-unit-id");

    // Set in context for controllers to use
    if (userId) c.set("userId", userId);
    if (organizationId) c.set("organizationId", organizationId);
    if (businessUnitId) c.set("businessUnitId", businessUnitId);

    // NOTE: team membership is deliberately NOT taken from a header. Team
    // scoping is resolved server-side from the caller's identity via
    // `resolveTeamScope` (board routes only) — see that middleware below.

    logger.debug("User context extracted", {
      userId,
      organizationId,
    });

    await next();
  };
}

/**
 * Resolve the caller's team scope server-side and stash it on the context.
 *
 * This is the new home of the legacy monolith's "derive teams from the
 * authenticated user, then filter boards" behavior — the team list is looked up
 * from platform-service (which owns team membership), keyed on the trusted
 * `x-user-id`, NOT trusted from an inbound header.
 *
 * Sets two context values consumed by board handlers:
 *   - `teamIds`           : string[]  (joined team ids; [] when none/unresolved)
 *   - `teamScopeResolved` : boolean   (true only when platform answered)
 *
 * Apply to board routes only — other routers don't scope by team and shouldn't
 * pay the lookup cost.
 */
export function resolveTeamScope() {
  return async (c: Context, next: Next) => {
    const userId = c.get("userId");
    const organizationId = c.get("organizationId");
    const accessToken =
      c.req.header("x-access-token") ??
      c.req.header("authorization")?.replace(/^Bearer\s+/i, "");

    const scope = await resolveUserTeamIds({
      userId,
      organizationId,
      accessToken,
    });

    c.set("teamIds", scope.teamIds);
    c.set("teamScopeResolved", scope.resolved);

    if (!scope.resolved) {
      logger.warn("team scope unresolved — boards fail open to org", {
        userId,
        organizationId,
      });
    }

    await next();
  };
}

export function extractCredentials() {
  return async (c: Context, next: Next) => {
    const accessToken =
      c.req.header("x-access-token") ??
      c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const apiKey = c.req.header("x-api-key");

    if (accessToken) c.set("accessToken", accessToken);
    if (apiKey) c.set("apiKey", apiKey);

    await next();
  };
}

/**
 * Middleware to require organization context
 */
export function requireOrganization() {
  return async (c: Context, next: Next) => {
    const organizationId = c.get("organizationId");

    if (!organizationId) {
      return c.json(
        {
          error: "Organization context required",
          message: "x-organization-id header missing",
        },
        401,
      );
    }

    await next();
  };
}

/**
 * Middleware to require user context
 */
export function requireUser() {
  return async (c: Context, next: Next) => {
    const userId = c.get("userId");

    if (!userId) {
      return c.json(
        {
          error: "User context required",
          message: "x-user-id header missing",
        },
        401,
      );
    }

    await next();
  };
}

/**
 * Request logging middleware
 */
export function requestLogger() {
  return async (c: Context, next: Next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    const userId = c.get("userId");

    await next();

    const duration = Date.now() - start;
    const status = c.res.status;

    logger.info("Request completed", {
      method,
      path,
      status,
      duration: `${duration}ms`,
      userId,
    });
  };
}
