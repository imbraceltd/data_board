/**
 * Document AI — Schema Attribute Extraction Service.
 *
 * Backs `POST /api/schemas/_extract-attributes`. Forwards file URLs to
 * messagesuggestion's `/data-board/suggest-field-types` (user-facing
 * endpoint) via the `/ai-agent/*` gateway and maps the response's
 * `FieldTypeSuggestion[]` to our `DocAttribute[]` shape.
 *
 * Caller is expected to upload the files themselves first (e.g. via
 * `POST /api/files/upload` or `POST /api/boards/_fileupload`) and pass the
 * resulting public URLs in `file_urls` — keeps this service stateless and
 * lets FE/AI agents reuse already-stored files without re-upload.
 */

import axios from "axios";
import crypto from "crypto";
import config from "../../config";
import { BoardFieldType } from "../../domain/shared/board.types";
import type { DocAttribute } from "../../domain/shared/doc-schema.types";
import {
  ValidationError,
  ExternalServiceError,
} from "../../domain/shared/errors";
import { EXTRACT_ATTRIBUTES_LIMITS } from "../../presentation/schemas/doc-schema.schema";
import logger from "../../infrastructure/logging/logger";
import type { DatabaseClient } from "../../infrastructure/database/types";
import { DocSchemaService } from "./doc-schema.service";
import { BoardService } from "./board.service";

interface UpstreamSubField {
  field_name: string;
  type: string;
}

interface UpstreamSuggestion {
  field_name: string;
  type: string;
  description?: string;
  sample_data?: string;
  sub_fields?: UpstreamSubField[];
}

interface UpstreamResponse {
  success: boolean;
  data?: UpstreamSuggestion[];
  error?: string;
}

const BOARD_FIELD_TYPES = new Set<string>(Object.values(BoardFieldType));

function normalize(s: string | undefined): string {
  return (s ?? "").toLowerCase().trim();
}

function tokenize(s: string | undefined): string[] {
  return normalize(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[n];
}

function nameSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  const lev = 1 - levenshtein(na, nb) / maxLen;
  const tok = jaccard(tokenize(a), tokenize(b));
  return Math.max(lev, tok);
}

/**
 * Name + type are coupled, not additive: a field "Phone Number" stored as
 * Text means something different from "Phone Number" stored as Number, so a
 * type mismatch must drag the name score down hard. Multiplying nameScore
 * by a 0.3 dampener on type-mismatch gives:
 *   - type match   → full nameScore credit
 *   - type mismatch → 30% of nameScore (still some weight so a clear naming
 *     overlap isn't completely thrown away — useful for "Date" vs "Datetime"
 *     near-misses).
 * Description is the only independent dimension, with a small 0.1 weight so
 * it can break ties between near-equal name/type matches.
 */
function attributePairScore(a: DocAttribute, b: DocAttribute): number {
  const nameScore = nameSimilarity(a.name, b.name);
  const typeMatch = a.type === b.type;
  const nameTypeScore = typeMatch ? nameScore : nameScore * 0.3;
  const descScore = jaccard(tokenize(a.description), tokenize(b.description));
  return nameTypeScore * 0.9 + descScore * 0.1;
}

function schemaMatchPercent(
  extracted: DocAttribute[],
  schemaAttrs: DocAttribute[],
): number {
  if (extracted.length === 0 || schemaAttrs.length === 0) return 0;
  const pairs: Array<{ i: number; j: number; score: number }> = [];
  for (let i = 0; i < extracted.length; i++) {
    for (let j = 0; j < schemaAttrs.length; j++) {
      pairs.push({
        i,
        j,
        score: attributePairScore(extracted[i], schemaAttrs[j]),
      });
    }
  }
  pairs.sort((p, q) => q.score - p.score);
  const usedI = new Set<number>();
  const usedJ = new Set<number>();
  let total = 0;
  for (const p of pairs) {
    if (usedI.has(p.i) || usedJ.has(p.j)) continue;
    usedI.add(p.i);
    usedJ.add(p.j);
    total += p.score;
  }
  // Normalize by the smaller side (= number of matched pairs) so that extra
  // fields on either side don't penalize the match. Two schemas that share all
  // of the smaller one's fields score high even if one has additional columns —
  // e.g. a stored 5-field schema vs an extracted 6-field one (with one extra
  // "QR Code") still reads as a strong match instead of being dragged below the
  // threshold by the unmatched field.
  const denom = Math.min(extracted.length, schemaAttrs.length);
  return Math.round((total / denom) * 100);
}

function coerceType(raw: string): { type: BoardFieldType; unmapped: boolean } {
  if (BOARD_FIELD_TYPES.has(raw)) {
    return { type: raw as BoardFieldType, unmapped: false };
  }
  if (raw === "RichText")
    return { type: BoardFieldType.LONG_TEXT, unmapped: false };
  return { type: BoardFieldType.SHORT_TEXT, unmapped: true };
}

