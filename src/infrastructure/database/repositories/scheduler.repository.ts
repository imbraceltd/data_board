/**
 * SchedulerRepository — minimal surface needed by SchedulerService +
 * recover-on-boot. Reads/writes the `schedulers` table through the
 * DatabaseClient abstraction so the Mongo adapter still works in
 * legacy deployments.
 */

import type { DatabaseClient } from "../types";
import type { Scheduler, CreateSchedulerDTO } from "../../../domain/shared/scheduler.types";
import { DatabaseError, NotFoundError } from "../../../domain/shared/errors";
import logger from "../../logging/logger";
import * as crypto from "crypto";
import {
  sql,
  and,
  eq,
  ne,
  lt,
  gt,
  lte,
  gte,
  like,
  ilike,
  count,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/drizzle/schema";

export interface SchedulerFilterOptions {
  skip?: number;
  limit?: number;
  sort?: string | null;
  order?: "asc" | "desc";
}

export interface SchedulerFilterResult {
  data: Scheduler[];
  count: number;
  total: number;
  has_more: boolean;
}

const TABLE = "schedulers";

export class SchedulerRepository {
  constructor(private readonly db: DatabaseClient) {}

  private getDrizzle(): NodePgDatabase<typeof schema> | null {
    const raw = this.db.getRawClient?.();
    if (raw && typeof (raw as any).select === "function") {
      return raw as NodePgDatabase<typeof schema>;
    }
    return null;
  }

  private toJSON(row: any): Scheduler {
    return {
      _id: row.id || row._id,
      id: row.id || row._id,
      type: row.type,
      name: row.name,
      event_type: row.event_type,
      description: row.description ?? null,
      options: row.options ?? null,
      job: row.job ?? {},
      organization_id: row.organization_id,
      internal_id: row.internal_id ?? null,
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
      is_finished: row.is_finished ?? false,
      channel_source: row.channel_source ?? null,
      one_time_schedule_type: row.one_time_schedule_type ?? null,
      one_time_schedule_frequency_unit:
        row.one_time_schedule_frequency_unit ?? null,
      one_time_schedule_frequency_value:
        row.one_time_schedule_frequency_value ?? null,
      one_time_schedule_frequency_time:
        row.one_time_schedule_frequency_time ?? null,
      created_by: row.created_by ?? null,
      updated_by: row.updated_by ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
    };
  }

  async findById(id: string): Promise<Scheduler | null> {
    try {
      const row = await this.db.findFirst<any>(TABLE, {
        $or: [{ id }, { _id: id }],
      });
      return row ? this.toJSON(row) : null;
    } catch (err) {
      logger.error(`SchedulerRepository.findById(${id}) error:`, err);
      throw new DatabaseError(`Failed to find scheduler: ${(err as Error).message}`);
    }
  }

  async findByInternalIdAndOrgId(
    internalId: string,
    organizationId: string,
  ): Promise<Scheduler | null> {
    const row = await this.db.findFirst<any>(TABLE, {
      internal_id: internalId,
      organization_id: organizationId,
    });
    return row ? this.toJSON(row) : null;
  }

  async findActive(): Promise<Scheduler[]> {
    const rows = await this.db.findMany<any>(TABLE, { is_paused: false });
    return rows.map((r) => this.toJSON(r));
  }

  async create(data: CreateSchedulerDTO): Promise<Scheduler> {
    const record: any = {
      id: (data as any).id || crypto.randomUUID(),
      type: data.type,
      name: data.name,
      event_type: data.event_type,
      description: data.description ?? null,
      options: data.options ?? null,
      job: data.job,
      organization_id: data.organization_id,
      internal_id: data.internal_id ?? null,
      trigger_frequency_unit: data.trigger_frequency_unit ?? null,
      trigger_frequency_value: data.trigger_frequency_value ?? null,
      trigger_time: data.trigger_time ?? null,
      trigger_day_of_week: data.trigger_day_of_week ?? null,
      trigger_day_of_month: data.trigger_day_of_month ?? null,
      triger_month_and_day: data.triger_month_and_day ?? null,
      start_date: data.start_date ?? null,
      start_time: data.start_time ?? null,
      start_datetime: data.start_datetime ?? data.start_date ?? null,
      is_paused: data.is_paused ?? false,
      is_finished: data.is_finished ?? false,
      channel_source: data.channel_source ?? null,
      one_time_schedule_type: data.one_time_schedule_type ?? null,
      one_time_schedule_frequency_unit:
        data.one_time_schedule_frequency_unit ?? null,
      one_time_schedule_frequency_value:
        data.one_time_schedule_frequency_value ?? null,
      one_time_schedule_frequency_time:
        data.one_time_schedule_frequency_time ?? null,
      created_by: data.created_by ?? null,
      updated_by: data.updated_by ?? null,
    };
    const [inserted] = await this.db.insert<any>(TABLE, record);
    return this.toJSON(inserted || record);
  }

  async update(id: string, data: Partial<Scheduler>): Promise<Scheduler> {
    const [updated] = await this.db.update<any>(
      TABLE,
      { $or: [{ id }, { _id: id }] },
      data as any,
    );
    if (!updated) throw new NotFoundError(`Scheduler ${id} not found`);
    return this.toJSON(updated);
  }

  async markFinished(id: string): Promise<void> {
    await this.db.update<any>(
      TABLE,
      { $or: [{ id }, { _id: id }], type: "non_recurring" },
      { is_paused: true, is_finished: true } as any,
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(TABLE, { $or: [{ id }, { _id: id }] });
  }

  async findByOrgId(organizationId: string): Promise<Scheduler[]> {
    const rows = await this.db.findMany<any>(TABLE, { organization_id: organizationId });
    return rows.map((r) => this.toJSON(r));
  }

  async deleteByAppId(appId: string): Promise<boolean> {
    const drz = this.getDrizzle();
    if (drz) {
      await drz
        .delete(schema.schedulers)
        .where(sql`${schema.schedulers.job}->>'app_id' = ${appId}`);
      return true;
    }
    // Mongo fallback — job is an embedded object
    const rows = await this.db.findMany<any>(TABLE, { "job.app_id": appId });
    if (rows.length === 0) return false;
    for (const row of rows) {
      await this.db.delete(TABLE, { $or: [{ id: row.id }, { _id: row._id }] });
    }
    return true;
  }

  async findWithFilters(
    matchStage: Record<string, any>,
    options: SchedulerFilterOptions = {},
  ): Promise<SchedulerFilterResult> {
    const { skip = 0, limit = 10, sort = null, order = "asc" } = options;
    const drz = this.getDrizzle();

    if (drz) {
      const conditions = this._buildDrizzleConditions(matchStage);
      let query = drz.select().from(schema.schedulers) as any;
      if (conditions.length > 0) query = query.where(and(...conditions));
      if (sort && (schema.schedulers as any)[sort]) {
        const field = (schema.schedulers as any)[sort];
        query = query.orderBy(order === "desc" ? sql`${field} DESC` : sql`${field} ASC`);
      }
      query = query.offset(skip).limit(limit);
      const rows = await query;

      let countQ = drz.select({ count: count() }).from(schema.schedulers) as any;
      if (conditions.length > 0) countQ = countQ.where(and(...conditions));
      const countResult = await countQ;
      const total = Number(countResult[0]?.count ?? 0);

      const data = rows.map((r: any) => this.toJSON(r));
      return { data, count: data.length, total, has_more: skip + data.length < total };
    }

    // Mongo fallback — best-effort (no aggregation operators, simple equality)
    const mongoWhere: Record<string, any> = {};
    for (const [key, val] of Object.entries(matchStage)) {
      if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        if (val.$regex !== undefined) mongoWhere[key] = { $regex: val.$regex, $options: "i" };
        else if (val.$eq !== undefined) mongoWhere[key] = val.$eq;
        else if (val.$ne !== undefined) mongoWhere[key] = { $ne: val.$ne };
        else mongoWhere[key] = val;
      } else {
        mongoWhere[key] = val;
      }
    }
    const rows = await this.db.findMany<any>(TABLE, mongoWhere);
    const data = rows.map((r: any) => this.toJSON(r));
    const paginated = data.slice(skip, skip + limit);
    return { data: paginated, count: paginated.length, total: data.length, has_more: skip + paginated.length < data.length };
  }

  private _buildDrizzleConditions(matchStage: Record<string, any>) {
    const conditions: any[] = [];
    const t = schema.schedulers as any;

    for (const [key, value] of Object.entries(matchStage)) {
      const field = t[key];
      if (!field) continue;

      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        if (value.$regex !== undefined) conditions.push(ilike(field, `%${value.$regex}%`));
        else if (value.$eq !== undefined) conditions.push(eq(field, value.$eq));
        else if (value.$ne !== undefined) conditions.push(ne(field, value.$ne));
        else if (value.$lt !== undefined) conditions.push(lt(field, value.$lt));
        else if (value.$gt !== undefined) conditions.push(gt(field, value.$gt));
        else if (value.$lte !== undefined) conditions.push(lte(field, value.$lte));
        else if (value.$gte !== undefined && value.$lte !== undefined)
          conditions.push(and(gte(field, value.$gte), lte(field, value.$lte)));
        else if (value.$gte !== undefined) conditions.push(gte(field, value.$gte));
      } else {
        conditions.push(eq(field, value));
      }
    }
    return conditions;
  }
}
