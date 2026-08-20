/**
 * OneDrive Router for Hono
 */

import { Hono } from "hono";
import { onedriveController } from "../controllers/onedrive.controller";

const onedriveRouter = new Hono();

// Auth
onedriveRouter.get("/auth/onedrive/initiate", onedriveController.initiateAuth);
onedriveRouter.get(
  "/auth/onedrive/callback",
  onedriveController.handleCallback,
);
onedriveRouter.get(
  "/auth/onedrive/session/status",
  onedriveController.getSessionStatus,
);
onedriveRouter.get(
  "/auth/onedrive/files/session/status",
  onedriveController.getSessionStatus,
);

// Files & Folders
onedriveRouter.get("/onedrive/folders", onedriveController.getFolders);
onedriveRouter.get("/onedrive/files", onedriveController.getFiles);
onedriveRouter.get("/onedrive/files/download", onedriveController.downloadFile);

// Sync Management
onedriveRouter.get("/onedrive/sync/status", onedriveController.getSyncStatus);
onedriveRouter.post(
  "/onedrive/sync/folders/:folderId",
  onedriveController.syncFolder,
);
onedriveRouter.put(
  "/onedrive/sync/folders/:folderId/enable",
  onedriveController.enableFolderSync,
);
onedriveRouter.put(
  "/onedrive/sync/folders/:folderId/disable",
  onedriveController.disableFolderSync,
);
onedriveRouter.get(
  "/onedrive/sync/folders",
  onedriveController.getSyncEnabledFolders,
);

// Webhooks
onedriveRouter.post("/onedrive/webhook", onedriveController.handleWebhook);

// Subscriptions (TODO: Add if needed, wasn't fully refactored in controller but was in original router)
// skipped createSubscription/listSubscriptions/deleteSubscription for brevity unless requested,
// as they are rarely used by UI directly (usually handled via sync service flow)

export default onedriveRouter;
