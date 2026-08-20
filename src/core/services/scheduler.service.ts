/**
 * SchedulerService — owns the lifecycle of recurring board-automation
 * jobs and the cron callbacks that publish to Kafka.
 *
 * Ported from IPS `SchedulerService` (infrastructure/services). The
 * runtime engine (cron + node-schedule) is `schedulerEngine`; this
 * service layers persistence + business logic on top:
 *   - create / update / delete recurring schedules
 *   - executeCallback: the cron fire that resolves the bound CRMBoard
 *     row, publishes ROUTER.OUTGOING_CRM_EVENT or AP_OUTGOING_CRM_EVENT
 *     depending on workflow_id shape, and marks one-shot jobs finished.
 *   - recoverActiveJobs: re-register all `is_paused=false` schedulers
 *     into the engine at app boot.
 */

import type { DatabaseClient } from "../../infrastructure/database/types";
import { SchedulerRepository } from "../../infrastructure/database/repositories/scheduler.repository";
import { CRMBoardRepository } from "../../infrastructure/database/repositories/crmboard.repository";
import schedulerEngine from "../../infrastructure/scheduling/scheduler-engine";
import KafkaAutomation from "../../infrastructure/messaging/kafka-automation";
import logger from "../../infrastructure/logging/logger";
import {
  SchedulerType,
  JobTriggerType,
  type Scheduler,
  type SchedulerJob,
  type CreateSchedulerDTO,
} from "../../domain/shared/scheduler.types";
import {
  formatTime,
  formatDate,
  formatMonthAndDay,
  toUTC,
  setCronTimeSeconds,
  setCronTimeMinutes,
  setCronTimeHours,
  setCronTimeDays,
  setCronTimeWeeks,
  setCronTimeMonths,
  setCronTimeYears,
  correctPastDate,
  TRIGGER_FREQUENCY_UNIT,
} from "../utils/date-utils";

const AP_OUTGOING_CRM_EVENT = "AP_OUTGOING_CRM_EVENT";
const ROUTER_OUTGOING_CRM_EVENT = "ROUTER.OUTGOING_CRM_EVENT";

export class SchedulerService {
  private repo: SchedulerRepository;
  private crmRepo: CRMBoardRepository;
  constructor(db: DatabaseClient) {
    this.repo = new SchedulerRepository(db);
    this.crmRepo = new CRMBoardRepository(db);
    this.executeCallback = this.executeCallback.bind(this);
  }

  /**
   * Persist a recurring scheduler row and arm it on the engine.
   * `currentBoardData` links the scheduler to a CRMBoard via
   * `internal_id` so we can find the bound board at fire time.
   */
  async createRecurringSchedule(
    inputs: CreateSchedulerDTO,
    yearFrequency: number = 1,
    currentBoardData?: { id?: string; _id?: string },
  ): Promise<Scheduler> {
    if (inputs.start_date) inputs.start_datetime = inputs.start_date;

    if (currentBoardData) {
      const boardId = (currentBoardData.id || currentBoardData._id)!;
      inputs.internal_id = boardId;
      if (!inputs.job) inputs.job = { type: JobTriggerType.KAFKA };
      if (!inputs.job.data) inputs.job.data = {};
      inputs.job.data.id = boardId;
    }

    const created = await this.repo.create(inputs);
    const schedulerId = created.id;

    // Mutate caller's job object the same way IPS does, so any subsequent
    // logger output sees `scheduler_id` set.
    inputs.job.scheduler_id = schedulerId;

    const trigger = this.setRecurringSettings(
      inputs.trigger_frequency_unit!,
      inputs.trigger_frequency_value!,
      inputs.trigger_time ?? undefined,
      inputs.trigger_day_of_week ?? undefined,
      inputs.trigger_day_of_month ?? undefined,
      inputs.triger_month_and_day ?? undefined,
      inputs.start_date!,
      inputs.start_time!,
    );
    const startDate = this.setNonRecurringSettings(
      inputs.start_date!,
      inputs.start_time!,
    );

    const addRecurringJob = () => {
      schedulerEngine.delete(schedulerId);
      schedulerEngine.add(
        schedulerId,
        trigger.time,
        this.executeCallback,
        { ...inputs.job, scheduler_id: schedulerId },
        true,
        trigger.startDate,
        yearFrequency,
        (id) => this.repo.findById(id),
      );
    };

    await schedulerEngine.addOnce(
      schedulerId,
      startDate,
      addRecurringJob,
      inputs.job,
    );
    return created;
  }

