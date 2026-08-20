/**
 * Tiny client for the platform-service `/v1/account` endpoint.
 *
 * Used to resolve a user's display name so version rows can persist a
 * human-readable `created_by_name` next to the `created_by` user id.
 *
 * Two auth modes, picked in order:
 *   1. `x-user-id` + `x-organization-id` — trusted internal call (gateway
 *      forwards user_id derived from the access token; same pattern as
 *      channel-service touchpoint reads).
 *   2. `x-access-token` — fallback for local/direct calls that bypass the
 *      gateway. Platform's accessMiddleware resolves the user from the token
 *      itself.
 *
 * Both hit the `.lan` vhost directly — the `/api/platform/` prefix only exists
 * at the gateway, so the internal route is just `/v1/account`.
 *
 * Failures are non-fatal — we return `null` and let the mutation proceed with
 * `created_by_name = null` rather than block the user from saving because of a
 * platform hiccup. The mutation already writes `created_by` (id), so the audit
 * trail is preserved.
 */

import axios from "axios";
import config from "../../config";
import logger from "../../infrastructure/logging/logger";

// Platform `/v1/account` returns top-level snake_case fields (see
// platform-service/src/interfaces/http/controllers/AccountController.ts
// `toAccountResponse`).
interface AccountResponse {
  display_name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
}

function pickName(payload: AccountResponse | undefined): string | null {
  if (!payload) return null;
  const display = payload.display_name?.trim();
  if (display) return display;
  const composed = [payload.first_name, payload.last_name]
    .map((v) => v?.trim() ?? "")
    .filter((v) => v.length > 0)
    .join(" ");
  if (composed) return composed;
  const email = payload.email?.trim();
  return email || null;
}

export interface ResolveCurrentUserNameArgs {
  userId?: string;
  organizationId?: string;
  accessToken?: string;
}

/**
 * Resolve the user's display name from platform. Returns null on any failure
 * (missing creds, network error, missing field) — callers must treat null as
 * "name unknown" rather than retrying.
 */
export async function resolveCurrentUserName(
  args: ResolveCurrentUserNameArgs,
): Promise<string | null> {
  if (!config.platformServiceHost) {
    logger.warn(
      "platform-account: PLATFORM_SERVICE_HOST not configured — skipping name resolution",
    );
    return null;
  }
  if (!args.userId && !args.accessToken) {
    logger.warn(
      "platform-account: no userId or accessToken on request — skipping name resolution",
    );
    return null;
  }

  const url = `${config.platformServiceHost.replace(/\/$/, "")}/v1/account`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (args.userId) headers["x-user-id"] = args.userId;
  if (args.accessToken) headers["x-access-token"] = args.accessToken;
  if (args.organizationId) headers["x-organization-id"] = args.organizationId;

  logger.info("platform-account: resolving user name", {
    url,
    hasUserId: !!args.userId,
    hasAccessToken: !!args.accessToken,
    organizationId: args.organizationId,
  });

  try {
    const response = await axios.get<AccountResponse>(url, {
      headers,
      timeout: 5_000,
    });
    const name = pickName(response.data);
    logger.info("platform-account: resolved", {
      status: response.status,
      name,
      bodyKeys: Object.keys(response.data ?? {}),
    });
    return name;
  } catch (error: any) {
    logger.warn("platform-account: failed to resolve", {
      url,
      status: error?.response?.status,
      data: error?.response?.data,
      error: error?.message,
    });
    return null;
  }
}

// --- Team-membership resolution -------------------------------------------
//
// Mirrors the legacy monolith's flow: the boards service resolves the caller's
// teams server-side from their identity (NOT from a gateway-supplied header),
// then filters boards by `managers[].teamId`. Here the lookup is an internal
// call to platform-service (which owns the team tables) keyed on the trusted
// `x-user-id` the gateway already derives from the access token.

export interface TeamScope {
  // true  → platform answered; `teamIds` is authoritative (may be empty).
  // false → could not resolve (no creds / platform error). Callers fail-open.
  resolved: boolean;
  teamIds: string[];
}

interface TeamIdsResponse {
  team_ids?: string[];
}

const UNRESOLVED: TeamScope = { resolved: false, teamIds: [] };

// Short-lived cache so we don't hit platform on every board request. Keyed by
// user+org; 60s TTL keeps join/leave changes near-instant while collapsing
// bursts (a board list + its item-count fan-out) into one lookup.
const TEAM_SCOPE_TTL_MS = 60_000;
const teamScopeCache = new Map<string, { scope: TeamScope; expiresAt: number }>();

export interface ResolveUserTeamIdsArgs {
  userId?: string;
  organizationId?: string;
  accessToken?: string;
  now?: number; // injectable clock for tests
}

/**
 * Resolve the caller's joined team ids from platform-service.
 *
 * Returns `{ resolved: false }` (fail-open signal) when creds/host are missing
 * or platform errors out — callers should then list across the whole org rather
 * than lock the user out. A successful response with an empty list is
 * `{ resolved: true, teamIds: [] }` and means "scope to no-manager boards only".
 */
export async function resolveUserTeamIds(
  args: ResolveUserTeamIdsArgs,
): Promise<TeamScope> {
  if (!config.platformServiceHost) return UNRESOLVED;
  // accessMiddleware needs x-user-id + x-organization-id (or a token).
  if ((!args.userId || !args.organizationId) && !args.accessToken) {
    return UNRESOLVED;
  }

  const now = args.now ?? Date.now();
  const cacheKey = `${args.userId ?? ""}:${args.organizationId ?? ""}:${
    args.accessToken ? "t" : ""
  }`;
  const cached = teamScopeCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.scope;

  const url = `${config.platformServiceHost.replace(/\/$/, "")}/v1/team/_my_team_ids`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (args.userId) headers["x-user-id"] = args.userId;
  if (args.organizationId) headers["x-organization-id"] = args.organizationId;
  if (args.accessToken) headers["x-access-token"] = args.accessToken;

  try {
    const response = await axios.get<TeamIdsResponse>(url, {
      headers,
      timeout: 5_000,
    });
    const teamIds = Array.isArray(response.data?.team_ids)
      ? response.data!.team_ids!.filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        )
      : [];
    const scope: TeamScope = { resolved: true, teamIds };
    teamScopeCache.set(cacheKey, { scope, expiresAt: now + TEAM_SCOPE_TTL_MS });
    logger.info("platform-account: resolved team ids", {
      userId: args.userId,
      organizationId: args.organizationId,
      teamCount: teamIds.length,
    });
    return scope;
  } catch (error: any) {
    // Fail-open: don't cache failures, so the next request retries.
    logger.warn("platform-account: failed to resolve team ids", {
      url,
      status: error?.response?.status,
      error: error?.message,
    });
    return UNRESOLVED;
  }
}
