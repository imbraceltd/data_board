import Folder from "../../db/models/folder.model";
import File from "../../db/models/file.model";
import OneDriveSession from "../../db/models/onedrive-session.model";
import onedriveService from "./onedrive.service";
import onedriveSyncService from "./onedrive-sync.service";
import fileService from "./file.service";
import logger from "../utils/logger";
import { runWithJobContext } from "../../infrastructure/logging/request-context";
import { ExternalSource } from "../enums/external-source.enum";

class OneDrivePollingService {
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL = 2 * 60 * 1000; // 2 minutes

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.info("OneDrive polling service is already running");
      return;
    }

    this.isRunning = true;
    logger.info("Starting OneDrive polling service");

    // Start the polling loop
    this.intervalId = setInterval(async () => {
      try {
        await runWithJobContext("onedrive-poll", () => this.pollForChanges());
      } catch (error) {
        logger.error("Error in OneDrive polling cycle:", error);
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

    logger.info("Stopped OneDrive polling service");
  }

  /**
   * Main polling method - checks for folders with sync enabled
   */
  private async pollForChanges(): Promise<void> {
    try {
      // Find all folders with sync enabled from OneDrive
      const syncEnabledFolders = await Folder.find({
        external_source: ExternalSource.ONEDRIVE, // Use enum instead of string
        is_sync_enabled: true,
      });

      if (syncEnabledFolders.length === 0) {
        logger.info("No OneDrive folders with sync enabled found");
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
            ", "
          )}. Syncing only one instance per ID.`
        );
      }

      logger.info(
        `Found ${uniqueFolders.size} unique OneDrive folders with sync enabled`
      );

      // Process each unique folder
      for (const folder of uniqueFolders.values()) {
        await this.syncFolder(folder);
      }
    } catch (error) {
      logger.error("Error polling for OneDrive changes:", error);
    }
  }

  /**
   * Helper method to get file count (excluding subfolders) for a folder
   */
  private async getFolderFileCount(
    accessToken: string,
    folderId: string
  ): Promise<number> {
    try {
      const client = onedriveService["createAuthenticatedClient"](accessToken);
      const endpoint =
        folderId === "root"
          ? "/me/drive/root/children"
          : `/me/drive/items/${folderId}/children`;

      let totalFileCount = 0;
      let nextLink: string | undefined = undefined;
      let currentEndpoint = endpoint;

      // Fetch all children using pagination
      do {
        const response = await client.api(currentEndpoint).get();

        // Count only files (items with file property, not folder)
        const files = response.value.filter((item: any) => item.file);
        totalFileCount += files.length;

        nextLink = response["@odata.nextLink"];
        if (nextLink) {
          currentEndpoint = nextLink;
        }
      } while (nextLink);

      return totalFileCount;
    } catch (error: any) {
      logger.error(
        `Error getting file count for folder ${folderId}:`,
        error.message
      );
      // Return 0 if we can't get the count
      return 0;
    }
  }

  /**
   * Sync a specific folder
   */
  private async syncFolder(folder: any): Promise<void> {
    try {
      // Get the OneDrive session (we need the access token)
      let session;

      // PRIORITY 1: Try to find session by session_id (most accurate for multi-account)
      if (folder.session_id) {
        session = await OneDriveSession.findOne({
          sessionId: folder.session_id,
        });

        if (session) {
          logger.info(
            `Found session for folder ${folder.name} using session_id: ${folder.session_id}`
          );
        } else {
          logger.warn(
            `Session ${folder.session_id} not found for folder ${folder.name}, falling back to organization_id`
          );
        }
      }

      // FALLBACK 1: Try to find the most recent session by organization_id
      if (!session && folder.organization_id) {
        session = await OneDriveSession.findOne({
          organization_id: folder.organization_id,
        }).sort({ created_at: -1 }); // Get the most recent session

        if (session) {
          logger.warn(
            `Using fallback session for folder ${folder.name} (org: ${folder.organization_id}). Consider setting session_id for multi-account support.`
          );
        }
      }

      // FALLBACK 2: Try to find the most recent session without organization_id (legacy support)
      if (!session) {
        session = await OneDriveSession.findOne({
          organization_id: { $exists: false },
        }).sort({ created_at: -1 });

        if (session) {
          logger.warn(
            `Using legacy fallback session for folder ${folder.name}`
          );
        }
      }

      if (!session) {
        logger.warn(
          `No OneDrive session found for folder ${folder.name} (org: ${folder.organization_id}, session_id: ${folder.session_id})`
        );
        return;
      }

      // Validate and refresh token if needed
      const isValid = await onedriveService.validateToken(session.access_token);

      let accessToken = session.access_token;
      if (!isValid && session.refresh_token) {
        logger.info(`Refreshing access token for folder ${folder.name}`);
        const tokenData = await onedriveService.refreshAccessToken(
          session.refresh_token
        );

        // Update session with new token
        await OneDriveSession.findByIdAndUpdate(session._id, {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token || session.refresh_token,
          expires_in: tokenData.expires_in,
        });

        accessToken = tokenData.access_token;
      }

      // Get delta link from folder document
      const deltaLink = folder.delta_link;

      logger.info(
        `Checking for changes in folder: ${folder.name} (external_id: ${folder.external_id})`
      );

      // Try to extract driveId from external_id (OneDrive Personal format: DriveID!ItemID)
      let driveId: string | undefined;
      if (folder.external_id && folder.external_id.includes("!")) {
        const parts = folder.external_id.split("!");
        if (parts.length >= 2 && /^[A-F0-9]+$/i.test(parts[0])) {
          driveId = parts[0];
        }
      }

      // Get delta changes from OneDrive, scoped to this folder
      let deltaResult;
      try {
        deltaResult = await onedriveService.getDelta(
          accessToken,
          deltaLink,
          folder.external_id,
          driveId
        );
      } catch (error: any) {
        // Handle specific error cases
        const errorCode = error.code;

        // If delta token is invalid/expired or item doesn't exist, clear it and retry
        if (
          errorCode === "ItemNotFound" ||
          errorCode === "resyncRequired" ||
          errorCode === "invalidRequest" ||
          error.message?.includes("Item does not exist")
        ) {
          logger.warn(
            `Delta token invalid for folder ${folder.name}, resetting and retrying...`
          );

          // Clear the delta link and try again from scratch
          await Folder.findByIdAndUpdate(folder._id, {
            delta_link: undefined,
          });

          // Retry without delta link (start fresh)
          try {
            deltaResult = await onedriveService.getDelta(
              accessToken,
              undefined,
              folder.external_id,
              driveId
            );
            logger.info(
              `Successfully restarted delta sync for folder ${folder.name}`
            );
          } catch (retryError: any) {
            logger.error(
              `Failed to restart delta sync for folder ${folder.name}:`,
              retryError.message
            );
            throw retryError;
          }
        }
        // Handle access denied errors
        else if (
          errorCode === "AccessDenied" ||
          errorCode === "Forbidden" ||
          error.message?.includes("Access denied")
        ) {
          logger.error(
            `Access denied for folder ${folder.name}. User may need to re-authenticate or grant permissions.`
          );

          // Try without driveId (use /me/drive endpoint instead)
          if (driveId) {
            logger.info(`Retrying folder ${folder.name} without driveId...`);
            try {
              deltaResult = await onedriveService.getDelta(
                accessToken,
                undefined,
                folder.external_id,
                undefined
              );
              logger.info(
                `Successfully synced folder ${folder.name} using /me/drive endpoint`
              );
            } catch (retryError: any) {
              logger.error(
                `Still failed for folder ${folder.name}:`,
                retryError.message
              );
              throw retryError;
            }
          } else {
            throw error;
          }
        }
        // For other errors, just throw
        else {
          throw error;
        }
      }

      if (deltaResult.changes && deltaResult.changes.length > 0) {
        logger.info(
          `Found ${deltaResult.changes.length} changes in folder ${folder.name}`
        );

        // STEP 1: Mark folder as unsynced (before we start syncing)
        await Folder.findByIdAndUpdate(folder._id, {
          synced: false,
          last_sync_at: new Date(),
        });
        logger.info(`Marked folder ${folder.name} as unsynced`);

        // STEP 2: Process the changes (download files, update DB)
        await this.processChanges(
          deltaResult.changes,
          folder,
          accessToken,
          session.user_info
        );

        // STEP 3: Mark folder as synced after successful sync AND save delta link
        await Folder.findByIdAndUpdate(folder._id, {
          synced: true,
          last_sync_at: new Date(),
          delta_link: deltaResult.deltaLink,
        });
        logger.info(`Marked folder ${folder.name} as synced`);
      } else {
        logger.info(`No changes found in folder ${folder.name}`);

        // Save delta link if it changed (even if no changes found, to acknowledge the token)
        if (deltaResult.deltaLink && deltaResult.deltaLink !== deltaLink) {
          await Folder.findByIdAndUpdate(folder._id, {
            delta_link: deltaResult.deltaLink,
            last_sync_at: new Date(),
          });
        }
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
   * Process changes from OneDrive delta query
   */
  private async processChanges(
    changes: any[],
    rootSyncFolder: any,
    accessToken: string,
    userInfo: any
  ): Promise<void> {
    try {
      for (const change of changes) {
        // Handle deleted items
        if (change.deleted) {
          await this.handleDeletedItem(change);
          continue;
        }

        // Handle folders
        if (change.folder) {
          await this.handleFolderChange(change, rootSyncFolder, accessToken);
          continue;
        }

        // Handle files
        if (change.file) {
          await this.handleFileChange(
            change,
            rootSyncFolder,
            accessToken,
            userInfo
          );
          continue;
        }
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
      // Delete from folder collection
      await Folder.deleteOne({
        external_id: change.id,
        external_source: "onedrive",
      });

      // Delete from file collection
      const deletedFile = await File.findOneAndDelete({
        external_id: change.id,
        external_source: "onedrive",
      });

      // If file was deleted, also delete from file system
      if (deletedFile && deletedFile.key) {
        // TODO: Add method to delete from FS service if needed
        logger.info(`Deleted file ${change.id} from database`);
      }

      logger.info(`Deleted item ${change.id} from local database`);
    } catch (error) {
      logger.error(`Error deleting item ${change.id}:`, error);
    }
  }

  /**
   * Handle folder changes
   */
  private async handleFolderChange(
    change: any,
    rootSyncFolder: any,
    accessToken: string
  ): Promise<void> {
    try {
      // Check if this folder already exists in our database
      let existingFolder = await Folder.findOne({
        external_id: change.id,
        external_source: ExternalSource.ONEDRIVE,
      });

      if (existingFolder) {
        // Update existing folder - get accurate file count (excluding subfolders)
        const fileCount = await this.getFolderFileCount(accessToken, change.id);

        await Folder.findByIdAndUpdate(existingFolder._id, {
          name: change.name,
          synced: true,
          last_sync_at: new Date(),
          path: change.parentReference?.path || `/drive/root/${change.name}`,
          file_count: fileCount,
        });

        logger.info(`Updated existing folder: ${change.name}`);
      } else {
        // This is a new subfolder - check if its parent is in our system
        let parentFolderInDb = null;

        if (change.parentReference?.id) {
          parentFolderInDb = await Folder.findOne({
            external_id: change.parentReference.id,
            external_source: ExternalSource.ONEDRIVE,
          });
        }

        // If parent folder exists in our system and has sync enabled, create this subfolder
        if (parentFolderInDb && parentFolderInDb.is_sync_enabled) {
          // Get accurate file count (excluding subfolders)
          const fileCount = await this.getFolderFileCount(
            accessToken,
            change.id
          );

          const newFolder = await Folder.create({
            name: change.name,
            organization_id: rootSyncFolder.organization_id,
            parent_folder_id: parentFolderInDb._id,
            source_type: "external",
            external_id: change.id,
            external_source: ExternalSource.ONEDRIVE,
            session_id: rootSyncFolder.session_id,
            synced: true,
            is_sync_enabled: true, // Inherit sync setting from parent
            last_sync_at: new Date(),
            path: change.parentReference?.path || `/drive/root/${change.name}`,
            file_count: fileCount,
          });

          logger.info(
            `Created new subfolder: ${change.name} (ID: ${newFolder._id}) under parent ${parentFolderInDb.name}`
          );
        } else if (change.parentReference?.id === rootSyncFolder.external_id) {
          // This is a direct child of the root synced folder
          // Get accurate file count (excluding subfolders)
          const fileCount = await this.getFolderFileCount(
            accessToken,
            change.id
          );

          const newFolder = await Folder.create({
            name: change.name,
            organization_id: rootSyncFolder.organization_id,
            parent_folder_id: rootSyncFolder._id,
            source_type: "external",
            external_id: change.id,
            external_source: ExternalSource.ONEDRIVE,
            session_id: rootSyncFolder.session_id,
            synced: true,
            is_sync_enabled: true,
            last_sync_at: new Date(),
            path: change.parentReference?.path || `/drive/root/${change.name}`,
            file_count: fileCount,
          });

          logger.info(
            `Created new direct subfolder: ${change.name} (ID: ${newFolder._id})`
          );
        } else {
          logger.info(
            `Skipping folder ${change.name} - parent folder not in system or sync disabled`
          );
        }
      }
    } catch (error) {
      logger.error(`Error handling folder ${change.name}:`, error);
    }
  }

  /**
   * Handle file changes - download and save to local file system
   */
  private async handleFileChange(
    change: any,
    rootSyncFolder: any,
    accessToken: string,
    userInfo: any
  ): Promise<void> {
    try {
      // Find the parent folder of this file in our database
      let parentFolderInDb = await Folder.findOne({
        external_id: change.parentReference?.id,
        external_source: ExternalSource.ONEDRIVE,
      });

      // Skip if parent folder doesn't exist in our system
      if (!parentFolderInDb) {
        logger.info(
          `Skipping file ${change.name} - parent folder not in database (external_id: ${change.parentReference?.id})`
        );
        return;
      }

      // Skip if parent folder has sync disabled
      if (!parentFolderInDb.is_sync_enabled) {
        logger.info(
          `Skipping file ${change.name} - sync disabled for parent folder ${parentFolderInDb.name}`
        );
        return;
      }

      logger.info(
        `Processing file ${change.name} in folder ${parentFolderInDb.name}`
      );

      // Check if file already exists in our database by external_id
      let existingFile = await File.findOne({
        external_id: change.id,
        external_source: "onedrive",
      });

      // If not found by external_id, check by name and folder_id
      // This handles cases where files existed before OneDrive sync
      if (!existingFile) {
        existingFile = await File.findOne({
          name: change.name,
          folder_id: parentFolderInDb._id,
          // Only match files that don't have external sync metadata yet
          $or: [
            { external_id: { $exists: false } },
            { external_source: { $exists: false } },
          ],
        });

        if (existingFile) {
          logger.info(
            `Found existing non-synced file with same name: ${change.name}. Will update with OneDrive metadata.`
          );
        }
      }

      // Download the file from OneDrive
      logger.info(`Downloading file: ${change.name} (${change.size} bytes)`);
      const downloadInfo = await onedriveService.downloadFile(
        accessToken,
        change.id
      );

      // Fetch the actual file content
      const fileResponse = await fetch(downloadInfo.url);
      if (!fileResponse.ok) {
        throw new Error(`Failed to download file ${change.name}`);
      }

      const fileBuffer = await fileResponse.arrayBuffer();

      // Upload to our FS service
      logger.info(`Uploading file ${change.name} to FS service`);
      const fsFormData = new FormData();
      fsFormData.append(
        "file",
        new Blob([fileBuffer], { type: change.file.mimeType }),
        change.name
      );

      const fsResponse = await fetch(`${fileService["fsServiceUrl"]}/upload`, {
        method: "POST",
        body: fsFormData,
      });

      if (!fsResponse.ok) {
        throw new Error(`Failed to upload file ${change.name} to FS service`);
      }

      const fsResult = await fsResponse.json();
      const fileKey =
        fsResult.data.key || fsResult.data.Key || fsResult.data.name;

      // Prepare last_updated_by info
      const lastUpdatedBy = {
        display_name:
          userInfo?.displayName ||
          change.lastModifiedBy?.user?.displayName ||
          "Unknown",
        email:
          userInfo?.email ||
          change.lastModifiedBy?.user?.email ||
          "unknown@onedrive.com",
      };

      // Update or create file record in database
      if (existingFile) {
        // Update existing file
        await File.findByIdAndUpdate(existingFile._id, {
          name: change.name,
          file_size: change.size,
          file_type: change.file.mimeType || "application/octet-stream",
          key: fileKey,
          folder_id: parentFolderInDb._id, // Update folder_id in case it moved
          external_id: change.id, // Add OneDrive external_id
          external_source: ExternalSource.ONEDRIVE, // Add OneDrive external_source
          synced: true,
          last_sync_at: new Date(),
          last_updated_by: lastUpdatedBy,
        });

        logger.info(`Updated existing file: ${change.name}`);
      } else {
        // Create new file record
        const newFile = await File.create({
          name: change.name,
          organization_id: rootSyncFolder.organization_id,
          folder_id: parentFolderInDb._id,
          source_type: "external",
          external_id: change.id,
          external_source: ExternalSource.ONEDRIVE,
          synced: true,
          last_sync_at: new Date(),
          key: fileKey,
          file_type: change.file.mimeType || "application/octet-stream",
          file_size: change.size,
          last_updated_by: lastUpdatedBy,
        });

        logger.info(
          `Created new file: ${change.name} (ID: ${newFile._id}) in folder ${parentFolderInDb.name}`
        );

        // Update folder file count
        const folderService = (await import("./folder.service")).default;
        await folderService.updateFileCount(
          (parentFolderInDb as any)._id.toString()
        );
      }
    } catch (error) {
      logger.error(`Error handling file ${change.name}:`, error);

      // Mark file as unsynced on error
      await File.updateOne(
        { external_id: change.id, external_source: ExternalSource.ONEDRIVE },
        { synced: false }
      );
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

    if (folder.external_source !== ExternalSource.ONEDRIVE) {
      throw new Error(`Folder ${folderId} is not a OneDrive folder`);
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

export default new OneDrivePollingService();