export interface ExtractAttributesInput {
  file_urls: string[];
  provider_id?: string;
  model_name?: string;
  /** Optional override forwarded straight through to upstream. */
  board_schema_url?: string;
}

export interface ExtractAttributesCredentials {
  accessToken?: string;
  apiKey?: string;
}

export interface SimilarSchemaMatch {
  schema_id: string;
  schema_name: string;
  match_percent: number;
}

export interface SimilarBoardMatch {
  board_id: string;
  board_name: string;
  match_percent: number;
}

/** Threshold for `similar_boards` — boards below this are dropped. */
const SIMILAR_BOARD_THRESHOLD = 50;

/** Threshold for `similar_schema` — return null if the best match is below. */
const SIMILAR_SCHEMA_THRESHOLD = 50;

export interface ExtractAttributesResult {
  attributes: DocAttribute[];
  similar_schema: SimilarSchemaMatch | null;
  /** Boards with `match_percent >= 50`, sorted desc. Empty array if none. */
  similar_boards: SimilarBoardMatch[];
}

export interface DocSchemaExtractionServiceConfig {
  db: DatabaseClient;
}

export class DocSchemaExtractionService {
  private db: DatabaseClient;

  constructor(config: DocSchemaExtractionServiceConfig) {
    this.db = config.db;
  }

  async extractAttributes(
    input: ExtractAttributesInput,
    organizationId: string,
    userId: string,
    credentials: ExtractAttributesCredentials = {},
  ): Promise<ExtractAttributesResult> {
    this.validateInput(input);

    if (!config.messageSuggestionUrl && !config.appGatewayHost) {
      throw new ExternalServiceError(
        "Neither MESSAGE_SUGGESTION_URL nor APP_GATEWAY_HOST configured",
      );
    }

    const suggestions = await this.callUpstream(
      input,
      organizationId,
      userId,
      credentials,
    );
    const attributes = this.mapSuggestions(suggestions);
    const [similar_schema, similar_boards] = await Promise.all([
      this.findMostSimilarSchema(organizationId, attributes),
      this.findSimilarBoards(organizationId, attributes),
    ]);
    return { attributes, similar_schema, similar_boards };
  }

  /**
   * Reuse the same scoring algorithm as `findMostSimilarSchema` but against
   * boards provisioned from a schema (identified by `from_schema_id`). Returns
   * ALL matches with `match_percent >= SIMILAR_BOARD_THRESHOLD`, sorted desc.
   * Failures are swallowed (returns []) so extraction never fails because of
   * similarity.
   */
  private async findSimilarBoards(
    orgId: string,
    extracted: DocAttribute[],
  ): Promise<SimilarBoardMatch[]> {
    if (extracted.length === 0) return [];
    try {
      const boardService = new BoardService({ db: this.db });
      const allBoards = await boardService.getBoards(orgId);
      const boards = allBoards.filter((b) => b.from_schema_id);
      logger.info("[similar-boards] loaded org boards", {
        orgId,
        returned: boards.length,
      });
      const results: SimilarBoardMatch[] = [];
      for (const board of boards) {
        // Project BoardField -> attribute-like shape for the scorer (same
        // fields it inspects: name, type, description, id for pairing).
        const projected: DocAttribute[] = (board.fields ?? []).map((f) => ({
          id: f.id,
          name: f.name,
          type: f.type,
          description: f.description,
        }));
        const pct = schemaMatchPercent(extracted, projected);
        if (pct >= SIMILAR_BOARD_THRESHOLD) {
          results.push({
            board_id: board._id ?? (board.id as string),
            board_name: board.name,
            match_percent: pct,
          });
        }
      }
      results.sort((a, b) => b.match_percent - a.match_percent);
      logger.info("[similar-boards] matches", {
        threshold: SIMILAR_BOARD_THRESHOLD,
        matched: results.length,
      });
      return results;
    } catch (error) {
      logger.error("[similar-boards] failed", {
        message: (error as Error).message,
      });
      return [];
    }
  }

  private async findMostSimilarSchema(
    orgId: string,
    extracted: DocAttribute[],
  ): Promise<SimilarSchemaMatch | null> {
    logger.info("[similar-schema] start", {
      orgId,
      extractedCount: extracted.length,
      extractedFields: extracted.map((a) => ({ name: a.name, type: a.type })),
    });
    if (extracted.length === 0) {
      logger.info("[similar-schema] skip — no extracted attributes");
      return null;
    }
    try {
      const service = new DocSchemaService({ db: this.db });
      const { data, count } = await service.list(orgId, { limit: 500 });
      logger.info("[similar-schema] loaded org schemas", {
        orgId,
        returned: data.length,
        totalCount: count,
      });
      if (data.length === 0) {
        logger.info("[similar-schema] org has no schemas");
        return null;
      }
      let best: SimilarSchemaMatch | null = null;
      for (const schema of data) {
        const attrs = schema.attributes ?? [];
        const pct = schemaMatchPercent(extracted, attrs);
        logger.info("[similar-schema] candidate", {
          schema_id: schema._id,
          schema_name: schema.name,
          schemaAttrCount: attrs.length,
          schemaFields: attrs.map((a) => ({ name: a.name, type: a.type })),
          match_percent: pct,
        });
        if (!best || pct > best.match_percent) {
          best = {
            schema_id: schema._id,
            schema_name: schema.name,
            match_percent: pct,
          };
        }
      }
      logger.info("[similar-schema] best match", {
        best,
        threshold: SIMILAR_SCHEMA_THRESHOLD,
      });
      // Drop the suggestion entirely if even the best candidate is too weak —
      // a 25% match is just noise and the FE shouldn't surface it.
      if (!best || best.match_percent < SIMILAR_SCHEMA_THRESHOLD) return null;
      return best;
    } catch (error) {
      logger.error("[similar-schema] failed", {
        message: (error as Error).message,
        stack: (error as Error).stack,
      });
      return null;
    }
  }

