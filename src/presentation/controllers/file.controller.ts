/**
 * File Controller for Hono
 *
 * Handles all file-related HTTP requests including:
 * - CRUD operations
 * - File uploads/downloads
 * - AI processing (tags, databoard imports)
 * - Multi-file operations
 */

import type { Context } from "hono";
import fileService from "../../core/services/file.service";
import { publishAudit, fileAuditEvents } from "../../core/services/audit-publisher";
import folderService from "../../core/services/folder.service";
import aiService from "../../core/services/ai.service";
import type { IFile } from "../../db/models/file.model";
// import MongoOrganizationRepository from "../../infrastructure/database/repositories/mongo-organization.repository";
import KafkaAutomation from "../../infrastructure/messaging/kafka-automation";
import logger from "../../infrastructure/logging/logger";
import config from "../../config";
import { getDatabase } from "../../infrastructure/database/factory";
import { CRMBoardRepository } from "../../infrastructure/database/repositories/crmboard.repository";
import { isValidFolderId } from "../../core/utils/folder-id";
import { NotFoundError } from "../../core/utils/errors";

const KAFKA_TOPIC = "ROUTER.INCOMING_CRM_EVENT";
const AP_CRM_EVENT_TOPIC = "AP_OUTGOING_CRM_EVENT";

/** workflow_id values that are non-numeric strings belong to Workflow. */
function isApWorkflowId(workflowId: string | undefined | null): boolean {
  if (!workflowId) return false;
  return !/^\d+$/.test(String(workflowId));
}

/**
 * File Controller Class
 */
class FileController {
  private automationBus = KafkaAutomation.getInstance();
  // private organizationRepository = MongoOrganizationRepository.getInstance();

  /**
   * Helper to publish file events
   */
  private async publishFileEvent(
    type: "create" | "update" | "delete",
    files: (IFile | Partial<IFile> | any)[],
  ) {
    if (!files || files.length === 0) return;
    if (!config.kafka.enabled) return;

    try {
      const firstFile = files[0];
      let folderId: string = firstFile.folder_id;
      let organizationId: string = firstFile.organization_id;
      logger.info("organizationId", organizationId);

      // Fetch presigned URLs for all files if they have keys
      const keys = files.map((f: any) => f.key).filter((k) => !!k);
      let presignedUrls: Record<string, string> = {};

      if (keys.length > 0 && type !== "delete") {
        try {
          presignedUrls = await fileService.generatePresignedUrls(keys);
        } catch (urlError) {
          logger.warn(
            `Failed to generate presigned URLs for Kafka event: ${urlError}`,
          );
          // Continue without URLs rather than failing the whole event
        }
      }

      const [
        // organization,
        folder,
      ] = await Promise.all([
        // this.organizationRepository.findById(organizationId),
        folderService.getFolderById(folderId),
      ]);

      let partition = 0;
      // if (organization) {
      //   partition = organization.partition || 0;
      // } else {
      //   logger.warn(`Organization ${organizationId} not found, skipping event publish`);
      // }

      // Map files to include presigned_url
      const filesWithUrls = files.map((file) => {
        const fileObj = file.toObject ? file.toObject() : file;
        return {
          ...fileObj,
          presigned_url: file.key ? presignedUrls[file.key] : null,
        };
      });

      const message = {
        is_knowledge_base: true,
        files: filesWithUrls,
        folder: folder || { _id: folderId },
        type: type,
      };
      await this.automationBus.publish(KAFKA_TOPIC, message, partition);

      // Dispatch AP workflows: mirror board-item.service.publishApCrmEvents.
      // Files don't have a board_id, so match crmboards by folder_id via the
      // KB finder. One event published per matching non-paused AP workflow.
      await this.publishApFileCrmEvents(
        type,
        filesWithUrls,
        folder || { _id: folderId },
        folderId,
        partition,
      );
    } catch (error) {
      logger.error(`Failed to publish file event: ${error}`);
      // Non-blocking error
    }
  }

