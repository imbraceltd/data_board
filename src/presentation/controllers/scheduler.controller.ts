/**
 * Scheduler Controller — exposes /v1/schedulers endpoints, mirroring
 * the IPS /v1/schedulers + /v2/schedulers surface so callers can switch
 * target service with no path/payload changes.
 *
 * Auth is delegated to the gateway which injects x-organization-id /
 * x-user-id headers. File operations (upload/download) delegate to
 * fs-service via config.fsServiceUrl.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { DatabaseClient } from "../../infrastructure/database/types";
import { SchedulerRepository } from "../../infrastructure/database/repositories/scheduler.repository";
import { SchedulerService } from "../../core/services/scheduler.service";
import { getDatabase } from "../../infrastructure/database/factory";
import {
  validateSchedulerSettings,
  isErrorShape,
} from "../../core/validation/scheduler-validator";
import { SchedulerType } from "../../domain/shared/scheduler.types";
import logger from "../../infrastructure/logging/logger";
import config from "../../config";

interface SchedulerContext {
  Variables: {
    db: DatabaseClient;
    userId?: string;
    organizationId?: string;
  };
}

export const schedulerController = new Hono<SchedulerContext>();

// ── helpers ──────────────────────────────────────────────────────────────────

function getRepo(c: Context<SchedulerContext>) {
  return new SchedulerRepository(c.get("db") ?? getDatabase());
}

function getService(c: Context<SchedulerContext>) {
  return new SchedulerService(c.get("db") ?? getDatabase());
}

function getOrg(c: Context<SchedulerContext>): string | null {
  return c.get("organizationId") ?? c.req.header("x-organization-id") ?? null;
}

function getUser(c: Context<SchedulerContext>): string | null {
  return c.get("userId") ?? c.req.header("x-user-id") ?? null;
}

function requireOrg(c: Context<SchedulerContext>): string | Response {
  const org = getOrg(c);
  if (!org) return c.json({ message: "x-organization-id is required.", code: 401 }, 401) as any;
  return org;
}

// Validate body; for recurring types also validates trigger settings.
function validateBody(body: any, org: string, user: string | null): { hasError: boolean; payload: any } {
  const type = body.type ?? SchedulerType.NON_RECURRING;
  const organization_id = body.organization_id ?? org;
  const user_id = body.user_id ?? user ?? null;

  if (!organization_id) {
    return { hasError: true, payload: { message: "x-organization-id is required.", code: 401 } };
  }

  let yearFrequency = 1;
  if (type !== SchedulerType.NON_RECURRING) {
    const validated = validateSchedulerSettings(body);
    if (isErrorShape(validated)) {
      return { hasError: true, payload: { ...validated } };
    }
    yearFrequency = (validated as any).year_frequency ?? 1;
  }

  return {
    hasError: false,
    payload: { ...body, organization_id, user_id, type, year_frequency: yearFrequency },
  };
}

// ── GET /schedulers ───────────────────────────────────────────────────────────

schedulerController.get("/schedulers", async (c) => {
  try {
    const org = requireOrg(c);
    if (typeof org !== "string") return org;

    const { skip, limit, sort, order, exact, ...filters } = c.req.query() as Record<string, string>;

    const query: Record<string, any> = {
      organization_id: { type: "is", value: org },
    };

    for (const [key, raw] of Object.entries(filters)) {
      if (typeof raw === "string" && raw.includes(":")) {
        const colonIdx = raw.indexOf(":");
        const filterType = raw.substring(0, colonIdx);
        const value = raw.substring(colonIdx + 1);
        if (filterType === "is between") {
          const [start, end] = value.split(",");
          query[key] = { type: filterType, value: start, value2: end };
        } else {
          query[key] = { type: filterType, value };
        }
      } else {
        query[key] = raw;
      }
    }

    const matchStage = buildMatchStage(query, exact === "true");
    const result = await getRepo(c).findWithFilters(matchStage, {
      skip: parseInt(skip ?? "0") || 0,
      limit: parseInt(limit ?? "10") || 10,
      sort: sort ?? null,
      order: (order === "desc" ? "desc" : "asc") as "asc" | "desc",
    });

    return c.json(result);
  } catch (err) {
    logger.error("Scheduler.getAll error:", err);
    const msg = (err as Error).message ?? String(err);
    if (msg.includes("Invalid filter type")) return c.json({ message: msg }, 400);
    return c.json({ message: msg }, 500);
  }
});

// ── GET /schedulers/filter_options ───────────────────────────────────────────

schedulerController.get("/schedulers/filter_options", async (c) => {
  try {
    const org = requireOrg(c);
    if (typeof org !== "string") return org;

    const filter = c.req.query("filter");
    if (!filter || !["event_type", "channel_source", "sender"].includes(filter)) {
      return c.json({ message: "filter must be one of: event_type, channel_source, sender" }, 400);
    }

    const rows = await getRepo(c).findByOrgId(org);
    const result: any[] = [];

    if (filter === "event_type") {
      const seen = new Set<string>();
      for (const s of rows) {
        if (s.event_type && !seen.has(s.event_type)) {
          seen.add(s.event_type);
          result.push({ event_type: s.event_type });
        }
      }
    } else if (filter === "channel_source") {
      const seen = new Set<string>();
      for (const s of rows) {
        const dataArr: any[] = Array.isArray(s.job?.data) ? s.job.data : s.job?.data ? [s.job.data] : [];
        for (const d of dataArr) {
          const ch = d?.channel;
          const chId = String(ch?.id ?? ch?._id ?? "");
          if (chId && !seen.has(chId)) {
            seen.add(chId);
            result.push({ channel_source: { id: chId, name: ch?.name } });
          }
        }
      }
    } else {
      // sender
      const seen = new Set<string>();
      for (const s of rows) {
        const dataArr: any[] = Array.isArray(s.job?.data) ? s.job.data : s.job?.data ? [s.job.data] : [];
        for (const d of dataArr) {
          const sender = d?.sender;
          const senderId = String(sender?.id ?? "");
          if (senderId && !seen.has(senderId)) {
            seen.add(senderId);
            result.push({ sender });
          }
        }
      }
    }

    return c.json(result);
  } catch (err) {
    logger.error("Scheduler.getFilterOptions error:", err);
    return c.json({ message: "Error fetching scheduler filter options" }, 500);
  }
});

// ── GET /schedulers/organization/schedulers ───────────────────────────────────

schedulerController.get("/schedulers/organization/schedulers", async (c) => {
  try {
    const org = requireOrg(c);
    if (typeof org !== "string") return org;
    const rows = await getRepo(c).findByOrgId(org);
    return c.json(rows);
  } catch (err) {
    logger.error("Scheduler.getByOrg error:", err);
    return c.json({ message: (err as Error).message }, 500);
  }
});

// ── GET /schedulers/org/:organization_id ─────────────────────────────────────

schedulerController.get("/schedulers/org/:organization_id", async (c) => {
  try {
    const rows = await getRepo(c).findByOrgId(c.req.param("organization_id"));
    return c.json(rows);
  } catch (err) {
    logger.error("Scheduler.getByOrgId error:", err);
    return c.json({ message: (err as Error).message }, 500);
  }
});

// ── GET /schedulers/:id ───────────────────────────────────────────────────────

schedulerController.get("/schedulers/:id", async (c) => {
  try {
    const org = requireOrg(c);
    if (typeof org !== "string") return org;

    const scheduleId = c.req.param("id");
    if (!scheduleId) return c.json({ message: "schedule_id is required." }, 400);

    const scheduler = await getService(c).getByIdAndOrgId(scheduleId, org);
    if (!scheduler) {
      return c.json(
        { message: `schedule_id ${scheduleId} is invalid or does not exist in the ${org} organization` },
        404,
      );
    }
    return c.json(scheduler);
  } catch (err) {
    logger.error("Scheduler.getById error:", err);
    return c.json({ message: (err as Error).message }, 500);
  }
});

// ── POST /schedulers ──────────────────────────────────────────────────────────

schedulerController.post("/schedulers", async (c) => {
  try {
    const org = requireOrg(c);
    if (typeof org !== "string") return org;

    const body = await c.req.json();
    const { hasError, payload } = validateBody(body, org, getUser(c));
    if (hasError) return c.json(payload, (payload.code as any) ?? 400);

    const svc = getService(c);
    let data;
    if (payload.type === SchedulerType.NON_RECURRING) {
      data = await svc.createNonRecurringSchedule(toCreateDTO(payload));
    } else {
      data = await svc.createRecurringSchedule(toCreateDTO(payload), payload.year_frequency);
    }
    return c.json(data);
  } catch (err) {
    logger.error("Scheduler.create error:", err);
    return c.json({ message: (err as Error).message }, 500);
  }
});

// ── PUT /schedulers/:id ───────────────────────────────────────────────────────

schedulerController.put("/schedulers/:id", async (c) => {
  try {
    const org = requireOrg(c);
    if (typeof org !== "string") return org;

    const scheduleId = c.req.param("id");
    const body = await c.req.json();
    const { hasError, payload } = validateBody(body, org, getUser(c));
    if (hasError) return c.json(payload, (payload.code as any) ?? 400);

    const svc = getService(c);
    const existing = await svc.getByIdAndOrgId(scheduleId, payload.organization_id);
    if (!existing) {
      return c.json(
        { message: `schedule_id ${scheduleId} doesn't exist in the ${payload.organization_id} organization` },
        400,
      );
    }

    const dto = {
      ...toCreateDTO(payload),
      internal_id: existing.internal_id,
      created_by: existing.created_by,
      is_paused: payload.is_paused ?? existing.is_paused,
    };
    let data;
    if (payload.type === SchedulerType.NON_RECURRING) {
      data = await svc.updateNonRecurringSchedule(scheduleId, dto as any);
    } else {
      data = await svc.updateRecurringSchedule(scheduleId, dto as any, payload.year_frequency);
    }
    return c.json(data);
  } catch (err) {
    logger.error("Scheduler.update error:", err);
    return c.json({ message: (err as Error).message }, 500);
  }
});

// ── DELETE /schedulers/apps/:id ───────────────────────────────────────────────

schedulerController.delete("/schedulers/apps/:id", async (c) => {
  try {
    const org = requireOrg(c);
    if (typeof org !== "string") return org;

    const appId = c.req.param("id");
    const deleted = await getRepo(c).deleteByAppId(appId);
    if (!deleted) {
      return c.json({ message: `Scheduler with appId ${appId} does not exist` }, 404);
    }
    return c.json({ message: `Scheduler with appId ${appId} has been deleted successfully` });
  } catch (err) {
    logger.error("Scheduler.deleteByAppId error:", err);
    return c.json({ message: (err as Error).message }, 500);
  }
});

// ── DELETE /schedulers/:id ────────────────────────────────────────────────────

schedulerController.delete("/schedulers/:id", async (c) => {
  try {
    const org = requireOrg(c);
    if (typeof org !== "string") return org;

    const scheduleId = c.req.param("id");
    if (!scheduleId) return c.json({ message: "schedule_id is required." }, 400);

    const svc = getService(c);
    const scheduler = await svc.getByIdAndOrgId(scheduleId, org);
    if (!scheduler) {
      return c.json(
        { message: `schedule_id ${scheduleId} is invalid or does not exist in the ${org} organization` },
        404,
      );
    }

    await getRepo(c).delete(scheduleId);
    svc.cancelJob(scheduleId);

    return c.json({ message: `schedule ${scheduleId} is deleted successfully` });
  } catch (err) {
    logger.error("Scheduler.delete error:", err);
    return c.json({ message: (err as Error).message }, 500);
  }
});

// ── POST /schedulers/files ────────────────────────────────────────────────────

schedulerController.post("/schedulers/files", async (c) => {
  try {
    const org = requireOrg(c);
    if (typeof org !== "string") return org;

    const form = await c.req.formData();
    const payloadRaw = form.get("payload");
    if (!payloadRaw || typeof payloadRaw !== "string") {
      return c.json({ message: "payload field is required" }, 400);
    }

    const body = JSON.parse(payloadRaw);
    const { hasError, payload } = validateBody(body, org, getUser(c));
    if (hasError) return c.json(payload, (payload.code as any) ?? 400);

    const files = form.getAll("files");
    if (files.length > 0) {
      payload.job = payload.job ?? {};
      payload.job.files = await uploadFilesToFs(files, payload.organization_id);
    }

    const svc = getService(c);
    let data;
    if (payload.type === SchedulerType.NON_RECURRING) {
      data = await svc.createNonRecurringSchedule(toCreateDTO(payload));
    } else {
      data = await svc.createRecurringSchedule(toCreateDTO(payload), payload.year_frequency);
    }
    return c.json(data);
  } catch (err) {
    logger.error("Scheduler.createWithFiles error:", err);
    return c.json({ message: (err as Error).message }, 500);
  }
});

// ── PUT /schedulers/files/:id ─────────────────────────────────────────────────

schedulerController.put("/schedulers/files/:id", async (c) => {
  try {
    const org = requireOrg(c);
    if (typeof org !== "string") return org;

    const scheduleId = c.req.param("id");
    const form = await c.req.formData();
    const payloadRaw = form.get("payload");
    if (!payloadRaw || typeof payloadRaw !== "string") {
      return c.json({ message: "payload field is required" }, 400);
    }

    const body = JSON.parse(payloadRaw);
    const { hasError, payload } = validateBody(body, org, getUser(c));
    if (hasError) return c.json(payload, (payload.code as any) ?? 400);

    const files = form.getAll("files");
    if (files.length > 0) {
      payload.job = payload.job ?? {};
      payload.job.files = await uploadFilesToFs(files, payload.organization_id);
    }

    const svc = getService(c);
    const existing = await svc.getByIdAndOrgId(scheduleId, payload.organization_id);
    if (!existing) {
      return c.json(
        { message: `schedule_id ${scheduleId} doesn't exist in the ${payload.organization_id} organization` },
        400,
      );
    }

    const dto = {
      ...toCreateDTO(payload),
      internal_id: existing.internal_id,
      created_by: existing.created_by,
      is_paused: payload.is_paused ?? existing.is_paused,
    };
    let data;
    if (payload.type === SchedulerType.NON_RECURRING) {
      data = await svc.updateNonRecurringSchedule(scheduleId, dto as any);
    } else {
      data = await svc.updateRecurringSchedule(scheduleId, dto as any, payload.year_frequency);
    }
    return c.json(data);
  } catch (err) {
    logger.error("Scheduler.updateWithFiles error:", err);
    return c.json({ message: (err as Error).message }, 500);
  }
});

// ── GET /schedulers/:schedule_id/files/:file_id ───────────────────────────────

schedulerController.get("/schedulers/:schedule_id/files/:file_id", async (c) => {
  try {
    const org = requireOrg(c);
    if (typeof org !== "string") return org;

    const { schedule_id, file_id } = c.req.param();
    const scheduler = await getService(c).getByIdAndOrgId(schedule_id, org);
    if (!scheduler) {
      return c.json({ message: `Scheduler with id ${schedule_id} not found in the organization ${org}` }, 404);
    }

    const files: any[] = scheduler.job?.files ?? [];
    const file = files.find((f) => f.file_id === file_id);
    if (!file) {
      return c.json({ message: `File with id ${file_id} not found in scheduler ${schedule_id}` }, 404);
    }

    const res = await fetch(`${config.fsServiceUrl}/download/${encodeURIComponent(file.file_path)}`);
    if (!res.ok) return c.json({ message: "File not found" }, 404);

    const buffer = await res.arrayBuffer();
    return new Response(buffer, {
      headers: {
        "content-disposition": `inline; filename="${file.name}"`,
        "content-type": file.file_type ?? "application/octet-stream",
      },
    });
  } catch (err) {
    logger.error("Scheduler.downloadFile error:", err);
    return c.json({ message: "Error downloading file from scheduler" }, 500);
  }
});

// ── DELETE /schedulers/:schedule_id/files/:file_id ────────────────────────────

schedulerController.delete("/schedulers/:schedule_id/files/:file_id", async (c) => {
  try {
    const org = requireOrg(c);
    if (typeof org !== "string") return org;

    const { schedule_id, file_id } = c.req.param();
    const repo = getRepo(c);
    const svc = getService(c);
    const scheduler = await svc.getByIdAndOrgId(schedule_id, org);
    if (!scheduler) {
      return c.json({ message: `Scheduler with id ${schedule_id} not found` }, 404);
    }

    const files: any[] = scheduler.job?.files ?? [];
    const idx = files.findIndex((f) => f.file_id === file_id);
    if (idx === -1) {
      return c.json({ message: `File with id ${file_id} not found in scheduler ${schedule_id}` }, 404);
    }

    const [removed] = files.splice(idx, 1);

    if (removed.file_path) {
      await fetch(`${config.fsServiceUrl}/${encodeURIComponent(removed.file_path)}`, { method: "DELETE" }).catch(
        (e) => logger.warn("fs-service file delete failed:", e),
      );
    }

    await repo.update(schedule_id, { job: { ...scheduler.job, files } });
    return c.json({ message: `file with file_id ${file_id} is deleted successfully` });
  } catch (err) {
    logger.error("Scheduler.deleteFile error:", err);
    return c.json({ message: "Error removing file from scheduler" }, 500);
  }
});

// ── Internal helpers ──────────────────────────────────────────────────────────

function toCreateDTO(payload: any) {
  return {
    type: payload.type,
    event_type: payload.event_type,
    job: payload.job,
    name: payload.name,
    description: payload.description,
    channel_source: payload.channel_source,
    organization_id: payload.organization_id,
    created_by: payload.user_id,
    updated_by: payload.user_id,
    options: payload.options,
    one_time_schedule_type: payload.one_time_schedule_type,
    start_date: payload.start_date ?? payload.start_datetime,
    start_time: payload.start_time ?? payload.start_datetime,
    one_time_schedule_frequency_unit: payload.one_time_schedule_frequency_unit,
    one_time_schedule_frequency_value: payload.one_time_schedule_frequency_value,
    one_time_schedule_frequency_time: payload.one_time_schedule_frequency_time,
    trigger_frequency_unit: payload.trigger_frequency_unit,
    trigger_frequency_value: payload.trigger_frequency_value,
    trigger_time: payload.trigger_time,
    trigger_day_of_week: payload.trigger_day_of_week,
    trigger_day_of_month: payload.trigger_day_of_month,
    triger_month_and_day: payload.triger_month_and_day,
    is_paused: payload.is_paused ?? false,
  };
}

async function uploadFilesToFs(files: FormDataEntryValue[], organizationId: string): Promise<any[]> {
  const { randomUUID } = await import("crypto");
  const results: any[] = [];

  for (const entry of files) {
    if (!(entry instanceof File)) continue;
    const form = new FormData();
    form.append("file", entry);
    const res = await fetch(`${config.fsServiceUrl}/upload`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`Failed to upload file ${entry.name} to fs-service`);
    const json = await res.json() as any;
    const key = json.data?.key ?? json.data?.Key ?? json.data?.name;
    results.push({
      organization_id: organizationId,
      name: entry.name,
      file_path: key,
      file_id: randomUUID(),
      size: entry.size,
      file_type: entry.type,
      file_extension: entry.type.split("/")[1],
      file_url: `${config.fsServiceUrl}/download/${encodeURIComponent(key)}`,
      is_public: true,
    });
  }

  return results;
}

function buildMatchStage(query: Record<string, any>, exact: boolean): Record<string, any> {
  const stage: Record<string, any> = {};
  for (const [key, raw] of Object.entries(query)) {
    if (typeof raw === "object" && raw !== null && raw.type !== undefined) {
      const { type, value, value2 } = raw;
      const realValue = value === "true" ? true : value === "false" ? false : value;
      switch (type) {
        case "contains":
          stage[key] = value.includes(",")
            ? { $or: value.split(",").map((v: string) => ({ $regex: v.trim(), $options: "i" })) }
            : { $regex: value, $options: "i" };
          break;
        case "is": stage[key] = realValue; break;
        case "is not": stage[key] = { $ne: realValue }; break;
        case "is empty": stage[key] = { $eq: "" }; break;
        case "is not empty": stage[key] = { $ne: "" }; break;
        case "is before": stage[key] = { $lt: new Date(value).toISOString() }; break;
        case "is after": stage[key] = { $gt: new Date(value).toISOString() }; break;
        case "is before on": stage[key] = { $lte: new Date(value).toISOString() }; break;
        case "is after on": stage[key] = { $gte: new Date(value).toISOString() }; break;
        case "is between":
          stage[key] = { $gte: new Date(value).toISOString(), $lte: new Date(value2).toISOString() };
          break;
        default:
          throw new Error(`Invalid filter type: ${type}`);
      }
    } else {
      stage[key] = exact ? raw : { $regex: raw, $options: "i" };
    }
  }
  return stage;
}
