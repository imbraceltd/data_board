/**
 * CRMBoardService — write surface for CRMBoard automations.
 *
 * Mirrors IPS use-cases (CreateCRMBoardUseCase, UpdateCRMBoardUseCase,
 * DeleteCRMBoardUseCase + update-by-field / update-by-workflow /
 * delete-by-board) so the frontend can flip endpoint targets without
 * payload changes.
 *
 * For `type=scheduled` boards we additionally provision (or update,
 * or remove) a row in the `schedulers` table and arm node-schedule via
 * SchedulerService. Non-scheduled writes are just direct repo writes
 * with duplicate-check logic.
 */

import type { DatabaseClient } from "../../infrastructure/database/types";
import { CRMBoardRepository } from "../../infrastructure/database/repositories/crmboard.repository";
import { SchedulerService } from "./scheduler.service";
import type {
  CRMBoard,
  CreateCRMBoardDTO,
  UpdateCRMBoardDTO,
} from "../../domain/shared/crmboard.types";
import {
  validateSchedulerSettings,
  isErrorShape,
} from "../validation/scheduler-validator";
import { TRIGGER_TYPES } from "../utils/date-utils";
import {
  EventType,
  JobTriggerType,
  SchedulerType,
  type SchedulerJob,
} from "../../domain/shared/scheduler.types";
import { ValidationError, NotFoundError } from "../../domain/shared/errors";
import logger from "../../infrastructure/logging/logger";

const ROUTER_OUTGOING_CRM_EVENT = "ROUTER.OUTGOING_CRM_EVENT";

export class CRMBoardService {
  private repo: CRMBoardRepository;
  private schedulerService: SchedulerService;
  constructor(private db: DatabaseClient) {
    this.repo = new CRMBoardRepository(db);
    this.schedulerService = new SchedulerService(db);
  }

  /**
   * Create or upsert-style write. For `type=scheduled` validates the
   * trigger settings, persists the CRMBoard then provisions a recurring
   * scheduler. For other types runs duplicate-check matching IPS
   * (board_id+type, with field_id added for update).
   */
  async create(data: CreateCRMBoardDTO): Promise<CRMBoard> {
    const { type, organization_id } = data;
    if (!organization_id) {
      throw new ValidationError("Missing required fields: organization_id");
    }

    if (type === TRIGGER_TYPES.SCHEDULED) {
      const validation = validateSchedulerSettings(data);
      if (isErrorShape(validation)) {
        throw new ValidationError(validation.message);
      }

      const boardData: CreateCRMBoardDTO = {
        ...data,
        start_date: validation.start_date,
        start_time: validation.start_time,
        trigger_frequency_unit: validation.trigger_frequency_unit,
        trigger_frequency_value: validation.trigger_frequency_value,
        trigger_time: validation.trigger_time,
        trigger_day_of_week: validation.trigger_day_of_week,
        trigger_day_of_month: validation.trigger_day_of_month,
        triger_month_and_day: validation.triger_month_and_day,
        is_paused: false,
      };
      const created = await this.repo.create(boardData);

      const job: SchedulerJob = {
        type: JobTriggerType.KAFKA,
        topic: ROUTER_OUTGOING_CRM_EVENT,
        data: { board_id: data.board_id, id: created.id },
        workflow_id: data.workflow_id,
      };
      await this.schedulerService.createRecurringSchedule(
        {
          type: SchedulerType.RECURRING,
          event_type: EventType.BOARD_AUTOMATION,
          job,
          name: data.name,
          description: data.description ?? "",
          organization_id,
          options: null,
          start_date: validation.start_date,
          start_time: validation.start_time,
          is_paused: false,
          trigger_frequency_unit: validation.trigger_frequency_unit,
          trigger_frequency_value: validation.trigger_frequency_value,
          trigger_time: validation.trigger_time,
          trigger_day_of_week: validation.trigger_day_of_week,
          trigger_day_of_month: validation.trigger_day_of_month,
          triger_month_and_day: validation.triger_month_and_day,
          channel_source: "",
        },
        validation.year_frequency,
        { id: created.id },
      );
      return created;
    }

    // Non-scheduled: duplicate check, then insert.
    const requiredFields = ["board_id", "type", "workflow_id", "name", "organization_id"];
    if (data.type === "update" && !data.is_knowledge_base) {
      requiredFields.push("field_id");
    }
    const missing = requiredFields.filter((k) => !(data as any)[k]);
    if (missing.length > 0) {
      throw new ValidationError(`Missing required fields: ${missing.join(", ")}`);
    }

    if (data.type === "update") {
      const existing = await this.repo.findByBoardIdTypeAndFieldId(
        data.board_id,
        data.type,
        data.field_id ?? "",
      );
      if (existing.length > 0) {
        throw new ValidationError("crmboard condition trigger existed.");
      }
    } else {
      const existing = await this.repo.findByBoardIdAndType(
        data.board_id,
        data.type,
      );
      const active = existing.find((b) => !b.is_paused);
      if (active) {
        throw new ValidationError("crmboard condition trigger existed.");
      }
    }
    return this.repo.create(data);
  }

