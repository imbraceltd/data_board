/**
 * SchedulerEngine — thin wrapper over `cron` (recurring) + `node-schedule`
 * (one-shot) that mirrors the IPS `Scheduler` class exactly. The wrapper
 * itself is intentionally state-only (jobs Map keyed by id) so callers
 * (service layer) own all business logic.
 *
 * Why this exists alongside the service:
 *   - keep the cron timing semantics identical to legacy IPS behavior so
 *     a scheduler row migrated 1:1 produces the same fire schedule.
 *   - centralize Map cleanup + delete semantics so the service doesn't
 *     have to reason about node-schedule vs cron lifecycle.
 */

import { CronJob } from "cron";
import * as schedule from "node-schedule";
import { SchedulerType } from "../../domain/shared/scheduler.types";
import logger from "../logging/logger";
import { runWithJobContext } from "../logging/request-context";

type RecurringEntry = { job: CronJob; type: "recurring" };
type OnceEntry = { job: schedule.Job; type: "non_recurring" };
type Entry = RecurringEntry | OnceEntry;

export class SchedulerEngine {
  private jobs = new Map<string, Entry>();
  constructor(private timezone: string = "UTC") {}

  /**
   * Add a recurring job. If `startDate` is in the future the cron job
   * isn't created until that moment (via setTimeout / setInterval for
   * very long delays — node setTimeout caps at ~24.8 days).
   *
   * `checkJobExist` is a guard run right before the cron job is wired
   * up — used by recovery on boot to skip rows that were deleted while
   * we were scheduling them.
   *
   * `yearFrequency > 1` makes the job a no-op except on years where
   * `currentYear % yearFrequency === 0` — same semantics IPS uses for
   * "every N years" automations.
   */
  async add(
    id: string,
    cronTime: string,
    callback: (data: any) => Promise<void> | void,
    data: any,
    runOnInit = false,
    startDate?: Date | null,
    yearFrequency = 1,
    checkJobExist?: (id: string) => Promise<any> | any,
  ): Promise<void> {
    if (this.jobs.has(id)) {
      logger.info(`scheduler: job already exists ${id}`);
      return;
    }

    let delay = 0;
    if (startDate) {
      delay = startDate.getTime() - Date.now();
      logger.info(
        `scheduler: job=${id} now=${new Date().toISOString()} startDate=${startDate.toISOString()} delay=${delay}ms`,
      );
    }

    const createJob = async () => {
      if (checkJobExist) {
        const exists = await checkJobExist(id);
        if (!exists) {
          logger.info(
            `scheduler: job ${id} cannot be created — checkJobExist returned falsy`,
          );
          return;
        }
      }
      if (this.jobs.has(id)) {
        logger.info(`scheduler: job already exists ${id}`);
        return;
      }
      const job = new CronJob(
        cronTime,
        async () => {
          try {
            const currentYear = new Date().getFullYear();
            if (yearFrequency > 1 && currentYear % yearFrequency !== 0) {
              logger.info(
                `scheduler: year frequency unmet job=${id} currentYear=${currentYear} yearFrequency=${yearFrequency}`,
              );
              return;
            }
            logger.info(
              `scheduler: job ${id} triggered at ${new Date().toISOString()}`,
            );
            await runWithJobContext(`scheduler:${id}`, () => callback(data));
          } catch (err) {
            logger.error(`scheduler: callback error job=${id}: ${(err as Error).message}`);
          }
        },
        null,
        true,
        this.timezone,
        null,
        runOnInit,
      );
      this.jobs.set(id, { job, type: SchedulerType.RECURRING });
    };

    if (delay > 0) {
      // Node's setTimeout caps at ~24.8 days; for longer delays poll
      // daily until the start moment arrives. Mirrors IPS behavior.
      if (delay > 2147483647) {
        const intervalId = setInterval(async () => {
          try {
            if (Date.now() >= (startDate as Date).getTime()) {
              clearInterval(intervalId);
              await createJob();
            }
          } catch (err) {
            logger.error(
              `scheduler: long-delay interval error job=${id}: ${(err as Error).message}`,
            );
          }
        }, 24 * 60 * 60 * 1000);
      } else {
        setTimeout(async () => {
          try {
            logger.info(
              `scheduler: job ${id} start delay reached, registering cron`,
            );
            await createJob();
          } catch (err) {
            logger.error(
              `scheduler: setTimeout error job=${id}: ${(err as Error).message}`,
            );
          }
        }, delay);
      }
    } else {
      await createJob();
    }
  }

  async addOnce(
    id: string,
    startDate: Date,
    callback: (data: any) => Promise<void> | void,
    data: any,
  ): Promise<void> {
    if (this.jobs.has(id)) {
      logger.info(`scheduler: job already exists ${id}`);
      return;
    }
    const job = schedule.scheduleJob(startDate, async () => {
      try {
        logger.info(
          `scheduler: one-shot job ${id} fired at ${new Date().toISOString()} startDate=${startDate.toISOString()}`,
        );
        await runWithJobContext(`scheduler:${id}`, () => callback(data));
      } catch (err) {
        logger.error(
          `scheduler: one-shot error job=${id}: ${(err as Error).message}`,
        );
      }
    });
    if (job) {
      this.jobs.set(id, { job, type: SchedulerType.NON_RECURRING });
    }
  }

  delete(id: string): void {
    const entry = this.jobs.get(id);
    if (!entry) {
      logger.info(`scheduler: delete miss — no job ${id}`);
      return;
    }
    try {
      if (entry.type === SchedulerType.NON_RECURRING) {
        (entry.job as schedule.Job).cancel();
      } else {
        (entry.job as CronJob).stop();
      }
    } finally {
      this.jobs.delete(id);
      logger.info(`scheduler: job ${id} deleted`);
    }
  }

  has(id: string): boolean {
    return this.jobs.has(id);
  }

  size(): number {
    return this.jobs.size;
  }
}

// Module-level singleton — IPS treats the scheduler as a process-wide
// resource, and so does the rest of our code (one wrapper for all jobs).
const schedulerEngine = new SchedulerEngine("UTC");
export default schedulerEngine;
