/**
 * Document AI Schema Version Service.
 *
 * Responsibilities:
 *  - Public read API (list, get one)
 *  - Revert (writes a NEW version with the target snapshot + replays it onto
 *    the current schema)
 *  - Snapshot creation helper used by `DocSchemaService` mutations
 *  - Diff summary generator for human-readable history
 */

import type { DatabaseClient } from "../../infrastructure/database/types";
import { DocSchemaVersionRepository } from "../../infrastructure/database/repositories/doc-schema-version.repository";
import { DocSchemaRepository } from "../../infrastructure/database/repositories/doc-schema.repository";
import type {
  DocSchemaVersion,
  ListVersionsFilters,
  SchemaSnapshot,
} from "../../domain/shared/doc-schema-version.types";
import type {
  DocAttribute,
  DocSchema,
} from "../../domain/shared/doc-schema.types";
import {
  NotFoundError,
  ValidationError,
} from "../../domain/shared/errors";
import logger from "../../infrastructure/logging/logger";

export interface DocSchemaVersionServiceConfig {
  db: DatabaseClient;
}

export interface SnapshotContext {
  changeNote?: string | null;
  diffSummary?: string | null;
  createdBy?: string | null;
  createdByName?: string | null;
}

export class DocSchemaVersionService {
  private versionRepo: DocSchemaVersionRepository;
  private schemaRepo: DocSchemaRepository;

  constructor(config: DocSchemaVersionServiceConfig) {
    this.versionRepo = new DocSchemaVersionRepository(config.db);
    this.schemaRepo = new DocSchemaRepository(config.db);
  }

  /** Project a `DocSchema` to a `SchemaSnapshot` (drops timestamps + ids). */
  static projectSnapshot(schema: DocSchema): SchemaSnapshot {
    return {
      name: schema.name,
      category_id: schema.category_id,
      access_teams: schema.access_teams,
      attributes: schema.attributes,
      agent_ids: schema.agent_ids,
      databoard_ids: schema.databoard_ids,
    };
  }

  /**
   * Persist a new version row. Used by `DocSchemaService` after every mutation
   * (and on create) — kept on this service so the version-bump logic lives in
   * one place and is testable in isolation.
   */
  async writeSnapshot(
    schemaId: string,
    snapshot: SchemaSnapshot,
    ctx: SnapshotContext = {},
  ): Promise<DocSchemaVersion> {
    const next = (await this.versionRepo.maxVersion(schemaId)) + 1;
    return this.versionRepo.create({
      schema_id: schemaId,
      version: next,
      snapshot,
      change_note: ctx.changeNote ?? null,
      diff_summary: ctx.diffSummary ?? null,
      created_by: ctx.createdBy ?? null,
      created_by_name: ctx.createdByName ?? null,
    });
  }

  async listVersions(
    schemaId: string,
    orgId: string,
    filters: ListVersionsFilters,
  ): Promise<{
    data: DocSchemaVersion[];
    count: number;
    current_version: number;
  }> {
    await this.assertSchema(schemaId, orgId);
    const [data, count, current_version] = await Promise.all([
      this.versionRepo.list(schemaId, filters),
      this.versionRepo.count(schemaId),
      this.versionRepo.maxVersion(schemaId),
    ]);
    return { data, count, current_version };
  }

  async getVersion(
    schemaId: string,
    version: number,
    orgId: string,
  ): Promise<DocSchemaVersion> {
    await this.assertSchema(schemaId, orgId);
    const v = await this.versionRepo.findByVersion(schemaId, version);
    if (!v) {
      throw new NotFoundError(
        `Version ${version} of schema ${schemaId} not found`,
      );
    }
    return v;
  }

