/**
 * Document AI Schema Version — Domain Types
 *
 * A version is an immutable snapshot of a `DocSchema`'s mutable state at
 * save time. Created automatically by `DocSchemaService` before every
 * mutation, so the FE's "Versions" tab can show full history + revert.
 */

import type { DocAttribute } from "./doc-schema.types";

/**
 * The portion of `DocSchema` that's worth snapshotting — everything that can
 * change after creation (excluding ids and timestamps managed by DB).
 */
export interface SchemaSnapshot {
  name: string;
  category_id: string | null;
  access_teams: string[];
  attributes: DocAttribute[];
  agent_ids: string[];
  databoard_ids: string[];
}

export interface DocSchemaVersion {
  _id: string;
  id?: string;
  schema_id: string;
  /** Per-schema monotonic version number, starting at 1. */
  version: number;
  snapshot: SchemaSnapshot;
  /** Optional user-supplied note (commit-message style). */
  change_note: string | null;
  /** Auto-generated summary of what changed vs the previous version. */
  diff_summary: string | null;
  created_at: Date;
  created_by: string | null;
  /**
   * Display name of the user who created this version, resolved from the
   * platform `/api/platform/v1/account` endpoint at write time. Frozen as-of
   * snapshot — if the user renames later, old versions still carry the name
   * they had when the version was written.
   */
  created_by_name: string | null;
}

export interface ListVersionsFilters {
  limit?: number;
  skip?: number;
}

export interface CreateVersionInput {
  schema_id: string;
  version: number;
  snapshot: SchemaSnapshot;
  change_note?: string | null;
  diff_summary?: string | null;
  created_by?: string | null;
  created_by_name?: string | null;
}