  private validateInput(input: ExtractAttributesInput): void {
    if (!input.file_urls?.length) {
      throw new ValidationError("file_urls is required and must be non-empty");
    }
    if (input.file_urls.length > EXTRACT_ATTRIBUTES_LIMITS.maxFiles) {
      throw new ValidationError(
        `Up to ${EXTRACT_ATTRIBUTES_LIMITS.maxFiles} files allowed per request`,
      );
    }
  }

  private async callUpstream(
    input: ExtractAttributesInput,
    organizationId: string,
    userId: string,
    credentials: ExtractAttributesCredentials = {},
  ): Promise<UpstreamSuggestion[]> {
    // User-facing endpoint (no `-internal` suffix) — it accepts provider_id +
    // model_name and requires a credential. Prefer the direct LAN route when
    // MESSAGE_SUGGESTION_URL is set (server compose): messagesuggestion's
    // authorize middleware only checks header presence, so forwarding the same
    // x-api-key/x-access-token works without the gateway hop — and the gateway
    // hairpin would cap this long-running call at its proxy timeout anyway.
    // Fallback (local dev): route through `/ai-agent/*` on the gateway, which
    // validates and forwards the credential headers.
    const url = config.messageSuggestionUrl
      ? `${config.messageSuggestionUrl.replace(/\/$/, "")}/api/data-board/suggest-field-types`
      : `${config.appGatewayHost.replace(/\/$/, "")}/ai-agent/data-board/suggest-field-types`;

    const authHeaders: Record<string, string> = {};
    if (credentials.apiKey) authHeaders["x-api-key"] = credentials.apiKey;
    if (credentials.accessToken)
      authHeaders["x-access-token"] = credentials.accessToken;

    if (!authHeaders["x-api-key"] && !authHeaders["x-access-token"]) {
      throw new ExternalServiceError(
        "Missing credential — pass x-access-token or x-api-key on the request",
      );
    }

    const body: Record<string, unknown> = {
      file_urls: input.file_urls,
      organization_id: organizationId,
    };
    if (input.provider_id) body.provider_id = input.provider_id;
    if (input.model_name) body.model_name = input.model_name;
    if (input.board_schema_url) body.board_schema_url = input.board_schema_url;

    try {
      const response = await axios.post<UpstreamResponse>(url, body, {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
          "x-organization-id": organizationId,
          ...authHeaders,
        },
        timeout: 120_000,
      });
      if (!response.data?.success || !response.data?.data) {
        throw new ExternalServiceError(
          response.data?.error || "Upstream returned no suggestions",
        );
      }
      return response.data.data;
    } catch (error: any) {
      if (error instanceof ExternalServiceError) throw error;
      const upstreamData = error?.response?.data;
      const upstreamMsg =
        upstreamData?.error ||
        upstreamData?.message ||
        error?.message ||
        "Upstream call failed";
      logger.error("messagesuggestion suggest-field-types failed", {
        url,
        status: error?.response?.status,
        upstreamBody: upstreamData,
        error: upstreamMsg,
      });
      throw new ExternalServiceError(upstreamMsg);
    }
  }

  private mapSuggestions(suggestions: UpstreamSuggestion[]): DocAttribute[] {
    return suggestions.map((s, index) => {
      const { type, unmapped } = coerceType(s.type);
      const id = crypto.randomUUID();
      const attribute: DocAttribute = {
        id,
        _id: id,
        name: s.field_name,
        type,
        order: index,
      };
      if (s.description) {
        attribute.description = unmapped
          ? `[Original type: ${s.type}] ${s.description}`
          : s.description;
      } else if (unmapped) {
        attribute.description = `[Original type: ${s.type}]`;
      }
      if (s.sample_data) {
        attribute.sampleData = s.sample_data;
      }
      if (type === BoardFieldType.TABLE_IN_TABLE && s.sub_fields?.length) {
        attribute.settings = {
          columns: s.sub_fields.map((sf) => ({
            name: sf.field_name,
            type: coerceType(sf.type).type,
          })),
        };
      }
      return attribute;
    });
  }
}