  /**
   * Lookup crmboards rows whose folder_ids contains folderId and whose type
   * matches, then publish one AP_OUTGOING_CRM_EVENT per (file, non-paused
   * AP workflow) pair. Numeric workflow_ids are IPS-internal and stay on the
   * ROUTER topic above.
   *
   * Payload shape mirrors what the AP transformer expects (analogous to
   * board-item's `board_item` singular): `file` singular + a top-level
   * `presigned_url` convenience copy.
   */
  private async publishApFileCrmEvents(
    type: "create" | "update" | "delete",
    files: any[],
    folder: any,
    folderId: string,
    partition: number,
  ): Promise<void> {
    let candidatesFound = 0;
    let pausedSkipped = 0;
    let nonApSkipped = 0;
    let published = 0;

    try {
      const db = getDatabase();
      const repo = new CRMBoardRepository(db);
      const candidates = await repo.findByFolderIdTypeAndKnowledgeBase(
        folderId,
        type,
      );
      candidatesFound = candidates.length;

      const eligible = candidates.filter((r) => {
        if (r.is_paused) {
          pausedSkipped++;
          return false;
        }
        if (!isApWorkflowId(r.workflow_id)) {
          nonApSkipped++;
          return false;
        }
        return true;
      });

      for (const file of files) {
        for (const r of eligible) {
          const message: Record<string, any> = {
            is_knowledge_base: true,
            file,
            folder,
            type,
            workflow_id: r.workflow_id,
            presigned_url: file?.presigned_url ?? null,
          };
          await this.automationBus.publish(
            AP_CRM_EVENT_TOPIC,
            message,
            partition,
          );
          published++;
          logger.info(
            `[kafka:${AP_CRM_EVENT_TOPIC}] publish ok type=${type} workflow_id=${r.workflow_id} folder_id=${folderId} file_id=${file?._id ?? file?.id}`,
          );
        }
      }

      logger.info(
        `[kafka:${AP_CRM_EVENT_TOPIC}] dispatch summary type=${type} folder_id=${folderId} files=${files.length} candidates=${candidatesFound} published=${published} paused_skipped=${pausedSkipped} non_ap_skipped=${nonApSkipped}`,
      );
    } catch (err) {
      const msg = (err as Error).message || String(err);
      const tableMissing =
        /relation .* does not exist/i.test(msg) ||
        /Table .* not found in Drizzle schema map/i.test(msg);
      logger.error(
        `[kafka:${AP_CRM_EVENT_TOPIC}] AP dispatch failed type=${type} folder_id=${folderId} table_missing=${tableMissing} candidates_seen=${candidatesFound}: ${msg}`,
      );
    }
  }
  /**
   * Create a new file record
   * POST /files
   */
  create = async (c: Context) => {
    const fileData: Partial<IFile> = await c.req.json();
    const file = await fileService.createFile(fileData);

    // Publish create event
    if (file) {
      this.publishFileEvent("create", [file]).catch((err) =>
        logger.error(`publishFileEvent failed: ${err}`),
      );
    }

    return c.json(
      {
        success: true,
        message: "File created successfully",
        data: file,
      },
      201,
    );
  };

  /**
   * Get all files with optional filters
   * GET /files?folder_id=X&skip=0&limit=20&sortBy=name&sortOrder=asc
   */
  getAll = async (c: Context) => {
    const folder_id = c.req.query("folder_id");
    const organization_id = c.get("organizationId") as string;
    const skip = c.req.query("skip");
    const limit = c.req.query("limit");
    const sortBy = c.req.query("sortBy");
    const sortOrder = c.req.query("sortOrder");

    let files: IFile[];

    if (folder_id) {
      files = await fileService.getFilesByFolder(
        folder_id,
        skip ? parseInt(skip, 10) : 0,
        limit ? parseInt(limit, 10) : undefined,
        sortBy,
        sortOrder as "asc" | "desc" | undefined,
      );
    } else if (organization_id) {
      files = await fileService.getFilesByOrganization(organization_id);
    } else {
      files = await fileService.getAllFiles(
        skip ? parseInt(skip, 10) : undefined,
        limit ? parseInt(limit, 10) : undefined,
        sortBy,
        sortOrder as "asc" | "desc" | undefined,
      );
    }

    return c.json({
      success: true,
      message: "Files retrieved successfully",
      data: files,
    });
  };

