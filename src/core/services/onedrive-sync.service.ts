import logger from "../../infrastructure/logging/logger";
import Folder from "../../db/models/folder.model";
import File from "../../db/models/file.model";
import { ExternalFolder } from "../interfaces/external-folder.interface";
import { ExternalFile } from "../interfaces/external-file.interface";
import { ExternalSource } from "../enums/external-source.enum";

class OneDriveSyncService {
  /**
   * Sync external folders to local database
   */
  async syncFoldersToLocal(
    folders: ExternalFolder[],
    organizationId: string,
    sessionId: string,
    parentFolderId: string = "root"
  ): Promise<void> {
    for (const folder of folders) {
      await Folder.findOneAndUpdate(
        { external_id: folder.id, external_source: folder.source },
        {
          name: folder.name,
          organization_id: organizationId,
          parent_folder_id: parentFolderId,
          source_type: "external",
          external_id: folder.id,
          external_source: folder.source,
          session_id: sessionId, // Link to the OneDrive session
          synced: true,
          is_sync_enabled: true, // Enable sync by default for new external folders
          last_sync_at: new Date(),
          path: folder.parentReference?.path || `/drive/root/${folder.name}`,
          file_count: folder.childCount || 0,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }
  }

  /**
   * Sync external files to local database
   */
  async syncFilesToLocal(
    files: ExternalFile[],
    organizationId: string,
    folderId: string,
    lastUpdatedBy: { display_name: string; email: string }
  ): Promise<void> {
    for (const file of files) {
      await File.findOneAndUpdate(
        { external_id: file.id, external_source: file.source },
        {
          name: file.name,
          organization_id: organizationId,
          folder_id: folderId,
          source_type: "external",
          external_id: file.id,
          external_source: file.source,
          synced: true,
          last_sync_at: new Date(),
          key: file.downloadUrl || file.webUrl || file.id,
          file_type: file.mimeType || "application/octet-stream",
          file_size: file.size,
          last_updated_by: lastUpdatedBy,
        },
        { upsert: true, new: true }
      );
    }

    // Update folder's file_count after syncing files
    if (files.length > 0) {
      const folderService = (await import("./folder.service")).default;
      await folderService.updateFileCount(folderId);
    }
  }

  /**
   * Mark items as out of sync
   */
  async markAsOutOfSync(
    externalIds: string[],
    externalSource: string
  ): Promise<void> {
    // Mark folders as out of sync
    await Folder.updateMany(
      { external_id: { $in: externalIds }, external_source: externalSource },
      { $set: { synced: false } }
    );

    // Mark files as out of sync
    await File.updateMany(
      { external_id: { $in: externalIds }, external_source: externalSource },
      { $set: { synced: false } }
    );
  }

  /**
   * Process delta changes and update local database
   */
  async processDeltaChanges(
    changes: any[],
    organizationId: string,
    lastUpdatedBy: { display_name: string; email: string }
  ): Promise<void> {
    for (const change of changes) {
      // Check if the folder/file belongs to a folder with sync enabled
      let parentFolder;
      if (change.parentReference?.id) {
        parentFolder = await Folder.findOne({
          external_id: change.parentReference.id,
          external_source: ExternalSource.ONEDRIVE,
        });

        // Skip if parent folder exists but sync is disabled
        if (parentFolder && !parentFolder.is_sync_enabled) {
          logger.info(
            `Skipping change for ${change.name} - sync disabled for parent folder`
          );
          continue;
        }
      }

      // If item is deleted
      if (change.deleted) {
        await Folder.deleteOne({
          external_id: change.id,
          external_source: ExternalSource.ONEDRIVE,
        });
        await File.deleteOne({
          external_id: change.id,
          external_source: ExternalSource.ONEDRIVE,
        });
        continue;
      }

      // If item is a folder
      if (change.folder) {
        // Check if this folder has sync enabled before updating
        const existingFolder = await Folder.findOne({
          external_id: change.id,
          external_source: ExternalSource.ONEDRIVE,
        });

        // Skip update if folder exists but sync is disabled
        if (existingFolder && !existingFolder.is_sync_enabled) {
          logger.info(
            `Skipping folder update for ${change.name} - sync disabled`
          );
          continue;
        }

        await Folder.findOneAndUpdate(
          { external_id: change.id, external_source: ExternalSource.ONEDRIVE },
          {
            name: change.name,
            synced: true,
            last_sync_at: new Date(),
          },
          { upsert: false }
        );
      }

      // If item is a file
      if (change.file) {
        // Find the folder this file belongs to
        const fileFolder = await Folder.findOne({
          external_id: change.parentReference?.id,
          external_source: ExternalSource.ONEDRIVE,
        });

        // Skip if folder doesn't have sync enabled
        if (fileFolder && !fileFolder.is_sync_enabled) {
          logger.info(
            `Skipping file update for ${change.name} - sync disabled for folder`
          );
          continue;
        }

        await File.findOneAndUpdate(
          { external_id: change.id, external_source: ExternalSource.ONEDRIVE },
          {
            name: change.name,
            file_size: change.size,
            file_type: change.file?.mimeType || "application/octet-stream",
            synced: true,
            last_sync_at: new Date(),
            last_updated_by: lastUpdatedBy,
          },
          { upsert: false }
        );
      }
    }
  }
}

export default new OneDriveSyncService();
