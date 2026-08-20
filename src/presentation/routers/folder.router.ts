/**
 * Folder Router for Hono
 *
 * Defines all folder-related routes
 */

import { Hono } from "hono";
import { folderController } from "../controllers/folder.controller";
import { extractUserContext } from "../middleware";

const folderRouter = new Hono();

folderRouter.use("*", extractUserContext());

// Create folder
folderRouter.post("/folders", folderController.create);

// Get all folders (with optional filters)
folderRouter.get("/folders", folderController.getAll);

// Search folders
folderRouter.get("/folders/search", folderController.search);

// Get folder by ID (with optional recursive subfolders)
folderRouter.get("/folders/:id", folderController.getById);

// Get folder and all its subfolders by parent folder ID
folderRouter.get("/folders/:id/subfolders", folderController.getSubfoldersById);

// Get multiple folders and all their subfolders by array of parent folder IDs
folderRouter.post("/folders/subfolders", folderController.getSubfoldersByIds);

// Get folder contents (files and subfolders)
folderRouter.get("/folders/:id/contents", folderController.getContents);

// Update folder
folderRouter.put("/folders/:id", folderController.update);

// Toggle folder sync
folderRouter.patch("/folders/:id/sync", folderController.toggleSync);

// Export folder as zip
folderRouter.post("/folders/:id/export", folderController.exportFolder);

// Import folder from zip
folderRouter.post("/folders/import", folderController.importFolder);

// Delete folders (accepts ids array in body)
folderRouter.post("/folders/delete", folderController.delete);

export default folderRouter;