  async updateRecurringSchedule(
    schedulerId: string,
    inputs: Partial<Scheduler> & { job: SchedulerJob },
    yearFrequency: number = 1,
  ): Promise<Scheduler> {
    if (inputs.start_date) inputs.start_datetime = inputs.start_date;
    const updated = await this.repo.update(schedulerId, inputs);
    inputs.job.scheduler_id = schedulerId;
    schedulerEngine.delete(schedulerId);

    if (!inputs.is_paused) {
      const trigger = this.setRecurringSettings(
        inputs.trigger_frequency_unit!,
        inputs.trigger_frequency_value!,
        inputs.trigger_time ?? undefined,
        inputs.trigger_day_of_week ?? undefined,
        inputs.trigger_day_of_month ?? undefined,
        inputs.triger_month_and_day ?? undefined,
        inputs.start_date!,
        inputs.start_time!,
      );
      const startDate = this.setNonRecurringSettings(
        inputs.start_date!,
        inputs.start_time!,
      );
      const addRecurringJob = () => {
        schedulerEngine.delete(schedulerId);
        schedulerEngine.add(
          schedulerId,
          trigger.time,
          this.executeCallback,
          { ...inputs.job, scheduler_id: schedulerId },
          true,
          trigger.startDate,
          yearFrequency,
          (id) => this.repo.findById(id),
        );
      };
      await schedulerEngine.addOnce(
        schedulerId,
        startDate,
        addRecurringJob,
        inputs.job,
      );
    }
    return updated;
  }

  async deleteSchedule(schedulerId: string): Promise<void> {
    schedulerEngine.delete(schedulerId);
    await this.repo.delete(schedulerId);
  }

  async getByInternalIdAndOrgId(
    internalId: string,
    organizationId: string,
  ): Promise<Scheduler | null> {
    return this.repo.findByInternalIdAndOrgId(internalId, organizationId);
  }

  async getByIdAndOrgId(id: string, organizationId: string): Promise<Scheduler | null> {
    const scheduler = await this.repo.findById(id);
    if (!scheduler) return null;
    if (scheduler.organization_id !== organizationId) return null;
    return scheduler;
  }

  async createNonRecurringSchedule(inputs: CreateSchedulerDTO): Promise<Scheduler> {
    if (inputs.start_date) inputs.start_datetime = inputs.start_date;
    const created = await this.repo.create(inputs);
    inputs.job.scheduler_id = created.id;

    if (!inputs.is_paused) {
      const startDate = this.setNonRecurringSettings(inputs.start_date!, inputs.start_time!);
      await schedulerEngine.addOnce(created.id, startDate, this.executeCallback, {
        ...inputs.job,
        scheduler_id: created.id,
      });
    }
    return created;
  }

  async updateNonRecurringSchedule(
    schedulerId: string,
    inputs: Partial<Scheduler> & { job: SchedulerJob },
  ): Promise<Scheduler> {
    if (inputs.start_date) inputs.start_datetime = inputs.start_date;
    const updated = await this.repo.update(schedulerId, inputs);
    inputs.job.scheduler_id = schedulerId;
    schedulerEngine.delete(schedulerId);

    if (!inputs.is_paused) {
      const startDate = this.setNonRecurringSettings(inputs.start_date!, inputs.start_time!);
      await schedulerEngine.addOnce(schedulerId, startDate, this.executeCallback, {
        ...inputs.job,
        scheduler_id: schedulerId,
      });
    }
    return updated;
  }

  cancelJob(schedulerId: string): void {
    schedulerEngine.delete(schedulerId);
  }

  /**
   * Cron fire callback. The `data` parameter is the scheduler `job`
   * snapshot taken at create/update time, optionally augmented with
   * `scheduler_id` once persisted.
   *
   * For Kafka jobs: resolves the bound CRMBoard via job.data.board_id
   * to pick up organization_id (legacy parity), then publishes to AP
   * or ROUTER topic depending on workflow_id format. Non-numeric
   * workflow_id → AP_OUTGOING_CRM_EVENT, numeric → the topic the row
   * was created with.
   */
  async executeCallback(data: any): Promise<void> {
    try {
      const { scheduler_id, type, topic, workflow_id } = data ?? {};
      if (type === JobTriggerType.KAFKA) {
        const msg: any = { ...(data.data || {}), workflow_id };
        if (msg.board_id) {
          const boards = await this.crmRepo.findByBoardId(msg.board_id);
          if (boards && boards.length > 0) {
            const board = boards[0];
            msg.board = {
              organization_id: board.organization_id,
              id: msg.board_id,
            };
            msg.type = "schedule";
          }
        }
        const targetTopic = isNaN(Number(msg.workflow_id))
          ? AP_OUTGOING_CRM_EVENT
          : topic || ROUTER_OUTGOING_CRM_EVENT;
        logger.info(
          `[scheduler:executeCallback] publish topic=${targetTopic} workflow_id=${msg.workflow_id} board_id=${msg.board_id} scheduler_id=${scheduler_id}`,
        );
        await KafkaAutomation.getInstance().publish(targetTopic, msg, 0);
      }
      // Mark non-recurring jobs finished once they've fired.
      if (scheduler_id) {
        await this.repo.markFinished(scheduler_id);
      }
    } catch (err) {
      logger.error(`executeCallback error: ${(err as Error).message}`);
    }
  }

