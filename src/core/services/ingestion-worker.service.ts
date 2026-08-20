import type { IIngestionJob } from "../../db/models/ingestion-job.model";
import { ingestionJobRepository } from "../../infrastructure/database/repositories/ingestion-job.repository";
import { fileRepository } from "../../infrastructure/database/repositories/file.repository";
import aiService from "./ai.service";
import logger from "../utils/logger";
import { runWithJobContext } from "../../infrastructure/logging/request-context";

class IngestionWorkerService {
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL = 10000; // 10 seconds
  private readonly BATCH_LIMIT = 6;
  private readonly CONCURRENCY = 2;

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.info("Ingestion worker is already running");
      return;
    }

    this.isRunning = true;
    logger.info("Starting ingestion worker");

    this.intervalId = setInterval(async () => {
      try {
        await runWithJobContext("ingestion-worker", () =>
          this.processPendingJobs(),
        );
      } catch (error) {
        logger.error("Error in ingestion worker polling cycle:", error);
      }
    }, this.POLL_INTERVAL);

    await this.processPendingJobs();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    logger.info("Stopped ingestion worker");
  }

  private async processPendingJobs(): Promise<void> {
    try {
      const pendingJobs = await ingestionJobRepository.findPendingReady(
        this.BATCH_LIMIT,
      );

      if (pendingJobs.length === 0) {
        return;
      }

      logger.info(`Found ${pendingJobs.length} pending ingestion jobs`);

      for (let i = 0; i < pendingJobs.length; i += this.CONCURRENCY) {
        const batch = pendingJobs.slice(i, i + this.CONCURRENCY);
        await Promise.allSettled(batch.map((job) => this.processJob(job)));
      }
    } catch (error) {
      logger.error("Error processing pending jobs:", error);
    }
  }

  private async processJob(job: IIngestionJob): Promise<void> {
    const jobId = String((job as any)._id);

    try {
      await ingestionJobRepository.update(jobId, {
        status: "in_progress",
      } as Partial<IIngestionJob>);

      logger.info(`Processing ingestion job ${jobId} for file ${job.fileId}`);

      const file = await fileRepository.findById(job.fileId);
      if (!file) {
        throw new Error(`File ${job.fileId} not found`);
      }

      const fileId = String((file as any)._id);

      const fileForAI = {
        mimetype: file.file_type,
        originalname: file.name,
        size: file.file_size,
      };

      const metadata = {
        organization_id: file.organization_id,
        folder_id: file.folder_id,
        file_id: fileId,
      };

      const fileService = (await import("./file.service")).default;
      const presignedUrls = await fileService.generatePresignedUrls([file.key]);
      const fileUrl = presignedUrls[file.key];

      if (!fileUrl) {
        throw new Error(`Failed to generate presigned URL for file ${file.key}`);
      }

      const shouldSkipEmbedding = await fileService.hasActiveCrmBoard(
        file.folder_id,
        file.organization_id,
      );

      if (!shouldSkipEmbedding) {
        await aiService.processEmbedding({ ...fileForAI, fileUrl }, metadata);
      } else {
        logger.info(
          `Skipping embedding for job ${jobId} — active CRM board detected for folder ${file.folder_id}`,
        );
      }

      await ingestionJobRepository.update(jobId, {
        status: "done",
        errorMessage: undefined,
        errorCode: undefined,
      } as Partial<IIngestionJob>);

      logger.info(`Successfully completed ingestion job ${jobId}`);
    } catch (error) {
      logger.error(`Error processing ingestion job ${jobId}:`, error);

      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      const errorCode = error instanceof Error ? error.name : "UNKNOWN_ERROR";

      await ingestionJobRepository.update(jobId, {
        status: "error",
        errorMessage,
        errorCode,
        retryCount: (job.retryCount || 0) + 1,
      } as Partial<IIngestionJob>);
    }
  }

  async processJobsNow(): Promise<void> {
    await this.processPendingJobs();
  }
}

export default new IngestionWorkerService();
