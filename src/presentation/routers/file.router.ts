/**
 * File Router for Hono
 *
 * Defines all file-related routes
 */

import { Hono } from "hono";
import { fileController } from "../controllers/file.controller";
import { extractUserContext } from "../middleware";

const fileRouter = new Hono();

fileRouter.use("*", extractUserContext());

// CRUD operations - specific routes BEFORE parameterized routes
fileRouter.post("/files", fileController.create);
fileRouter.get("/files", fileController.getAll);
fileRouter.get("/files/search", fileController.search); // ← Must be before :id
fileRouter.get("/files/proxy/external", fileController.proxyExternal); // ← Must be before :id

// Parameterized routes (must come after specific routes)
fileRouter.get("/files/:id", fileController.getById);
fileRouter.get("/files/:id/download", fileController.download);
fileRouter.put("/files/:id", fileController.update);

// Delete and upload
fileRouter.post("/files/delete", fileController.delete);
fileRouter.post("/files/upload", fileController.upload);

// AI services
fileRouter.post("/ai/tag-generation", fileController.generateTags);

export default fileRouter;
