/**
 * Dropbox Router for Hono
 */

import { Hono } from "hono";
import { dropboxController } from "../controllers/dropbox.controller";

const dropboxRouter = new Hono();

// Auth
dropboxRouter.get("/auth/dropbox/initiate", dropboxController.initiateAuth);
dropboxRouter.get("/auth/dropbox/callback", dropboxController.handleCallback);
dropboxRouter.get(
  "/auth/dropbox/session/status",
  dropboxController.getSessionStatus,
);

// Files & Folders
dropboxRouter.get("/dropbox/folders", dropboxController.getFolders);
dropboxRouter.get("/dropbox/files", dropboxController.getFiles);
dropboxRouter.get("/dropbox/files/download", dropboxController.downloadFile);

export default dropboxRouter;
