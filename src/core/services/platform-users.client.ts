/**
 * Tiny client for the platform-service `GET /v1/users/_all` endpoint.
 *
 * Used to resolve assignee/people field values (bare user ids) into the
 * `{ id, display_name, email, avatar_url }` shape the FE + CSV export expect.
 * The pre-migration Mongo backend stored that object on the value; the PG port
 * stores only the id, so we re-hydrate it on read (see
 * `BoardItemService.hydrateAssigneeFields`).
 *
 * Auth mirrors `platform-account.client`:
 *   - `x-organization-id` scopes the list (platform requires it).
 *   - `x-user-id` (trusted internal call forwarded by the gateway) and/or
 *     `x-access-token` (direct/local calls) authenticate the request.
 *
 * Hits the `.lan` vhost directly — the `/api/platform/` prefix only exists at
 * the gateway, so the internal route is just `/v1/users/_all`.
 *
 * Failures are non-fatal: returns an empty Map and lets the read proceed with
 * un-hydrated (id-only) values rather than failing the whole board fetch.
 */

import axios from "axios";
import config from "../../config";
import logger from "../../infrastructure/logging/logger";

// `/v1/users/_all` returns a bare array of user objects (see platform-service
// UserController.toResponse). `id` is the public id (e.g. `u_...`) that board
// item assignee values reference.
interface PlatformUser {
  id?: string;
  public_id?: string | null;
  display_name?: string;
  email?: string;
  avatar_url?: string;
}

/** Hydrated assignee value shape (matches legacy Mongo + FE/CSV expectations). */
export interface AssigneeSummary {
  id: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

export interface FetchOrgUsersArgs {
  organizationId?: string;
  userId?: string;
  accessToken?: string;
}

/**
 * Fetch the org's active users and return a `Map<userId → AssigneeSummary>`.
 * Keyed by both `id` and `public_id` so an assignee value referencing either
 * resolves. Returns an empty Map on any failure (missing config/creds, network
 * error) — callers degrade to id-only values.
 */
export async function fetchOrgUserMap(
  args: FetchOrgUsersArgs,
): Promise<Map<string, AssigneeSummary>> {
  const empty = new Map<string, AssigneeSummary>();

  if (!config.platformServiceHost) {
    logger.warn(
      "platform-users: PLATFORM_SERVICE_HOST not configured — skipping assignee hydration",
    );
    return empty;
  }
  if (!args.organizationId) {
    logger.warn(
      "platform-users: no organizationId on request — skipping assignee hydration",
    );
    return empty;
  }
  if (!args.userId && !args.accessToken) {
    logger.warn(
      "platform-users: no userId or accessToken on request — skipping assignee hydration",
    );
    return empty;
  }

  const url = `${config.platformServiceHost.replace(/\/$/, "")}/v1/users/_all?status=active`;
  const headers: Record<string, string> = { accept: "application/json" };
  headers["x-organization-id"] = args.organizationId;
  if (args.userId) headers["x-user-id"] = args.userId;
  if (args.accessToken) headers["x-access-token"] = args.accessToken;

  try {
    const response = await axios.get<PlatformUser[]>(url, {
      headers,
      timeout: 5_000,
    });
    const users = Array.isArray(response.data) ? response.data : [];
    const map = new Map<string, AssigneeSummary>();
    for (const u of users) {
      const summary: AssigneeSummary = {
        id: (u.id ?? u.public_id) as string,
        // Fall back to email when the platform user has no display_name (some
        // users are stored with an empty display_name) — otherwise the CRM
        // Assignee cell renders blank even though the user exists. The user
        // picker itself lists these users by email, so mirror that.
        display_name: u.display_name?.trim() || u.email?.trim() || null,
        email: u.email?.trim() || null,
        avatar_url: u.avatar_url?.trim() || null,
      };
      if (u.id) map.set(u.id, summary);
      if (u.public_id) map.set(u.public_id, summary);
    }
    logger.info("platform-users: resolved org users for assignee hydration", {
      organizationId: args.organizationId,
      userCount: users.length,
    });
    return map;
  } catch (error: any) {
    logger.warn("platform-users: failed to resolve org users", {
      url,
      status: error?.response?.status,
      error: error?.message,
    });
    return empty;
  }
}