  /**
   * Revert: write a NEW version whose snapshot is the target version's
   * snapshot, then overwrite the current schema with that snapshot. The
   * target version stays untouched in history.
   */
  async revertTo(
    schemaId: string,
    targetVersion: number,
    orgId: string,
    ctx: SnapshotContext = {},
  ): Promise<{ schema: DocSchema; version: DocSchemaVersion }> {
    const schema = await this.assertSchema(schemaId, orgId);
    const target = await this.versionRepo.findByVersion(
      schemaId,
      targetVersion,
    );
    if (!target) {
      throw new NotFoundError(
        `Version ${targetVersion} of schema ${schemaId} not found`,
      );
    }

    const snapshot = target.snapshot;
    const newVersion = await this.writeSnapshot(schemaId, snapshot, {
      changeNote: ctx.changeNote ?? `Reverted to version ${targetVersion}`,
      diffSummary: summariseDiff(
        DocSchemaVersionService.projectSnapshot(schema),
        snapshot,
      ),
      createdBy: ctx.createdBy,
      createdByName: ctx.createdByName,
    });

    const updated = await this.schemaRepo.update(schemaId, {
      name: snapshot.name,
      category_id: snapshot.category_id,
      access_teams: snapshot.access_teams,
      attributes: snapshot.attributes,
      agent_ids: snapshot.agent_ids,
      databoard_ids: snapshot.databoard_ids,
    });

    logger.info(
      `Reverted schema ${schemaId} to version ${targetVersion} (new version ${newVersion.version})`,
    );
    return { schema: updated, version: newVersion };
  }

  private async assertSchema(
    schemaId: string,
    orgId: string,
  ): Promise<DocSchema> {
    const s = await this.schemaRepo.findById(schemaId);
    if (!s) throw new NotFoundError(`Schema ${schemaId} not found`);
    if (s.organization_id !== orgId) {
      throw new ValidationError(
        `Schema ${schemaId} belongs to a different organization`,
      );
    }
    return s;
  }
}

// ---------------- helpers ----------------

/**
 * Generate a human-readable diff between two snapshots — used as the default
 * `diff_summary`. Focuses on attribute structure (add/remove/rename/type-change)
 * + scalar metadata changes (name, category, access_teams, linkage sizes).
 * Returns empty string if no changes detected.
 */
export function summariseDiff(
  oldSnap: SchemaSnapshot,
  newSnap: SchemaSnapshot,
): string {
  const parts: string[] = [];

  if (oldSnap.name !== newSnap.name) {
    parts.push(`renamed schema "${oldSnap.name}" → "${newSnap.name}"`);
  }
  if (oldSnap.category_id !== newSnap.category_id) {
    parts.push(
      `category ${oldSnap.category_id ?? "<none>"} → ${newSnap.category_id ?? "<none>"}`,
    );
  }
  if (!sameSet(oldSnap.access_teams, newSnap.access_teams)) {
    parts.push(
      `access_teams ${oldSnap.access_teams.length} → ${newSnap.access_teams.length}`,
    );
  }
  if (!sameSet(oldSnap.agent_ids, newSnap.agent_ids)) {
    parts.push(`agents ${oldSnap.agent_ids.length} → ${newSnap.agent_ids.length}`);
  }
  if (!sameSet(oldSnap.databoard_ids, newSnap.databoard_ids)) {
    parts.push(
      `databoards ${oldSnap.databoard_ids.length} → ${newSnap.databoard_ids.length}`,
    );
  }

  const oldById = new Map(oldSnap.attributes.map((a) => [a.id, a]));
  const newById = new Map(newSnap.attributes.map((a) => [a.id, a]));
  const added: DocAttribute[] = [];
  const removed: DocAttribute[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  const typeChanged: Array<{ name: string; from: string; to: string }> = [];

  for (const [id, attr] of newById) {
    if (!oldById.has(id)) added.push(attr);
  }
  for (const [id, attr] of oldById) {
    if (!newById.has(id)) removed.push(attr);
  }
  for (const [id, attr] of newById) {
    const old = oldById.get(id);
    if (!old) continue;
    if (old.name !== attr.name) {
      renamed.push({ from: old.name, to: attr.name });
    }
    if (old.type !== attr.type) {
      typeChanged.push({ name: attr.name, from: old.type, to: attr.type });
    }
  }

  if (added.length) parts.push(`added ${added.length} attribute(s)`);
  if (removed.length) parts.push(`removed ${removed.length} attribute(s)`);
  for (const r of renamed) parts.push(`renamed "${r.from}" → "${r.to}"`);
  for (const t of typeChanged) {
    parts.push(`type of "${t.name}": ${t.from} → ${t.to}`);
  }

  return parts.join("; ");
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}