  /**
   * Search files
   * GET /files/search?q=query&folder_id=X&limit=10
   */
  search = async (c: Context) => {
    const query = c.req.query("q") || "";
    const folder_id = c.req.query("folder_id");
    const organization_id = c.get("organizationId") as string;
    const limit = c.req.query("limit");
    const skip = c.req.query("skip");
    const sortBy = c.req.query("sortBy");
    const sortOrder = c.req.query("sortOrder");

    const files = await fileService.searchFiles(
      query,
      organization_id,
      folder_id,
      limit ? parseInt(limit, 10) : undefined,
    );

    return c.json({
      success: true,
      message: "Files searched successfully",
      data: files,
    });
  };

  /**
   * Get file by ID
   * GET /files/:id
   */
  getById = async (c: Context) => {
    const id = c.req.param("id");
    const file = await fileService.getFileById(id);

    if (!file) {
      return c.json(
        {
          success: false,
          message: "File not found",
          data: null,
        },
        404,
      );
    }

    // Generate presigned URL
    const presignedUrl = await fileService.generatePresignedUrl(file.key);

    return c.json({
      success: true,
      message: "File retrieved successfully",
      data: {
        ...(typeof (file as any).toObject === "function"
          ? (file as any).toObject()
          : file),
        presigned_url: presignedUrl,
      },
    });
  };

  /**
   * Update file
   * PUT /files/:id
   */
  update = async (c: Context) => {
    const id = c.req.param("id");
    const updateData: Partial<IFile> = await c.req.json();

    // Parse tags if provided: support both comma-separated string and JSON array
    if (updateData.tags) {
      const tagsInput = updateData.tags as any;

      if (typeof tagsInput === "string") {
        try {
          // Try to parse as JSON array first
          const parsed = JSON.parse(tagsInput);
          if (Array.isArray(parsed)) {
            updateData.tags = parsed;
          } else {
            // If it's not an array, treat as single tag
            updateData.tags = [String(parsed)];
          }
        } catch (e) {
          // Not valid JSON, treat as comma-separated string
          updateData.tags = tagsInput
            .split(",")
            .map((tag: string) => tag.trim())
            .filter((tag: string) => tag.length > 0) as any;
        }
      }
      // If tags is already an array, leave it as-is
    }

    const file = await fileService.updateFile(id, updateData);

    if (!file) {
      return c.json(
        {
          success: false,
          message: "File not found",
          data: null,
        },
        404,
      );
    }

    // Publish update event
    if (file) {
      this.publishFileEvent("update", [file]).catch((err) =>
        logger.error(`publishFileEvent failed: ${err}`),
      );
    }

    return c.json({
      success: true,
      message: "File updated successfully",
      data: file,
    });
  };

