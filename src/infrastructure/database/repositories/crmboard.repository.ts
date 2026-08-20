/**
 * CRMBoard Repository — Step 1 (read-only finders + minimal write surface).
 *
 * Reads go through the DatabaseClient abstraction so the Mongo adapter
 * (legacy deployments) still works. JSONB-containment lookups for
 * `folder_ids` fall back to a raw Drizzle query because the adapter's
 * WhereClause vocabulary has no `@>` equivalent.
 */

import type { DatabaseClient } from "../types";
import type {
  CRMBoard,
  CreateCRMBoardDTO,
  UpdateCRMBoardDTO,
} from "../../../domain/shared/crmboard.types";
import { DatabaseError, NotFoundError } from "../../../domain/shared/errors";
import logger from "../../logging/logger";
import { sql, and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/drizzle/schema";
import * as crypto from "crypto";

const TABLE = "crmboards";

export class CRMBoardRepository {
  constructor(private readonly db: DatabaseClient) {}

  /**
   * Raw Drizzle handle for queries the WhereClause abstraction can't express
   * (e.g. JSONB `@>` containment for `folder_ids`). Returns null when the
   * adapter is Mongo so callers can fall back gracefully.
   */
  private getDrizzle(): NodePgDatabase<typeof schema> | null {
    const raw = this.db.getRawClient?.();
    if (raw && typeof (raw as any).select === "function") {
      return raw as NodePgDatabase<typeof schema>;
    }
    return null;
  }

  /**
   * Normalize a stored row into the wire shape expected by frontend / IPS
   * consumers: snake_case fields, `_id` alias, `updateNeeded` flag.
   */
  private toJSON(row: any): CRMBoard {
    return {
      _id: row.id || row._id,
      id: row.id || row._id,
      board_id: row.board_id,
      type: row.type,
      workflow_id: row.workflow_id,
      description: row.description ?? null,
      name: row.name,
      organization_id: row.organization_id,
      field_id: row.field_id ?? null,
      trigger_frequency_unit: row.trigger_frequency_unit ?? null,
      trigger_frequency_value: row.trigger_frequency_value ?? null,
      trigger_time: row.trigger_time ?? null,
      trigger_day_of_week: row.trigger_day_of_week ?? null,
      trigger_day_of_month: row.trigger_day_of_month ?? null,
      triger_month_and_day: row.triger_month_and_day ?? null,
      start_date: row.start_date ?? null,
      start_time: row.start_time ?? null,
      start_datetime: row.start_datetime ?? null,
      is_paused: row.is_paused ?? false,
      is_knowledge_base: row.is_knowledge_base ?? false,
      folder_ids: row.folder_ids ?? null,
      updateNeeded:
        (!(row.is_knowledge_base ?? false) &&
          row.type === "update" &&
          !row.field_id) ||
        !row.workflow_id,
    };
  }

  async findAll(): Promise<CRMBoard[]> {
    try {
      const rows = await this.db.findMany<any>(TABLE);
      return rows.map((r) => this.toJSON(r));
    } catch (err) {
      logger.error("CRMBoardRepository.findAll error:", err);
      throw new DatabaseError(`Failed to list CRMBoards: ${(err as Error).message}`);
    }
  }

  async findById(id: string): Promise<CRMBoard | null> {
    try {
      const row = await this.db.findFirst<any>(TABLE, {
        $or: [{ id }, { _id: id }],
      });
      return row ? this.toJSON(row) : null;
    } catch (err) {
      logger.error(`CRMBoardRepository.findById(${id}) error:`, err);
      throw new DatabaseError(`Failed to find CRMBoard: ${(err as Error).message}`);
    }
  }

  async findByBoardId(boardId: string): Promise<CRMBoard[]> {
    const rows = await this.db.findMany<any>(TABLE, { board_id: boardId });
    return rows.map((r) => this.toJSON(r));
  }

  async findByOrganizationId(organizationId: string): Promise<CRMBoard[]> {
    const rows = await this.db.findMany<any>(TABLE, {
      organization_id: organizationId,
    });
    return rows.map((r) => this.toJSON(r));
  }

  async findByBoardIdAndType(
    boardId: string,
    type: string,
  ): Promise<CRMBoard[]> {
    const rows = await this.db.findMany<any>(TABLE, {
      board_id: boardId,
      type,
    });
    return rows.map((r) => this.toJSON(r));
  }

  async findByBoardIdTypeAndFieldId(
    boardId: string,
    type: string,
    fieldId: string,
  ): Promise<CRMBoard[]> {
    const rows = await this.db.findMany<any>(TABLE, {
      board_id: boardId,
      type,
      field_id: fieldId,
    });
    return rows.map((r) => this.toJSON(r));
  }

  async findByFieldId(fieldId: string): Promise<CRMBoard[]> {
    const rows = await this.db.findMany<any>(TABLE, { field_id: fieldId });
    return rows.map((r) => this.toJSON(r));
  }

  async findByWorkflowId(workflowId: string): Promise<CRMBoard[]> {
    const rows = await this.db.findMany<any>(TABLE, { workflow_id: workflowId });
    return rows.map((r) => this.toJSON(r));
  }

  /**
   * Either `folder_ids` contains `folderId` OR `board_id` equals `boardId`.
   * JSONB containment isn't expressible in the abstract WhereClause, so on
   * PG we drop to raw Drizzle; on Mongo we fall back to `$in` semantics.
   */
  async findByFolderIdOrBoardId(
    folderId: string | undefined,
    boardId: string | undefined,
  ): Promise<CRMBoard[]> {
    if (!folderId && !boardId) return [];
    const drz = this.getDrizzle();
    if (drz) {
      const conds: any[] = [];
      if (folderId) {
        conds.push(
          sql`${schema.crmboards.folder_ids} @> ${JSON.stringify([folderId])}::jsonb`,
        );
      }
      if (boardId) conds.push(eq(schema.crmboards.board_id, boardId));
      const rows = await drz
        .select()
        .from(schema.crmboards)
        .where(conds.length === 1 ? conds[0] : sql`(${conds[0]}) OR (${conds[1]})`);
      return rows.map((r) => this.toJSON(r));
    }
    // Mongo fallback — adapter handles `$in` and top-level `$or`.
    const orParts: any[] = [];
    if (folderId) orParts.push({ folder_ids: { $in: [folderId] } });
    if (boardId) orParts.push({ board_id: boardId });
    const rows = await this.db.findMany<any>(TABLE, { $or: orParts });
    return rows.map((r) => this.toJSON(r));
  }

  /**
   * Used by the KB branch of CRM event dispatch: pick automations whose
   * `folder_ids` contains the given folder, matching `type` and KB flag.
   */
  async findByFolderIdTypeAndKnowledgeBase(
    folderId: string,
    type: string,
  ): Promise<CRMBoard[]> {
    if (!folderId) return [];
    const drz = this.getDrizzle();
    if (drz) {
      const rows = await drz
        .select()
        .from(schema.crmboards)
        .where(
          and(
            sql`${schema.crmboards.folder_ids} @> ${JSON.stringify([folderId])}::jsonb`,
            eq(schema.crmboards.type, type),
            eq(schema.crmboards.is_knowledge_base, true),
          ),
        );
      return rows.map((r) => this.toJSON(r));
    }
    const rows = await this.db.findMany<any>(TABLE, {
      folder_ids: { $in: [folderId] },
      type,
      is_knowledge_base: true,
    });
    return rows.map((r) => this.toJSON(r));
  }

  /**
   * Minimal create/update/delete kept here so Step 2 can wire the write
   * endpoints without re-shaping the repository.
   */
  async create(data: CreateCRMBoardDTO): Promise<CRMBoard> {
    const record: any = {
      id: data.id || crypto.randomUUID(),
      board_id: data.board_id,
      type: data.type,
      workflow_id: data.workflow_id ?? "",
      description: data.description ?? null,
      name: data.name,
      organization_id: data.organization_id,
      field_id: data.field_id ?? null,
      trigger_frequency_unit: data.trigger_frequency_unit ?? null,
      trigger_frequency_value: data.trigger_frequency_value ?? null,
      trigger_time: data.trigger_time ?? null,
      trigger_day_of_week: data.trigger_day_of_week ?? null,
      trigger_day_of_month: data.trigger_day_of_month ?? null,
      triger_month_and_day: data.triger_month_and_day ?? null,
      start_date: data.start_date ?? null,
      start_time: data.start_time ?? null,
      start_datetime: data.start_datetime ?? null,
      is_paused: data.is_paused ?? false,
      is_knowledge_base: data.is_knowledge_base ?? false,
      folder_ids: data.folder_ids ?? null,
    };
    const [inserted] = await this.db.insert<any>(TABLE, record);
    return this.toJSON(inserted || record);
  }

  async update(id: string, data: UpdateCRMBoardDTO): Promise<CRMBoard> {
    const [updated] = await this.db.update<any>(
      TABLE,
      { $or: [{ id }, { _id: id }] },
      data as any,
    );
    if (!updated) throw new NotFoundError(`CRMBoard ${id} not found`);
    return this.toJSON(updated);
  }

  async delete(id: string): Promise<void> {
    const count = await this.db.delete(TABLE, { $or: [{ id }, { _id: id }] });
    if (count === 0) throw new NotFoundError(`CRMBoard ${id} not found`);
  }

  async deleteByBoardId(boardId: string): Promise<number> {
    return this.db.delete(TABLE, { board_id: boardId });
  }
}