  /**
   * Update an existing CRMBoard by id. Handles three scheduler
   * transitions: stay-scheduled (update scheduler row), normal→scheduled
   * (create scheduler), scheduled→normal (delete scheduler).
   */
  async update(id: string, data: UpdateCRMBoardDTO): Promise<CRMBoard> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundError(`CRMBoard ${id} not found`);

    const type = (data.type ?? existing.type) as string;
    const organization_id = data.organization_id || existing.organization_id;

    if (type === TRIGGER_TYPES.SCHEDULED) {
      const validation = validateSchedulerSettings(data);
      if (isErrorShape(validation)) {
        throw new ValidationError(validation.message);
      }

      const job: SchedulerJob = {
        type: JobTriggerType.KAFKA,
        topic: ROUTER_OUTGOING_CRM_EVENT,
        data: {
          board_id: data.board_id || existing.board_id,
          id: existing.id,
        },
        workflow_id: data.workflow_id || existing.workflow_id,
      };
      const inputs = {
        type: SchedulerType.RECURRING,
        event_type: EventType.BOARD_AUTOMATION,
        job,
        name: data.name || existing.name,
        description: data.description ?? existing.description ?? "",
        organization_id,
        start_date: validation.start_date,
        start_time: validation.start_time,
        is_paused: false,
        trigger_frequency_unit: validation.trigger_frequency_unit,
        trigger_frequency_value: validation.trigger_frequency_value,
        trigger_time: validation.trigger_time,
        trigger_day_of_week: validation.trigger_day_of_week,
        trigger_day_of_month: validation.trigger_day_of_month,
        triger_month_and_day: validation.triger_month_and_day,
      };

      if (existing.type === TRIGGER_TYPES.SCHEDULED) {
        const sched = await this.schedulerService.getByInternalIdAndOrgId(
          id,
          organization_id,
        );
        if (sched) {
          await this.schedulerService.updateRecurringSchedule(
            sched.id,
            inputs as any,
            validation.year_frequency,
          );
        } else {
          await this.schedulerService.createRecurringSchedule(
            inputs as any,
            validation.year_frequency,
            { id: existing.id },
          );
        }
      } else {
        await this.schedulerService.createRecurringSchedule(
          inputs as any,
          validation.year_frequency,
          { id: existing.id },
        );
      }
    } else if (existing.type === TRIGGER_TYPES.SCHEDULED) {
      // Scheduled → normal: delete scheduler row but keep CRMBoard.
      const sched = await this.schedulerService.getByInternalIdAndOrgId(
        id,
        organization_id,
      );
      if (sched) {
        await this.schedulerService.deleteSchedule(sched.id);
      }
    }

    return this.repo.update(id, data);
  }

  /**
   * Delete by primary key. If the board is `type=scheduled`, also tear
   * down the bound scheduler row so the cron stops firing.
   */
  async delete(id: string): Promise<boolean> {
    const existing = await this.repo.findById(id);
    if (!existing) return false;

    if (existing.type === TRIGGER_TYPES.SCHEDULED) {
      const sched = await this.schedulerService.getByInternalIdAndOrgId(
        id,
        existing.organization_id,
      );
      if (sched) await this.schedulerService.deleteSchedule(sched.id);
    }
    await this.repo.delete(id);
    return true;
  }

  async deleteByBoardId(boardId: string): Promise<number> {
    // For type=scheduled rows we also need to tear down each scheduler.
    const rows = await this.repo.findByBoardId(boardId);
    for (const r of rows) {
      if (r.type === TRIGGER_TYPES.SCHEDULED) {
        const sched = await this.schedulerService.getByInternalIdAndOrgId(
          r.id,
          r.organization_id,
        );
        if (sched) {
          try {
            await this.schedulerService.deleteSchedule(sched.id);
          } catch (err) {
            logger.error(
              `deleteByBoardId: scheduler teardown failed for crmboard=${r.id}: ${(err as Error).message}`,
            );
          }
        }
      }
    }
    return this.repo.deleteByBoardId(boardId);
  }

  /**
   * Used when a board field is deleted: pause + detach every automation
   * that referenced it. Matches IPS legacy semantics.
   */
  async clearFieldId(fieldId: string): Promise<number> {
    const rows = await this.repo.findByFieldId(fieldId);
    let count = 0;
    for (const r of rows) {
      await this.repo.update(r.id, { field_id: "", is_paused: true });
      count++;
    }
    return count;
  }

  /**
   * Used when a workflow is deleted: pause + detach every automation
   * that referenced it.
   */
  async clearWorkflowId(workflowId: string): Promise<number> {
    const rows = await this.repo.findByWorkflowId(workflowId);
    let count = 0;
    for (const r of rows) {
      await this.repo.update(r.id, { workflow_id: "", is_paused: true });
      count++;
    }
    return count;
  }
}
