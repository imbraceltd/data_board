import Folder from "../../db/models/folder.model";
import File from "../../db/models/file.model";
import GoogleDriveSession from "../../db/models/google-drive-session.model";
import { ingestionJobRepository } from "../../infrastructure/database/repositories/ingestion-job.repository";
import { fileRepository } from "../../infrastructure/database/repositories/file.repository";
import googleDriveService from "./google-drive.service";
import googleDriveSyncService from "./google-drive-sync.service";
import fileService from "./file.service";
import logger from "../utils/logger";
import { runWithJobContext } from "../../infrastructure/logging/request-context";
import { ExternalSource } from "../enums/external-source.enum";
import axios from "axios";

class GoogleDrivePollingService {
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL = 2 * 60 * 1000; // 2 minutes

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.info("Google Drive polling service is already running");
      return;
    }

    this.isRunning = true;
    logger.info("Starting Google Drive polling service");

    // Start the polling loop
    this.intervalId = setInterval(async () => {
      try {
        await runWithJobContext("google-drive-poll", () => this.pollForChanges());
      } catch (error) {
        logger.error("Error in Google Drive polling cycle:", error);
      }
    }, this.POLL_INTERVAL);

    // Poll immediately on start
    await this.pollForChanges();
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

    logger.info("Stopped Google Drive polling service");
  }

  /**
   * Main polling method - checks for folders with sync enabled
   */
  private async pollForChanges(): Promise<void> {
    try {
      // Find all folders with sync enabled from Google Drive
      const syncEnabledFolders = await Folder.find({
        external_source: ExternalSource.GOOGLE_DRIVE,
        is_sync_enabled: true,
      });

      if (syncEnabledFolders.length === 0) {
        logger.info("No Google Drive folders with sync enabled found");
        return;
      }

      // Deduplicate folders by external_id to prevent double syncing
      const uniqueFolders = new Map<string, any>();
      const duplicates: string[] = [];

      syncEnabledFolders.forEach((folder) => {
        if (folder.external_id) {
          if (uniqueFolders.has(folder.external_id)) {
            duplicates.push(folder.name);
          } else {
            uniqueFolders.set(folder.external_id, folder);
          }
        }
      });

      if (duplicates.length > 0) {
        logger.warn(
          `Found duplicate folders with same external_id: ${duplicates.join(
            ", ",
          )}. Syncing only one instance per ID.`,
        );
      }

      logger.info(
        `Found ${uniqueFolders.size} unique Google Drive folders with sync enabled`,
      );

      // Process each unique folder
      for (const folder of uniqueFolders.values()) {
        await this.syncFolder(folder);
      }
    } catch (error) {
      logger.error("Error polling for Google Drive changes:", error);
    }
  }

  /**
   * Sync a specific folder
   */
  private async syncFolder(folder: any): Promise<void> {
    try {
      // Get the Google Drive session (we need the access token)
      let session;

      // PRIORITY 1: Try to find session by session_id (most accurate for multi-account)
      if (folder.session_id) {
        session = await GoogleDriveSession.findOne({
          sessionId: folder.session_id,
        });

        if (session) {
          logger.info(
            `Found session for folder ${folder.name} using session_id: ${folder.session_id}`,
          );
        } else {
          logger.warn(
            `Session ${folder.session_id} not found for folder ${folder.name}, falling back to organization_id`,
          );
        }
      }

      // FALLBACK 1: Try to find the most recent session by organization_id
      if (!session && folder.organization_id) {
        session = await GoogleDriveSession.findOne({
          organization_id: folder.organization_id,
        }).sort({ created_at: -1 }); // Get the most recent session

        if (session) {
          logger.warn(
            `Using fallback session for folder ${folder.name} (org: ${folder.organization_id}). Consider setting session_id for multi-account support.`,
          );
        }
      }

      // FALLBACK 2: Try to find the most recent session without organization_id (legacy support)
      if (!session) {
        session = await GoogleDriveSession.findOne({
          organization_id: { $exists: false },
        }).sort({ created_at: -1 });

        if (session) {
          logger.warn(
            `Using legacy fallback session for folder ${folder.name}`,
          );
        }
      }

      if (!session) {
        logger.warn(
          `No Google Drive session found for folder ${folder.name} (org: ${folder.organization_id}, session_id: ${folder.session_id})`,
        );
        return;
      }

      // Validate and refresh token if needed
      const isValid = await googleDriveService.validateToken(
        session.access_token,
      );

      let accessToken = session.access_token;
      if (!isValid && session.refresh_token) {
        logger.info(`Refreshing access token for folder ${folder.name}`);
        const tokenData = await googleDriveService.refreshAccessToken(
          session.refresh_token,
        );

        // Update session with new token
        await GoogleDriveSession.findByIdAndUpdate(session._id, {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token || session.refresh_token,
          expires_at: Date.now() + tokenData.expires_in * 1000,
        });

        accessToken = tokenData.access_token;
      }

      // Get page token from session  (Google Drive uses page tokens instead of delta links)
      const pageToken = session.start_page_token;

      logger.info(
        `Checking for changes in folder: ${folder.name} (external_id: ${folder.external_id})`,
      );

      // Get changes from Google Drive
      let changesResult;
      try {
        changesResult = await googleDriveService.getChanges(
          accessToken,
          pageToken,
        );
      } catch (error: any) {
        logger.error(
          `Failed to get changes for folder ${folder.name}:`,
          error.message,
        );
        throw error;
      }

      if (changesResult.changes && changesResult.changes.length > 0) {
        logger.info(
          `Found ${changesResult.changes.length} changes in Google Drive`,
        );

        // STEP 1: Mark folder as unsynced (before we start syncing)
        await Folder.findByIdAndUpdate(folder._id, {
          synced: false,
          last_sync_at: new Date(),
        });
        logger.info(`Marked folder ${folder.name} as unsynced`);

        // STEP 2: Process the changes (download files, update DB)
        await this.processChanges(
          changesResult.changes,
          folder,
          accessToken,
          session.user_info,
        );

        // STEP 3: Mark folder as synced after successful sync AND save page token
        await Folder.findByIdAndUpdate(folder._id, {
          synced: true,
          last_sync_at: new Date(),
        });
        logger.info(`Marked folder ${folder.name} as synced`);
      } else {
        logger.info(`No changes found in folder ${folder.name}`);
      }

      // Save the new page token to the session (even if no changes found)
      const newPageToken =
        changesResult.newStartPageToken || changesResult.nextPageToken;
      if (newPageToken && newPageToken !== pageToken) {
        await GoogleDriveSession.findByIdAndUpdate(session._id, {
          start_page_token: newPageToken,
        });
        logger.info(`Updated page token for session ${session.sessionId}`);
      }
    } catch (error) {
      logger.error(`Error syncing folder ${folder.name}:`, error);

      // Mark folder as unsynced on error
      await Folder.findByIdAndUpdate(folder._id, {
        synced: false,
      });
    }
  }

  /**
   * Process changes from Google Drive changes.list
   */
  private async processChanges(
    changes: any[],
    rootSyncFolder: any,
    accessToken: string,
    userInfo: any,
  ): Promise<void> {
    try {
      for (const change of changes) {
        // Handle deleted/removed items
        if (change.removed) {
          await this.handleDeletedItem(change);
          continue;
        }

        const file = change.file;
        if (!file) {
          continue;
        }

        // Handle trashed items (treat as deleted)
        if (file.trashed) {
          await this.handleDeletedItem({ fileId: file.id });
          continue;
        }

        // Handle folders
        if (file.mimeType === "application/vnd.google-apps.folder") {
          await this.handleFolderChange(file, rootSyncFolder, accessToken);
          continue;
        }

        // Skip shortcut files (no ingestion worker for this type)
        if (file.mimeType === "application/vnd.google-apps.shortcut") {
          logger.info(
            `Skipping shortcut file: ${file.name} (no ingestion worker available)`,
          );
          continue;
        }

        // Handle files
        await this.handleFileChange(
          file,
          rootSyncFolder,
          accessToken,
          userInfo,
        );
      }
    } catch (error) {
      logger.error("Error processing changes:", error);
      throw error;
    }
  }

  /**
   * Handle deleted items
   */
  private async handleDeletedItem(change: any): Promise<void> {
    try {
      const itemId = change.fileId || change.file?.id;

      // Delete from folder collection
      await Folder.deleteOne({
        external_id: itemId,
        external_source: ExternalSource.GOOGLE_DRIVE,
      });

      // Delete from file collection
      const deletedFile = await File.findOneAndDelete({
        external_id: itemId,
        external_source: ExternalSource.GOOGLE_DRIVE,
      });

      if (deletedFile) {
        logger.info(`Deleted file ${itemId} from database`);
      }

      logger.info(`Deleted item ${itemId} from local database`);
    } catch (error) {
      logger.error(`Error deleting item ${change.fileId}:`, error);
    }
  }

  /**
   * Handle folder changes
   */
  private async handleFolderChange(
    file: any,
    rootSyncFolder: any,
    accessToken: string,
  ): Promise<void> {
    try {
      // Check if this folder already exists in our database
      let existingFolder = await Folder.findOne({
        external_id: file.id,
        external_source: ExternalSource.GOOGLE_DRIVE,
      });

      if (existingFolder) {
        // Update existing folder
        await Folder.findByIdAndUpdate(existingFolder._id, {
          name: file.name,
          synced: true,
          last_sync_at: new Date(),
        });

        logger.info(`Updated existing folder: ${file.name}`);
      } else {
        // This is a new subfolder - check if its parent is in our system
        let parentFolderInDb = null;

        if (file.parents && file.parents.length > 0) {
          parentFolderInDb = await Folder.findOne({
            external_id: file.parents[0],
            external_source: ExternalSource.GOOGLE_DRIVE,
          });
        }

        // If parent folder exists in our system and has sync enabled, create this subfolder
        if (parentFolderInDb && parentFolderInDb.is_sync_enabled) {
          const newFolder = await Folder.create({
            name: file.name,
            organization_id: rootSyncFolder.organization_id,
            parent_folder_id: parentFolderInDb._id,
            source_type: "external",
            external_id: file.id,
            external_source: ExternalSource.GOOGLE_DRIVE,
            session_id: rootSyncFolder.session_id,
            synced: true,
            is_sync_enabled: true, // Inherit sync setting from parent
            last_sync_at: new Date(),
            path: file.parents?.[0] || `/drive/root/${file.name}`,
            file_count: 0,
          });

          logger.info(
            `Created new subfolder: ${file.name} (ID: ${newFolder._id}) under parent ${parentFolderInDb.name}`,
          );
        } else if (
          file.parents &&
          file.parents.includes(rootSyncFolder.external_id)
        ) {
          // This is a direct child of the root synced folder
          const newFolder = await Folder.create({
            name: file.name,
            organization_id: rootSyncFolder.organization_id,
            parent_folder_id: rootSyncFolder._id,
            source_type: "external",
            external_id: file.id,
            external_source: ExternalSource.GOOGLE_DRIVE,
            session_id: rootSyncFolder.session_id,
            synced: true,
            is_sync_enabled: true,
            last_sync_at: new Date(),
            path: file.parents?.[0] || `/drive/root/${file.name}`,
            file_count: 0,
          });

          logger.info(
            `Created new direct subfolder: ${file.name} (ID: ${newFolder._id})`,
          );
        } else {
          logger.info(
            `Skipping folder ${file.name} - parent folder not in system or sync disabled`,
          );
        }
      }
    } catch (error) {
      logger.error(`Error handling folder ${file.name}:`, error);
    }
  }

  /**
   * Handle file changes - download and save to local file system
   */
  private async handleFileChange(
    file: any,
    rootSyncFolder: any,
    accessToken: string,
    userInfo: any,
  ): Promise<void> {
    try {
      // Find the parent folder of this file in our database
      let parentFolderInDb = null;

      if (file.parents && file.parents.length > 0) {
        parentFolderInDb = await Folder.findOne({
          external_id: file.parents[0],
          external_source: ExternalSource.GOOGLE_DRIVE,
        });
      }

      // Skip if parent folder doesn't exist in our system
      if (!parentFolderInDb) {
        logger.info(
          `Skipping file ${file.name} - parent folder not in database (external_id: ${file.parents?.[0]})`,
        );
        return;
      }

      // Skip if parent folder has sync disabled
      if (!parentFolderInDb.is_sync_enabled) {
        logger.info(
          `Skipping file ${file.name} - sync disabled for parent folder ${parentFolderInDb.name}`,
        );
        return;
      }

      logger.info(
        `Processing file ${file.name} in folder ${parentFolderInDb.name}`,
      );

      // Check if file already exists in our database by external_id
      let existingFile = await File.findOne({
        external_id: file.id,
        external_source: ExternalSource.GOOGLE_DRIVE,
      });

      // If not found by external_id, check by name and folder_id
      if (!existingFile) {
        existingFile = await File.findOne({
          name: file.name,
          folder_id: parentFolderInDb._id,
          $or: [
            { external_id: { $exists: false } },
            { external_source: { $exists: false } },
          ],
        });

        if (existingFile) {
          logger.info(
            `Found existing non-synced file with same name: ${file.name}. Will update with Google Drive metadata.`,
          );
        }
      }

      // Download the file from Google Drive
      logger.info(`Downloading file: ${file.name} (${file.size} bytes)`);
      const downloadInfo = await googleDriveService.downloadFileStream(
        accessToken,
        file.id,
      );

      // Convert stream to buffer
      const chunks: Buffer[] = [];
      for await (const chunk of downloadInfo.stream) {
        chunks.push(Buffer.from(chunk));
      }
      const fileBuffer = Buffer.concat(chunks);

      // Upload to our FS service
      logger.info(`Uploading file ${file.name} to FS service`);

      // Use axios to upload with proper form-data in Node.js
      const form = new (require("form-data"))();
      form.append("file", Buffer.from(fileBuffer), {
        filename: downloadInfo.filename,
        contentType: downloadInfo.mimeType,
      });

      const fsResponse = await axios.post(
        `${fileService["fsServiceUrl"]}/upload`,
        form,
        {
          headers: form.getHeaders(),
        },
      );

      const fsResult = fsResponse.data;
      const fileKey =
        fsResult.data.key || fsResult.data.Key || fsResult.data.name;

      // Prepare last_updated_by info
      const lastUpdatedBy = {
        display_name: userInfo?.displayName || "Unknown",
        email: userInfo?.email || "unknown@gmail.com",
      };

      // Update or create file record in database
      if (existingFile) {
        // Update existing file
        await File.findByIdAndUpdate(existingFile._id, {
          name: file.name,
          file_size: parseInt(file.size) || 0,
          file_type: file.mimeType || "application/octet-stream",
          key: fileKey,
          folder_id: parentFolderInDb._id,
          external_id: file.id,
          external_source: ExternalSource.GOOGLE_DRIVE,
          synced: true,
          last_sync_at: new Date(),
          last_updated_by: lastUpdatedBy,
        });

        logger.info(`Updated existing file: ${file.name}`);
      } else {
        // Create new file record
        const newFile = await File.create({
          name: file.name,
          organization_id: rootSyncFolder.organization_id,
          folder_id: parentFolderInDb._id,
          source_type: "external",
          external_id: file.id,
          external_source: ExternalSource.GOOGLE_DRIVE,
          synced: true,
          last_sync_at: new Date(),
          key: fileKey,
          file_type: file.mimeType || "application/octet-stream",
          file_size: parseInt(file.size) || 0,
          last_updated_by: lastUpdatedBy,
        });

        logger.info(
          `Created new file: ${file.name} (ID: ${newFile._id}) in folder ${parentFolderInDb.name}`,
        );

        // Update folder file count
        const folderService = (await import("./folder.service")).default;
        await folderService.updateFileCount(
          (parentFolderInDb as any)._id.toString(),
        );
      }
    } catch (error) {
      logger.error(`Error handling file ${file.name}:`, error);

      // Queue for retry using IngestionJob
      await this.queueForRetry(file, rootSyncFolder, error, userInfo);

      // Mark file as unsynced on error
      await File.updateOne(
        { external_id: file.id, external_source: ExternalSource.GOOGLE_DRIVE },
        { synced: false },
      );
    }
  }

  /**
   * Queue failed file for retry
   */
  private async queueForRetry(
    file: any,
    folder: any,
    error: any,
    userInfo: any,
  ): Promise<void> {
    try {
      // Resolve the data_board file record from the Drive ID before queuing,
      // because IngestionJob.fileId must reference data_board's _id (not the
      // external Drive ID) for the worker to load it.
      const fileDoc = await fileRepository.findByExternalId(
        file.id,
        ExternalSource.GOOGLE_DRIVE,
      );
      if (!fileDoc) {
        logger.warn(
          `Cannot queue retry for Drive file ${file.name} (${file.id}): no data_board file record yet — will retry on next polling cycle`,
        );
        return;
      }

      const dbFileId = String((fileDoc as any)._id);
      const existingJob =
        await ingestionJobRepository.findActiveByFileId(dbFileId);

      if (existingJob) {
        const maxRetries = existingJob.maxRetries || 3;
        const newRetryCount = (existingJob.retryCount || 0) + 1;

        if (newRetryCount >= maxRetries) {
          await ingestionJobRepository.update(
            String((existingJob as any)._id),
            {
              status: "error",
              lastError: `Max retries (${maxRetries}) exceeded: ${error.message}`,
              errorMessage: error.message,
              retryCount: newRetryCount,
            } as any,
          );
          logger.error(
            `File ${file.name} failed after ${newRetryCount} retries`,
          );
        } else {
          const backoffMinutes = Math.pow(2, newRetryCount); // 1, 2, 4, 8...
          await ingestionJobRepository.update(
            String((existingJob as any)._id),
            {
              status: "pending",
              nextRetryAt: new Date(Date.now() + backoffMinutes * 60 * 1000),
              lastError: error.message,
              retryCount: newRetryCount,
            } as any,
          );
          logger.info(
            `Retry scheduled for ${file.name} in ${backoffMinutes} minute(s) (attempt ${newRetryCount}/${maxRetries})`,
          );
        }
      } else {
        const backoffMinutes = 1;
        await ingestionJobRepository.create({
          fileId: dbFileId,
          status: "pending",
          retryCount: 1,
          maxRetries: 3,
          nextRetryAt: new Date(Date.now() + backoffMinutes * 60 * 1000),
          lastError: error.message,
          errorMessage: error.message,
        } as any);
        logger.info(
          `File ${file.name} queued for retry in ${backoffMinutes} minute`,
        );
      }
    } catch (queueError) {
      logger.error(`Error queuing file ${file.name} for retry:`, queueError);
    }
  }

  /**
   * Manually trigger sync for a specific folder (useful for testing or manual sync)
   */
  async syncFolderById(folderId: string): Promise<void> {
    const folder = await Folder.findById(folderId);
    if (!folder) {
      throw new Error(`Folder ${folderId} not found`);
    }

    if (folder.external_source !== ExternalSource.GOOGLE_DRIVE) {
      throw new Error(`Folder ${folderId} is not a Google Drive folder`);
    }

    await this.syncFolder(folder);
  }

  /**
   * Get polling status
   */
  getStatus(): { isRunning: boolean; pollInterval: number } {
    return {
      isRunning: this.isRunning,
      pollInterval: this.POLL_INTERVAL,
    };
  }
}

export default new GoogleDrivePollingService();
