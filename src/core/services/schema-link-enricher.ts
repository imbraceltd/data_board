/**
 * Enrich Doc Schemas with names of the linked Boards and Agents (Assistants).
 *
 * The persisted schema only stores `databoard_ids` and `agent_ids` (string id
 * arrays). The FE needs human-readable names alongside, so this helper does
 * the lookups in one pass:
 *   - Boards live in our own DB; one batched query per call.
 *   - Agents live in the AI service; one HTTP fetch per unique id, deduped
 *     across all schemas in the page. Failures fall back to `name = null` so
 *     a transient AI-service hiccup or a deleted agent never drops the whole
 *     list response.
 *
 * The original `*_ids` fields are preserved for backward compatibility; the
 * additions are `databoards` / `agents` of shape `{ id, name }[]`. Entries whose
 * name can't be resolved (board/agent deleted, or the AI service is unreachable)
 * are dropped from `databoards` / `agents` so the FE never renders blank-named
 * rows — the id still lives on in `*_ids`, so a transiently-missing agent
 * reappears on the next read once it resolves again.
 */

import axios from "axios";
import config from "../../config";
import logger from "../../infrastructure/logging/logger";
import type { DatabaseClient } from "../../infrastructure/database/types";
import { BoardRepository } from "../../infrastructure/database/repositories/board.repository";
import type { DocSchema } from "../../domain/shared/doc-schema.types";

export interface LinkRef {
  id: string;
  name: string | null;
}

/** Agent link, additionally carrying the marketplace use-case id that wraps the
 *  assistant (null when the agent isn't backed by a use-case / lookup failed). */
export interface AgentLinkRef extends LinkRef {
  usecase_id: string | null;
}

export interface EnrichedDocSchema extends DocSchema {
  databoards: LinkRef[];
  agents: AgentLinkRef[];
}

export interface EnrichLinksContext {
  organizationId: string;
  accessToken?: string;
  apiKey?: string;
}

export async function enrichSchemaLinks(
  schemas: DocSchema[],
  db: DatabaseClient,
  ctx: EnrichLinksContext,
): Promise<EnrichedDocSchema[]> {
  if (schemas.length === 0) return [];

  const boardIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const s of schemas) {
    s.databoard_ids?.forEach((id) => id && boardIds.add(id));
    s.agent_ids?.forEach((id) => id && agentIds.add(id));
  }

  const [boardMap, agentMap, usecaseMap] = await Promise.all([
    resolveBoardNames(db, ctx.organizationId, Array.from(boardIds)),
    resolveAgentNames(Array.from(agentIds), ctx),
    resolveAgentUsecaseIds(Array.from(agentIds), ctx),
  ]);

  // Keep only links we could resolve a name for; a missing name means the
  // board/agent was deleted (or is transiently unreachable) and shouldn't
  // surface as a blank row. `*_ids` stay untouched above for back-compat.
  const toLinks = (
    ids: string[] | undefined,
    nameMap: Map<string, string>,
  ): LinkRef[] =>
    (ids ?? [])
      .filter((id) => nameMap.has(id))
      .map((id) => ({ id, name: nameMap.get(id)! }));

  // Agents additionally carry their wrapping use-case id (null when none).
  const toAgentLinks = (ids: string[] | undefined): AgentLinkRef[] =>
    (ids ?? [])
      .filter((id) => agentMap.has(id))
      .map((id) => ({
        id,
        name: agentMap.get(id)!,
        usecase_id: usecaseMap.get(id) ?? null,
      }));

  return schemas.map((s) => ({
    ...s,
    databoards: toLinks(s.databoard_ids, boardMap),
    agents: toAgentLinks(s.agent_ids),
  }));
}

async function resolveBoardNames(
  db: DatabaseClient,
  orgId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  try {
    const repo = new BoardRepository(db);
    const boards = await repo.findByIds(orgId, ids);
    for (const b of boards) {
      const bid = (b as any).id ?? (b as any)._id;
      if (bid) map.set(String(bid), b.name);
    }
  } catch (error) {
    logger.warn("[enrichSchemaLinks] board name resolution failed", {
      message: (error as Error).message,
    });
  }
  return map;
}

async function resolveAgentNames(
  ids: string[],
  ctx: EnrichLinksContext,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const base = config.aiServiceUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {
    "x-organization-id": ctx.organizationId,
    Accept: "application/json",
  };
  if (ctx.apiKey) headers["x-api-key"] = ctx.apiKey;
  if (ctx.accessToken) headers["x-access-token"] = ctx.accessToken;

  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await axios.get<{ name?: string }>(
          `${base}/assistants/${encodeURIComponent(id)}`,
          { headers, timeout: 5_000 },
        );
        return { id, name: res.data?.name ?? null };
      } catch (error) {
        const status = (error as any)?.response?.status;
        // 404 = agent deleted, log at info; everything else is a real error
        if (status === 404) {
          logger.info("[enrichSchemaLinks] agent not found", { id });
        } else {
          logger.warn("[enrichSchemaLinks] agent fetch failed", {
            id,
            status,
            message: (error as Error).message,
          });
        }
        return { id, name: null };
      }
    }),
  );

  for (const r of results) {
    if (r.name) map.set(r.id, r.name);
  }
  return map;
}

/**
 * Resolve the marketplace use-case id wrapping each assistant, via
 * GET {marketplaceUrl}/v1/use-cases/by-assistant/:assistant_id (one HTTP call
 * per id, deduped by the caller). An assistant with no use-case (404) or a
 * transient failure just won't appear in the map — the agent's `usecase_id`
 * falls back to null, never dropping the agent from the response.
 */
async function resolveAgentUsecaseIds(
  ids: string[],
  ctx: EnrichLinksContext,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const base = config.marketplaceUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {
    "x-organization-id": ctx.organizationId,
    Accept: "application/json",
  };
  if (ctx.accessToken) headers["x-access-token"] = ctx.accessToken;

  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await axios.get<{ data?: { _id?: string; id?: string } }>(
          `${base}/v1/use-cases/by-assistant/${encodeURIComponent(id)}`,
          { headers, timeout: 5_000 },
        );
        const uc = res.data?.data;
        return { id, usecaseId: uc?._id ?? uc?.id ?? null };
      } catch (error) {
        const status = (error as any)?.response?.status;
        // 404 = no use-case wraps this assistant; anything else is a real error.
        if (status !== 404) {
          logger.warn("[enrichSchemaLinks] use-case lookup failed", {
            id,
            status,
            message: (error as Error).message,
          });
        }
        return { id, usecaseId: null };
      }
    }),
  );

  for (const r of results) {
    if (r.usecaseId) map.set(r.id, r.usecaseId);
  }
  return map;
}
