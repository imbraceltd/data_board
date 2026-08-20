/**
 * Google Drive Router for Hono
 */

import { Hono } from "hono";
import { googleDriveController } from "../controllers/google-drive.controller";

const googleDriveRouter = new Hono();

// Auth
googleDriveRouter.get(
  "/auth/google-drive/initiate",
  googleDriveController.initiateAuth,
);
googleDriveRouter.get(
  "/auth/google-drive/callback",
  googleDriveController.handleCallback,
);
googleDriveRouter.get(
  "/auth/google-drive/session/status",
  googleDriveController.getSessionStatus,
);

// Files & Folders
googleDriveRouter.get(
  "/google-drive/folders",
  googleDriveController.getFolders,
);
googleDriveRouter.get("/google-drive/files", googleDriveController.getFiles);
googleDriveRouter.get(
  "/google-drive/files/download",
  googleDriveController.downloadFile,
);

// Sync Management
googleDriveRouter.get(
  "/google-drive/sync/status",
  googleDriveController.getSyncStatus,
);
googleDriveRouter.post(
  "/google-drive/sync/folders/:folderId",
  googleDriveController.syncFolder,
);
googleDriveRouter.put(
  "/google-drive/sync/folders/:folderId/enable",
  googleDriveController.enableFolderSync,
);
googleDriveRouter.put(
  "/google-drive/sync/folders/:folderId/disable",
  googleDriveController.disableFolderSync,
);
googleDriveRouter.get(
  "/google-drive/sync/folders",
  googleDriveController.getSyncEnabledFolders,
);

export default googleDriveRouter;
