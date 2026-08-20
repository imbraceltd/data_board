/**
 * Main API Router for Hono
 *
 * Assembles all API routes
 */

import { Hono } from "hono";
import folderRouter from "./folder.router";
import fileRouter from "./file.router";
import onedriveRouter from "./onedrive.router";
import googleDriveRouter from "./google-drive.router";
import dropboxRouter from "./dropbox.router";
import providersRouter from "./providers.router";
import aiProxyRouter from "./ai-proxy.router";
import boardRouter from "./board.router";
import crmboardRouter from "./crmboard.router";
import schedulerRouter from "./scheduler.router";
import ontologyRouter from "./ontology.router";
import searchRouter from "./search.router";
import linkPreviewRouter from "./link-preview.router";
import docAiRouter from "./doc-ai.router";
import { healthController } from "../controllers/health.controller";
import { ValidationError } from "../../domain/shared/errors";

const apiRouter = new Hono();

// Mount routers
apiRouter.route("/", folderRouter);
apiRouter.route("/", fileRouter);
apiRouter.route("/", onedriveRouter);
apiRouter.route("/", googleDriveRouter);
apiRouter.route("/", dropboxRouter);
apiRouter.route("/", providersRouter);
apiRouter.route("/", aiProxyRouter);
apiRouter.route("/", boardRouter);
apiRouter.route("/v1", crmboardRouter);
apiRouter.route("/v1", schedulerRouter);
apiRouter.route("/", linkPreviewRouter);
apiRouter.route("/ontology", ontologyRouter);
apiRouter.route("/search", searchRouter);
apiRouter.route("/", docAiRouter);

// Health check
apiRouter.get("/health", healthController.check);

// Test error route (development only)
apiRouter.get("/error", (c) => {
  throw new ValidationError("This is a test validation error");
});

export default apiRouter;