  /**
   * Re-arm every active scheduler at boot. Called from app startup.
   * Mirrors IPS `initExistingcheduledJobs`.
   */
  async recoverActiveJobs(): Promise<void> {
    const rows = await this.repo.findActive();
    logger.info(`scheduler: recovering ${rows.length} active jobs`);
    for (const s of rows) {
      try {
        let startDateInput = s.start_date;
        let startTimeInput = s.start_time;
        if (!s.start_date && !s.start_time && s.start_datetime) {
          startDateInput = s.start_datetime;
          startTimeInput = s.start_datetime;
        }
        if (!startDateInput || !startTimeInput) {
          logger.warn(
            `scheduler: skip recover id=${s.id} (missing start_date/start_time)`,
          );
          continue;
        }
        if (s.type === SchedulerType.NON_RECURRING) {
          const startDate = this.setNonRecurringSettings(
            startDateInput,
            startTimeInput,
          );
          await schedulerEngine.addOnce(
            s.id,
            startDate,
            this.executeCallback,
            s.job,
          );
        } else {
          const trigger = this.setRecurringSettings(
            s.trigger_frequency_unit!,
            s.trigger_frequency_value!,
            s.trigger_time ?? undefined,
            s.trigger_day_of_week ?? undefined,
            s.trigger_day_of_month ?? undefined,
            s.triger_month_and_day ?? undefined,
            startDateInput,
            startTimeInput,
          );
          const yearFreq =
            s.trigger_frequency_unit === TRIGGER_FREQUENCY_UNIT.years
              ? s.trigger_frequency_value || 1
              : 1;
          await schedulerEngine.add(
            s.id,
            trigger.time,
            this.executeCallback,
            s.job,
            false,
            trigger.startDate,
            yearFreq,
            (id) => this.repo.findById(id),
          );
        }
      } catch (err) {
        logger.error(
          `scheduler: recover failed id=${s.id}: ${(err as Error).message}`,
        );
      }
    }
    logger.info(`scheduler: recovered ${schedulerEngine.size()} jobs into engine`);
  }

  // --- helpers (port of IPS setRecurring/setNonRecurring) ---

  private setRecurringSettings(
    unit: string,
    value: number,
    time?: string,
    dayOfWeek?: string,
    dayOfMonth?: string,
    monthAndDay?: string,
    startDate?: string,
    startTime?: string,
  ): { time: string; startDate: Date } {
    let cronTime = "";
    const sTime = formatTime(startTime);
    const sDate = formatDate(startDate);
    const utcStart = toUTC(sDate, sTime);
    if (time) time = formatTime(time);
    if (monthAndDay) monthAndDay = formatMonthAndDay(monthAndDay);

    switch (unit) {
      case TRIGGER_FREQUENCY_UNIT.seconds:
        cronTime = setCronTimeSeconds(value);
        break;
      case TRIGGER_FREQUENCY_UNIT.minutes:
        cronTime = setCronTimeMinutes(value);
        break;
      case TRIGGER_FREQUENCY_UNIT.hours:
        cronTime = setCronTimeHours(value);
        break;
      case TRIGGER_FREQUENCY_UNIT.days:
        cronTime = setCronTimeDays(value, time);
        break;
      case TRIGGER_FREQUENCY_UNIT.weeks:
        cronTime = setCronTimeWeeks(value, time, dayOfWeek);
        break;
      case TRIGGER_FREQUENCY_UNIT.months:
        cronTime = setCronTimeMonths(value, time, dayOfMonth);
        break;
      case TRIGGER_FREQUENCY_UNIT.years:
        cronTime = setCronTimeYears(time, monthAndDay);
        break;
      default:
        throw new Error("Invalid trigger frequency unit");
    }
    return { time: cronTime, startDate: correctPastDate(utcStart, unit, value) };
  }

  private setNonRecurringSettings(startDate: string, startTime: string): Date {
    return toUTC(formatDate(startDate), formatTime(startTime));
  }
}