  /**
   * Delete single file or multiple files
   * POST /files/delete
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

    // Fetch files before deletion to get folder_id and organization_id for event publishing
    const filesToDelete = await Promise.all(
      ids.map((id: string) => fileService.getFileById(id)),
    );

    const result = await fileService.deleteMultipleFiles(ids);

    // Publish delete event for files
    const validFiles = filesToDelete.filter((file) => file);
    if (validFiles.length > 0) {
      this.publishFileEvent("delete", validFiles).catch((err) =>
        logger.error(`publishFileEvent failed: ${err}`),
      );
      publishAudit(fileAuditEvents("delete", validFiles, c.get("userId") as string | undefined));
    }

    return c.json({
      success: true,
      message: `${result.deletedCount} files deleted successfully`,
      data: result,
    });
  };

  /**
   * Upload file(s)
   * POST /files/upload
   *
   * Supports two modes:
   * 1. Multipart form data with file(s) - traditional file upload
   * 2. JSON body with file_url - upload from external URL
   */
  upload = async (c: Context) => {
    const contentType = c.req.header("content-type") || "";
    const organization_id = c.get("organizationId") as string;

    // Check if this is a JSON request with file_url
    if (contentType.includes("application/json")) {
      const raw = await c.req.json();
      // Legacy clients (e.g. AP "Upload file to Knowledge folder" steps in
      // the Create The Order Manager flow) wrap the payload as
      // `{data: {file_url, folder_id, ...}}`. Unwrap so both the bare shape
      // and the wrapped shape work without a workflow edit.
      const jsonBody =
        raw && typeof raw === "object" && raw.data &&
        typeof raw.data === "object" && "file_url" in raw.data
          ? raw.data
          : raw;

      // Validate required fields for JSON upload
      if (!jsonBody.file_url) {
        return c.json(
          {
            success: false,
            message: "file_url is required for JSON upload",
            data: null,
          },
          400,
        );
      }

      if (!jsonBody.folder_id) {
        return c.json(
          {
            success: false,
            message: "folder_id is required",
            data: null,
          },
          400,
        );
      }

      if (!isValidFolderId(jsonBody.folder_id)) {
        return c.json(
          {
            success: false,
            message: "folder_id is not a valid id",
            data: null,
          },
          400,
        );
      }

      // Verify the folder exists for this organization, creating it on demand.
      try {
        await folderService.ensureFolder(
          jsonBody.folder_id,
          organization_id,
          jsonBody.folder_name,
        );
      } catch (err) {
        if (err instanceof NotFoundError) {
          return c.json(
            { success: false, message: "Folder not found", data: null },
            404,
          );
        }
        throw err;
      }

      // Parse last_updated_by
      let last_updated_by = jsonBody.last_updated_by || {
        user_id: "unknown",
        name: "Unknown User",
      };

      // Prepare metadata for URL-based upload
      const metadata: any = {
        file_url: jsonBody.file_url,
        folder_id: jsonBody.folder_id,
        organization_id,
        last_updated_by,
      };

      // Add optional fields
      if (jsonBody.tags) metadata.tags = jsonBody.tags;
      if (jsonBody.remarks) metadata.remarks = jsonBody.remarks;
      if (jsonBody.source_type) metadata.source_type = jsonBody.source_type;

      // Use uploadMultipleFiles which handles file_url internally
      const uploadedFiles = await fileService.uploadMultipleFiles([], metadata);

      // Publish batch create event
      if (uploadedFiles.length > 0) {
        this.publishFileEvent("create", uploadedFiles).catch((err) =>
          logger.error(`publishFileEvent failed: ${err}`),
        );
        publishAudit(fileAuditEvents("upload", uploadedFiles, c.get("userId") as string | undefined));
      }

      return c.json(
        {
          success: true,
          message: `${uploadedFiles.length} file(s) uploaded successfully`,
          data: uploadedFiles.length === 1 ? uploadedFiles[0] : uploadedFiles,
        },
        201,
      );
    }

    // Stream multipart files directly to disk — no file content held in RAM
    const { parseMultipartToDisk, cleanupTempFiles } =
      await import("../utils/multipart-to-disk");
    const req = (c.env as any).incoming;
    const { fields, files: diskFiles } = await parseMultipartToDisk(
      req,
      Object.fromEntries(c.req.raw.headers),
    );

    const folder_id = fields.folder_id;
    const folder_name = fields.folder_name;
    const tagsInput = fields.tags;
    const remarks = fields.remarks;
    const source_type = fields.source_type;

    // Parse last_updated_by if provided
    let last_updated_by = { display_name: "User", email: "user@example.com" };
    if (fields.last_updated_by) {
      try {
        last_updated_by = JSON.parse(fields.last_updated_by);
      } catch (e) {
        logger.warn("Failed to parse last_updated_by:", e);
      }
    }

    // Parse tags
    let tags: string[] | undefined;
    if (tagsInput) {
      try {
        const parsed = JSON.parse(tagsInput);
        tags = Array.isArray(parsed) ? parsed : [String(parsed)];
      } catch (e) {
        tags = tagsInput
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }
    }

    if (!folder_id) {
      cleanupTempFiles(diskFiles);
      return c.json(
        { success: false, message: "folder_id is required", data: null },
        400,
      );
    }

    if (!isValidFolderId(folder_id)) {
      cleanupTempFiles(diskFiles);
      return c.json(
        { success: false, message: "folder_id is not a valid id", data: null },
        400,
      );
    }

    // Verify the folder exists for this organization, creating it on demand.
    // Done once here rather than per-file in the upload loop below.
    try {
      await folderService.ensureFolder(folder_id, organization_id, folder_name);
    } catch (err) {
      cleanupTempFiles(diskFiles);
      if (err instanceof NotFoundError) {
        return c.json(
          { success: false, message: "Folder not found", data: null },
          404,
        );
      }
      throw err;
    }

    logger.info(`Processing ${diskFiles.length} file(s)`);

    if (diskFiles.length === 0) {
      return c.json(
        { success: false, message: "No file uploaded", data: null },
        400,
      );
    }

    let uploadedFiles: any[] = [];
    try {
      uploadedFiles = await Promise.all(
        diskFiles.map(async (diskFile) => {
          const metadata: any = { folder_id, organization_id, last_updated_by };
          if (tags) metadata.tags = tags;
          if (remarks) metadata.remarks = remarks;
          if (source_type) metadata.source_type = source_type;
          return fileService.uploadFile(diskFile, metadata);
        }),
      );
    } finally {
      cleanupTempFiles(diskFiles);
    }

    // Publish batch create event
    if (uploadedFiles.length > 0) {
      this.publishFileEvent("create", uploadedFiles).catch((err) =>
        logger.error(`publishFileEvent failed: ${err}`),
      );
      publishAudit(fileAuditEvents("upload", uploadedFiles, c.get("userId") as string | undefined));
    }

    return c.json(
      {
        success: true,
        message: `${uploadedFiles.length} file(s) uploaded successfully`,
        data: uploadedFiles.length === 1 ? uploadedFiles[0] : uploadedFiles,
      },
      201,
    );
  };

