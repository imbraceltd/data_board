/**
 * Folder Controller for Hono
 *
 * Handles all folder-related HTTP requests
 * Delegates business logic to folder service
 */

import type { Context } from "hono";
import folderService from "../../core/services/folder.service";
import type { IFolder } from "../../db/models/folder.model";
import logger from "../../infrastructure/logging/logger";
import { isValidFolderId } from "../../core/utils/folder-id";

/**
 * Folder Controller Class
 */
class FolderController {
  /**
   * Create a new folder
   * POST /folders
   */
  create = async (c: Context) => {
    const folderData: Partial<IFolder> = await c.req.json();
    const folder = await folderService.createFolder(folderData);

    return c.json(
      {
        success: true,
        message: "Folder created successfully",
        data: folder,
      },
      201,
    );
  };

  /**
   * Get all folders (with optional organization filter)
   * GET /folders?ignore_assistant=true
   */
  getAll = async (c: Context) => {
    const organization_id = c.get("organizationId") as string;
    const ignore_assistant = c.req.query("ignore_assistant");
    const ignoreAssistant = ignore_assistant === "true";

    let folders: IFolder[];
    if (organization_id) {
      folders = await folderService.getFoldersByOrganization(
        organization_id,
        ignoreAssistant,
      );
    } else {
      folders = await folderService.getAllFolders(ignoreAssistant);
    }

    return c.json({
      success: true,
      message: "Folders retrieved successfully",
      data: folders,
    });
  };

  /**
   * Search folders
   * GET /folders/search?q=query&limit=10
   */
  search = async (c: Context) => {
    const query = c.req.query("q") || "";
    const organization_id = c.get("organizationId") as string;
    const limit = c.req.query("limit");
    const ignore_assistant = c.req.query("ignore_assistant");
    const ignoreAssistant = ignore_assistant === "true";

    const searchQuery = typeof query === "string" ? query : "";

    const folders = await folderService.searchFolders(
      searchQuery,
      organization_id || undefined,
      limit ? parseInt(limit, 10) : undefined,
      ignoreAssistant,
    );

    return c.json({
      success: true,
      message: "Folders searched successfully",
      data: folders,
    });
  };

  /**
   * Get folder by ID (with optional subfolders)
   * GET /folders/:id?recursive=true&ignore_assistant=true
   */
  getById = async (c: Context) => {
    const id = c.req.param("id");
    const recursive = c.req.query("recursive");
    const ignore_assistant = c.req.query("ignore_assistant");

    const isRecursive = recursive === "true";
    const ignoreAssistant = ignore_assistant === "true";

    const folder = await folderService.getFolderById(id);
    if (!folder) {
      return c.json(
        {
          success: false,
          message: "Folder not found",
          data: null,
        },
        404,
      );
    }

    let subfolders;
    if (isRecursive) {
      // Get all subfolders recursively as a flat list
      subfolders = await folderService.getAllSubfoldersRecursive(id);
      // Filter out assistant folders if requested
      if (ignoreAssistant) {
        subfolders = subfolders.filter(
          (f: IFolder) => f.source_type !== "assistant",
        );
      }
    } else {
      // Get only direct subfolders
      subfolders = await folderService.getSubfolders(id, ignoreAssistant);
    }

    return c.json({
      success: true,
      message: isRecursive
        ? "Folder with recursive subfolders retrieved successfully"
        : "Folder retrieved successfully",
      data: {
        folder,
        subfolders,
        recursive: isRecursive,
      },
    });
  };

  /**
   * Get folder and all its subfolders by parent folder ID
   * Each folder includes its file names and file_count
   * GET /folders/:id/subfolders?recursive=true&ignore_assistant=true
   */
  getSubfoldersById = async (c: Context) => {
    const id = c.req.param("id");

    if (!isValidFolderId(id)) {
      return c.json(
        {
          success: false,
          message: `Invalid folder ID format ${id}`,
          data: null,
        },
        400,
      );
    }

    const recursive = c.req.query("recursive");
    const ignore_assistant = c.req.query("ignore_assistant");

    const isRecursive = recursive === "true";
    const ignoreAssistant = ignore_assistant === "true";

    const result = await folderService.getFolderWithSubfolders(
      id,
      isRecursive,
      ignoreAssistant,
    );

    if (!result) {
      return c.json(
        {
          success: false,
          message: "Folder not found",
          data: null,
        },
        404,
      );
    }

    return c.json({
      success: true,
      message: isRecursive
        ? "Folder with all nested subfolders retrieved successfully"
        : "Folder with direct subfolders retrieved successfully",
      data: {
        folder: result.folder,
        subfolders: result.subfolders,
        total_subfolders: result.subfolders.length,
        total_files: result.total_files,
        recursive: isRecursive,
      },
    });
  };

  /**
   * Get multiple folders and all their subfolders by an array of parent folder IDs
   * Each folder includes its file names and file_count (minimal payload for AI agents)
   * POST /folders/subfolders
   * Body: { ids: string[], recursive?: boolean, ignore_assistant?: boolean }
   */
  getSubfoldersByIds = async (c: Context) => {
    const body = await c.req.json();
    const { ids, recursive, ignore_assistant } = body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return c.json(
        {
          success: false,
          message: "ids array is required and must not be empty",
          data: null,
        },
        400,
      );
    }

    // Validate all IDs
    const invalidIds = ids.filter((id: string) => !isValidFolderId(id));
    if (invalidIds.length > 0) {
      return c.json(
        {
          success: false,
          message: `Invalid folder ID format: ${invalidIds.join(", ")}`,
          data: null,
        },
        400,
      );
    }

    const isRecursive = recursive === true || recursive === "true";
    const ignoreAssistant =
      ignore_assistant === true || ignore_assistant === "true";

    const result = await folderService.getFoldersWithSubfolders(
      ids,
      isRecursive,
      ignoreAssistant,
    );

    return c.json({
      success: true,
      message: isRecursive
        ? "Folders with all nested subfolders retrieved successfully"
        : "Folders with direct subfolders retrieved successfully",
      data: {
        folders: result.folders,
        total_folders: result.folders.length,
        total_files: result.total_files,
        recursive: isRecursive,
      },
    });
  };

  /**
   * Update folder
   * PUT /folders/:id
   */
  update = async (c: Context) => {
    const id = c.req.param("id");
    const updateData: Partial<IFolder> = await c.req.json();

    const folder = await folderService.updateFolder(id, updateData);
    if (!folder) {
      return c.json(
        {
          success: false,
          message: "Folder not found",
          data: null,
        },
        404,
      );
    }

    return c.json({
      success: true,
      message: "Folder updated successfully",
      data: folder,
    });
  };

  /**
   * Delete folders (single or multiple)
   * POST /folders/delete
   * Body: { ids: string[] }
   */
  delete = async (c: Context) => {
    const { ids } = await c.req.json();

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return c.json(
        {
          success: false,
          message: "ids array is required and must not be empty",
          data: null,
        },
        400,
      );
    }

    const result = await folderService.deleteMultipleFolders(ids);

    return c.json({
      success: true,
      message: `${result.deletedCount} folders deleted successfully`,
      data: result,
    });
  };

  /**
   * Get folder contents (files and subfolders)
   * GET /folders/:id/contents?skip=0&limit=20&sortBy=name&sortOrder=asc&recursive=true&q=search
   */
  getContents = async (c: Context) => {
    const id = c.req.param("id");
    const skip = c.req.query("skip");
    const limit = c.req.query("limit");
    const sortBy = c.req.query("sortBy");
    const sortOrder = c.req.query("sortOrder");
    const recursive = c.req.query("recursive");
    const ignore_assistant = c.req.query("ignore_assistant");
    const qParam = c.req.query("q");

    const searchQuery =
      qParam && typeof qParam === "string" && qParam.trim().length > 0
        ? qParam.trim()
        : "";

    const isRecursive = recursive === "true";
    const ignoreAssistant = ignore_assistant === "true";

    logger.debug(
      `Folder contents request - id: ${id}, q: "${searchQuery}", recursive: ${isRecursive}`,
    );

    const folder = await folderService.getFolderById(id);
    if (!folder) {
      return c.json(
        {
          success: false,
          message: "Folder not found",
          data: null,
        },
        404,
      );
    }

    // Validate sortOrder
    const validSortOrder =
      sortOrder === "asc" || sortOrder === "desc"
        ? (sortOrder as "asc" | "desc")
        : undefined;

    const subfolders = await folderService.getSubfolders(
      id,
      ignoreAssistant,
      skip ? parseInt(skip, 10) : undefined,
      limit ? parseInt(limit, 10) : undefined,
      sortBy,
      validSortOrder,
    );

    let files;
    if (searchQuery) {
      // Search files within this folder (or recursively if requested)
      if (isRecursive) {
        files = await folderService.searchFilesInFolderRecursive(
          id,
          searchQuery,
          skip ? parseInt(skip, 10) : 0,
          limit ? parseInt(limit, 10) : undefined,
          sortBy,
          validSortOrder,
        );
      } else {
        files = await folderService.searchFilesInFolder(
          id,
          searchQuery,
          skip ? parseInt(skip, 10) : 0,
          limit ? parseInt(limit, 10) : undefined,
          sortBy,
          validSortOrder,
        );
      }
    } else {
      // Get all files in folder (or recursively if requested)
      if (isRecursive) {
        files = await folderService.getFilesInFolderRecursive(
          id,
          skip ? parseInt(skip, 10) : 0,
          limit ? parseInt(limit, 10) : undefined,
          sortBy,
          validSortOrder,
        );
      } else {
        files = await folderService.getFilesInFolder(
          id,
          skip ? parseInt(skip, 10) : 0,
          limit ? parseInt(limit, 10) : undefined,
          sortBy,
          validSortOrder,
        );
      }
    }

    // Import fileService to generate presigned URLs
    const fileService = (await import("../../core/services/file.service"))
      .default;

    // Collect all file keys
    const fileKeys = files.map((file: { key: any }) => file.key);

    // Generate presigned URLs for all files
    const presignedUrls = await fileService.generatePresignedUrls(fileKeys);

    // Enhance files with presigned URLs
    const enhancedFiles = files.map(
      (file: { toObject?: () => any; key: string | number }) => {
        const fileObj = typeof file.toObject === "function" ? file.toObject() : file;
        const presignedUrl = presignedUrls[file.key];

        if (presignedUrl) {
          fileObj.presigned_url = presignedUrl;
        } else {
          fileObj.presigned_url = null;
        }

        return fileObj;
      },
    );

    // Get total files count based on mode (recursive or direct only)
    let totalFiles: number;
    if (searchQuery) {
      // For search results, we need to count search results
      if (isRecursive) {
        const allSearchFiles = await folderService.searchFilesInFolderRecursive(
          id,
          searchQuery,
          0,
          undefined,
          sortBy,
          validSortOrder,
        );
        totalFiles = allSearchFiles.length;
      } else {
        const allSearchFiles = await folderService.searchFilesInFolder(
          id,
          searchQuery,
          0,
          undefined,
          sortBy,
          validSortOrder,
        );
        totalFiles = allSearchFiles.length;
      }
    } else {
      // For regular folder contents
      if (isRecursive) {
        const allFiles = await folderService.getFilesInFolderRecursive(
          id,
          0,
          undefined,
          sortBy,
          validSortOrder,
        );
        totalFiles = allFiles.length;
      } else {
        const allDirectFiles = await folderService.getFilesInFolder(
          id,
          0,
          undefined,
          sortBy,
          validSortOrder,
        );
        totalFiles = allDirectFiles.length;
      }
    }

    // Always calculate the actual recursive count for accurate pagination
    let totalRecursiveFiles: number;
    if (searchQuery) {
      const allRecursiveSearchFiles =
        await folderService.searchFilesInFolderRecursive(
          id,
          searchQuery,
          0,
          undefined,
          sortBy,
          validSortOrder,
        );
      totalRecursiveFiles = allRecursiveSearchFiles.length;
    } else {
      const allRecursiveFiles = await folderService.getFilesInFolderRecursive(
        id,
        0,
        undefined,
        sortBy,
        validSortOrder,
      );
      totalRecursiveFiles = allRecursiveFiles.length;
    }

    // Calculate pagination metadata
    const currentSkip = skip ? parseInt(skip, 10) : 0;
    const currentLimit = limit ? parseInt(limit, 10) : undefined;
    const currentPage = currentLimit
      ? Math.floor(currentSkip / currentLimit) + 1
      : 1;
    const totalPages = currentLimit ? Math.ceil(totalFiles / currentLimit) : 1;

    return c.json({
      success: true,
      message: searchQuery
        ? isRecursive
          ? "Folder contents searched recursively successfully"
          : "Folder contents searched successfully"
        : isRecursive
          ? "Folder contents retrieved recursively successfully"
          : "Folder contents retrieved successfully",
      data: {
        folder,
        subfolders,
        files: enhancedFiles,
        search_query: searchQuery || null,
        recursive: isRecursive,
        pagination: {
          file_count: totalFiles,
          total_recursive_file_count: totalRecursiveFiles,
          current_page: currentPage,
          total_pages: totalPages,
          limit: currentLimit,
          skip: currentSkip,
        },
      },
    });
  };

  /**
   * Toggle folder sync
   * PATCH /folders/:id/sync
   * Body: { is_sync_enabled: boolean }
   */
  toggleSync = async (c: Context) => {
    const id = c.req.param("id");
    const { is_sync_enabled } = await c.req.json();

    if (typeof is_sync_enabled !== "boolean") {
      return c.json(
        {
          success: false,
          message: "is_sync_enabled must be a boolean value",
          data: null,
        },
        400,
      );
    }

    const folder = await folderService.getFolderById(id);
    if (!folder) {
      return c.json(
        {
          success: false,
          message: "Folder not found",
          data: null,
        },
        404,
      );
    }

    // Only allow toggling sync for external folders
    if (folder.source_type !== "external") {
      return c.json(
        {
          success: false,
          message: "Sync toggle is only available for external folders",
          data: null,
        },
        400,
      );
    }

    const updatedFolder = await folderService.updateFolder(id, {
      is_sync_enabled,
    });

    return c.json({
      success: true,
      message: `Folder sync ${is_sync_enabled ? "enabled" : "disabled"} successfully`,
      data: updatedFolder,
    });
  };

  /**
   * Export folder as zip
   * POST /folders/:id/export?recursive=true
   */
  exportFolder = async (c: Context) => {
    const id = c.req.param("id");
    const recursive = c.req.query("recursive");
    const isRecursive = recursive !== "false"; // Default to true

    const folder = await folderService.getFolderById(id);
    if (!folder) {
      return c.json(
        {
          success: false,
          message: "Folder not found",
          data: null,
        },
        404,
      );
    }

    try {
      const zipBuffer = await folderService.exportFolderAsZip(id, isRecursive);

      // Generate filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `folder-${folder.name}-${timestamp}.zip`;

      return c.body(new Uint8Array(zipBuffer), 200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
      });
    } catch (error: any) {
      logger.error(`Error exporting folder ${id}:`, error);
      return c.json(
        {
          success: false,
          message: `Failed to export folder: ${error.message}`,
          data: null,
        },
        500,
      );
    }
  };

  /**
   * Import folder from zip
   * POST /folders/import
   * Body (multipart): file (zip), organization_id, parent_folder_id, name_prefix (optional)
   * OR Body (json): zip_url, organization_id, parent_folder_id, name_prefix (optional)
   */
  importFolder = async (c: Context) => {
    try {
      // Check if it's multipart or JSON
      const contentType = c.req.header("content-type") || "";
      const organization_id = c.get("organizationId") as string;

      let zipBuffer: Buffer;
      let parent_folder_id: string;
      let name_prefix: string | undefined;

      if (contentType.includes("multipart/form-data")) {
        // Handle multipart upload
        const body = await c.req.parseBody();
        const file = body.file;

        if (!file || !(file instanceof File)) {
          return c.json(
            {
              success: false,
              message: "No zip file provided",
              data: null,
            },
            400,
          );
        }

        parent_folder_id = body.parent_folder_id as string;
        name_prefix = body.name_prefix as string | undefined;

        // Convert File to Buffer
        const arrayBuffer = await file.arrayBuffer();
        zipBuffer = Buffer.from(arrayBuffer);
      } else {
        // Handle JSON with zip_url
        const body = await c.req.json();
        const {
          zip_url,
          parent_folder_id: parent_id,
          name_prefix: prefix,
        } = body;

        if (!zip_url) {
          return c.json(
            {
              success: false,
              message: "No zip_url provided",
              data: null,
            },
            400,
          );
        }

        parent_folder_id = parent_id;
        name_prefix = prefix;

        // Download zip from URL
        const response = await fetch(zip_url);
        if (!response.ok) {
          throw new Error(
            `Failed to download zip from URL: ${response.statusText}`,
          );
        }
        const arrayBuffer = await response.arrayBuffer();
        zipBuffer = Buffer.from(arrayBuffer);
      }

      // Validate required fields
      if (!organization_id || !parent_folder_id) {
        return c.json(
          {
            success: false,
            message: "organization_id and parent_folder_id are required",
            data: null,
          },
          400,
        );
      }

      // Import the folder
      const importedFolder = await folderService.importFolderFromZip(
        zipBuffer,
        organization_id,
        parent_folder_id,
        name_prefix,
      );

      return c.json(
        {
          success: true,
          message: "Folder imported successfully",
          data: importedFolder,
        },
        201,
      );
    } catch (error: any) {
      logger.error("Error importing folder:", error);
      return c.json(
        {
          success: false,
          message: `Failed to import folder: ${error.message}`,
          data: null,
        },
        500,
      );
    }
  };
}

// Export singleton instance
export const folderController = new FolderController();