  /**
   * Download file
   * GET /files/:id/download
   */
  download = async (c: Context) => {
    const id = c.req.param("id");
    const file = await fileService.getFileById(id);

    if (!file) {
      return c.json(
        {
          success: false,
          message: "File not found",
          data: null,
        },
        404,
      );
    }

    const result = await fileService.downloadFile(file.key);
    const buffer = Buffer.from(result.buffer);
    const contentType =
      result.headers.get("content-type") || "application/octet-stream";

    return c.body(buffer, 200, {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${file.name}"`,
    });
  };

  /**
   * Generate tags for a file
   * POST /ai/tag-generation
   */
  generateTags = async (c: Context) => {
    const body = await c.req.json();
    const folder_name = body.folder_name as string;
    const description = body.description as string;

    if (!folder_name || !description) {
      return c.json(
        {
          success: false,
          message: "folder_name and description are required",
          data: null,
        },
        400,
      );
    }

    const tags = await aiService.generateTags(folder_name, description, {
      userId: c.get("userId"),
      organizationId: c.get("organizationId"),
    });

    return c.json({
      success: true,
      message: "Tags generated successfully",
      data: tags,
    });
  };

  /**
   * Proxy external file (e.g., presigned URL)
   * GET /files/proxy/external?url=X
   */
  proxyExternal = async (c: Context) => {
    const url = c.req.query("url");

    if (!url) {
      return c.json(
        {
          success: false,
          message: "url query parameter is required",
          data: null,
        },
        400,
      );
    }

    const result = await fileService.proxyExternalUrl(url);
    const buffer = Buffer.from(result.buffer);

    return c.body(buffer, 200, {
      "Content-Type": result.contentType,
    });
  };
}

// Export singleton instance
export const fileController = new FileController();
