import { IFile } from "../../db/models/file.model";
import { fileRepository } from "../../infrastructure/database/repositories/file.repository";
import { CRMBoardRepository } from "../../infrastructure/database/repositories/crmboard.repository";
import { getDatabase } from "../../infrastructure/database/factory";
import config from "../../config";
import aiService from "./ai.service";
import BoardUploadFile, {
  IBoardUploadFile,
} from "../../db/models/board-fileupload.model";
import { ingestionJobRepository } from "../../infrastructure/database/repositories/ingestion-job.repository";
import logger from "../utils/logger";

class FileService {
  private fsServiceUrl = config.fsServiceUrl;
  private appGatewayHost = config.appGatewayHost;
  private aiServiceUrl = config.aiServiceUrl;

  /**
   * Check if there is an active (non-paused) CRM board for a given folder.
   * Returns true if embedding should be skipped.
   */
  async hasActiveCrmBoard(
    folderId: string,
    organizationId: string,
  ): Promise<boolean> {
    try {
      const repo = new CRMBoardRepository(getDatabase());
      const crmBoards = await repo.findByFolderIdOrBoardId(folderId, undefined);

      if (!crmBoards || crmBoards.length === 0) {
        return false;
      }

      // Skip embedding if any CRM board has is_paused === false (i.e. actively running)
      const hasActiveBoard = crmBoards.some((board) => board.is_paused === false);

      if (hasActiveBoard) {
        logger.info(
          `Active CRM board found for folder ${folderId}, skipping embedding`,
        );
      }

      return hasActiveBoard;
    } catch (error) {
      logger.error(
        `Error checking CRM board for folder ${folderId}:`,
        error,
      );
      // On error, don't block embedding — proceed normally
      return false;
    }
  }

  async createFile(fileData: Partial<IFile>): Promise<IFile> {
    const savedFile = await fileRepository.create(fileData);

    // Update folder file count
    if (fileData.folder_id) {
      const folderService = (await import("./folder.service")).default;
      await folderService.updateFileCount(fileData.folder_id);
    }

    return savedFile;
  }

  async getAllFiles(
    skip?: number,
    limit?: number,
    sortBy?: string,
    sortOrder?: "asc" | "desc",
  ): Promise<IFile[]> {
    const options: any = {};

    if (skip) {
      options.skip = skip;
    }

    if (limit) {
      options.limit = limit;
    }

    if (sortBy) {
      options.orderBy = [
        {
          field: sortBy,
          direction: sortOrder || "asc",
        },
      ];
    }

    return await fileRepository.findAll(options);
  }

  async getFileById(id: string): Promise<IFile | null> {
    return await fileRepository.findById(id);
  }

  async getFilesByFolder(
    folder_id: string,
    skip: number = 0,
    limit?: number,
    sortBy?: string,
    sortOrder?: "asc" | "desc",
  ): Promise<IFile[]> {
    logger.info(
      `getFilesByFolder: folder_id=${folder_id}, skip=${skip}, limit=${limit}, sortBy=${sortBy}`,
    );

    const options: any = { skip };

    if (limit) {
      options.limit = limit;
    }

    // Map sortBy to actual field names and build orderBy
    if (sortBy) {
      let sortField = sortBy;
      switch (sortBy) {
        case "name":
          sortField = "name";
          break;
        case "tags":
          sortField = "tags";
          break;
        case "remarks":
          sortField = "remarks";
          break;
        case "last_updated_time":
          sortField = "updated_at";
          break;
        default:
          sortField = "name";
      }

      options.orderBy = [
        {
          field: sortField,
          direction: sortOrder || "asc",
        },
      ];
    } else {
      // Default sort for stable pagination
      options.orderBy = [
        {
          field: "updated_at",
          direction: "desc",
        },
      ];
    }

    return await fileRepository.findByFolderId(folder_id, options);
  }

  async getFilesByOrganization(
    organization_id: string,
    skip?: number,
    limit?: number,
    sortBy?: string,
    sortOrder?: "asc" | "desc",
  ): Promise<IFile[]> {
    const options: any = {};

    if (skip) options.skip = skip;
    if (limit) options.limit = limit;

    if (sortBy) {
      options.orderBy = [
        {
          field: sortBy,
          direction: sortOrder || "asc",
        },
      ];
    }

    return await fileRepository.findByOrganization(organization_id, options);
  }

  async searchFiles(
    query: string,
    organization_id?: string,
    folder_id?: string,
    limit?: number,
  ): Promise<IFile[]> {
    // Repository's search method handles this
    return await fileRepository.search(query, organization_id, limit);
  }

  async updateFile(
    id: string,
    updateData: Partial<IFile>,
  ): Promise<IFile | null> {
    // Always update sync_timestamp when updating a file
    const updateWithTimestamp = {
      ...updateData,
      sync_timestamp: new Date(),
    };
    return await fileRepository.update(id, updateWithTimestamp);
  }

  async deleteFile(id: string): Promise<IFile | null> {
    const file = await fileRepository.findById(id);
    if (!file) return null;

    const deleted = await fileRepository.delete(id);
    if (!deleted) return null;

    // Delete related embeddings + tabular parquet data from the AI service
    try {
      const aiService = (await import("./ai.service")).default;
      await aiService.deleteEmbeddingByFileId(id);
      if (file.folder_id) {
        await aiService.deleteParquetsByFolder(file.folder_id, [file.name]);
      }
    } catch (error) {
      logger.error("Error deleting embedding/parquet records:", error);
      // Don't fail the file deletion if AI cleanup fails
    }

    // Update folder file count
    if (file.folder_id) {
      const folderService = (await import("./folder.service")).default;
      await folderService.updateFileCount(file.folder_id);
    }

    return file;
  }

  async deleteMultipleFiles(ids: string[]): Promise<{ deletedCount: number }> {
    // Get files before deletion to know which folders to update and file names for parquet deletion
    const files = await fileRepository.findMany({ _id: { $in: ids } as any });
    const folderIds = [
      ...new Set(files.map((f: IFile) => f.folder_id).filter((id) => id)),
    ];
    const fileNames = files.map((f: IFile) => f.name);

    const deletedCount = await fileRepository.deleteMultiple(ids);

    // Delete related embeddings and parquets from AI database
    if (ids.length > 0) {
      try {
        const aiService = (await import("./ai.service")).default;

        // Delete embeddings for each file from the AI vector store
        for (const id of ids) {
          await aiService.deleteEmbeddingByFileId(id);
        }

        // Delete tabular parquet data, grouped by folder (parquets are keyed
        // by folder_id + file_name in the AI service's Postgres store).
        const namesByFolder = new Map<string, string[]>();
        for (const f of files) {
          if (!f.folder_id) continue;
          const arr = namesByFolder.get(f.folder_id) ?? [];
          arr.push(f.name);
          namesByFolder.set(f.folder_id, arr);
        }
        for (const [folderId, names] of namesByFolder) {
          await aiService.deleteParquetsByFolder(folderId, names);
        }
      } catch (error) {
        logger.error("Error deleting embedding/parquet records:", error);
        // Don't fail the file deletion if AI database cleanup fails
      }
    }

    // Update folder counts for affected folders
    const folderService = (await import("./folder.service")).default;
    for (const folderId of folderIds) {
      await folderService.updateFileCount(folderId);
    }

    return { deletedCount };
  }

  async deleteFilesByFolder(folderId: string): Promise<void> {
    // Collect file IDs before deletion for embedding cleanup
    const files = await fileRepository.findByFolderId(folderId);

    await fileRepository.deleteByFolderId(folderId);

    // Delete related embeddings + tabular parquet data from the AI service
    if (files.length > 0) {
      try {
        const aiService = (await import("./ai.service")).default;
        for (const file of files) {
          const fileId = ((file as any)._id || file.id).toString();
          await aiService.deleteEmbeddingByFileId(fileId);
        }
        // Clear all tabular parquet data for the folder in one call.
        await aiService.deleteParquetsByFolder(folderId);
      } catch (error) {
        logger.error(
          "Error deleting embedding/parquet records for folder:",
          error,
        );
        // Don't fail the folder cleanup if AI cleanup fails
      }
    }

    // Update folder file count (should be 0 now)
    const folderService = (await import("./folder.service")).default;
    await folderService.updateFileCount(folderId);
  }

  async uploadFile(file: any, metadata: any): Promise<any> {
    // Validate required metadata fields
    if (!metadata.organization_id) {
      throw new Error("organization_id is required");
    }
    if (!metadata.last_updated_by) {
      throw new Error("last_updated_by is required");
    }
    if (!metadata.folder_id) {
      throw new Error("folder_id is required");
    }

    // Upload to fs service — stream from disk if path available, otherwise use buffer
    const NodeFormData = (await import("form-data")).default;
    const fsFormData = new NodeFormData();
    if (file.path) {
      const { createReadStream } = await import("fs");
      fsFormData.append("file", createReadStream(file.path), {
        filename: file.originalname,
        contentType: file.mimetype,
        knownLength: file.size,
      });
    } else {
      fsFormData.append("file", Buffer.from(file.buffer), {
        filename: file.originalname,
        contentType: file.mimetype,
        knownLength: file.size,
      });
    }

    const axios = (await import("axios")).default;
    const fsAxiosResponse = await axios.post(`${this.fsServiceUrl}/upload`, fsFormData, {
      headers: fsFormData.getHeaders(),
    });

    if (fsAxiosResponse.status < 200 || fsAxiosResponse.status >= 300) {
      throw new Error("Failed to upload file to fs service");
    }

    const fsResult = fsAxiosResponse.data;

    // Parse last_updated_by if it's a JSON string
    let lastUpdatedBy = metadata.last_updated_by;
    if (typeof lastUpdatedBy === "string") {
      try {
        lastUpdatedBy = JSON.parse(lastUpdatedBy);
      } catch (error) {
        throw new Error("Invalid last_updated_by format");
      }
    }

    // Save metadata to DB
    const fileData = {
      name: file.originalname,
      organization_id: metadata.organization_id,
      tags: metadata.tags || undefined, // Array of tags
      remarks: metadata.remarks,
      last_updated_by: lastUpdatedBy,
      source_type: metadata.source_type || "upload",
      key: fsResult.data.key || fsResult.data.Key || fsResult.data.name,

      folder_id: metadata.folder_id,
      file_type: file.mimetype,
      file_size: file.size,
    };

    const savedFile = await this.createFile(fileData);

    // Create ingestion job for embedding — return immediately without waiting
    await ingestionJobRepository.create({
      fileId: String(savedFile._id),
    });

    return savedFile;
  }

  async uploadMultipleFiles(files: any[], metadata: any): Promise<any[]> {
    // Validate required metadata fields
    if (!metadata.organization_id) {
      throw new Error("organization_id is required");
    }
    if (!metadata.last_updated_by) {
      throw new Error("last_updated_by is required");
    }
    if (!metadata.folder_id) {
      throw new Error("folder_id is required");
    }

    // Parse last_updated_by if it's a JSON string
    let lastUpdatedBy = metadata.last_updated_by;
    if (typeof lastUpdatedBy === "string") {
      try {
        lastUpdatedBy = JSON.parse(lastUpdatedBy);
      } catch (error) {
        throw new Error("Invalid last_updated_by format");
      }
    }

    // === Check if file_url is provided (new URL-based upload) ===
    if (metadata.file_url) {
      return await this._uploadMultipleFromUrl(metadata, lastUpdatedBy);
    }

    // === Validate files array (for traditional upload) ===
    if (!files || !Array.isArray(files) || files.length === 0) {
      throw new Error("No files provided for upload");
    }

    // Upload all files concurrently
    const uploadPromises = files.map(async (file) => {
      // Prepare fs upload
      const fsFormData = new FormData();
      fsFormData.append(
        "file",
        new Blob([file.buffer], { type: file.mimetype }),
        file.originalname,
      );

      // Upload to fs service
      const fsResponse = await fetch(`${this.fsServiceUrl}/upload`, {
        method: "POST",
        body: fsFormData,
      });

      if (!fsResponse.ok) {
        throw new Error(
          `Failed to upload file ${file.originalname} to fs service`,
        );
      }

      const fsResult = await fsResponse.json();

      // Save metadata to DB
      const fileData = {
        name: file.originalname,
        organization_id: metadata.organization_id,
        tags: metadata.tags || undefined, // Array of tags
        remarks: metadata.remarks,
        last_updated_by: lastUpdatedBy,
        source_type: metadata.source_type || "upload",
        key: fsResult.data.key || fsResult.data.Key,
        folder_id: metadata.folder_id,
        file_type: file.mimetype,
        file_size: file.size,
      };

      const savedFile = await this.createFile(fileData);

      // Create ingestion job for embedding processing
      await ingestionJobRepository.create({
        fileId: String(savedFile._id),
      });

      return savedFile;
    });

    // Wait for all uploads to complete
    return await Promise.all(uploadPromises);
  }

  // Private helper method to upload file from URL (for general file uploads)
  private async _uploadMultipleFromUrl(
    metadata: any,
    lastUpdatedBy: any,
  ): Promise<any[]> {
    const fileUrl = metadata.file_url;

    try {
      // --- Download file from URL ---
      const fileResponse = await fetch(fileUrl);

      if (!fileResponse.ok) {
        throw new Error(
          `Failed to download file from URL: ${fileResponse.status} ${fileResponse.statusText}`,
        );
      }

      // --- Get file buffer and metadata ---
      const fileBuffer = await fileResponse.arrayBuffer();
      const contentType =
        fileResponse.headers.get("content-type") || "application/octet-stream";

      // Extract filename from URL
      const urlParts = fileUrl.split("/");
      const filenameWithQuery = urlParts[urlParts.length - 1];
      const filename = filenameWithQuery.split("?")[0] || "document.pdf";

      // --- Prepare form data for upload to FS service ---
      const fsFormData = new FormData();
      fsFormData.append(
        "file",
        new Blob([fileBuffer], { type: contentType }),
        filename,
      );

      // --- Upload to FS service ---
      const fsResponse = await fetch(`${this.fsServiceUrl}/upload`, {
        method: "POST",
        body: fsFormData,
      });

      if (!fsResponse.ok) {
        throw new Error(`Failed to upload file "${filename}" to FS service`);
      }

      const fsResult = await fsResponse.json();

      // --- Save metadata to DB ---
      const fileData = {
        name: filename,
        organization_id: metadata.organization_id,
        tags: metadata.tags || undefined, // Array of tags
        remarks: metadata.remarks,
        last_updated_by: lastUpdatedBy,
        source_type: metadata.source_type || "upload",
        key: fsResult.data.key || fsResult.data.Key,
        folder_id: metadata.folder_id,
        file_type: contentType,
        file_size: fileBuffer.byteLength,
      };

      const savedFile = await this.createFile(fileData);

      // Create ingestion job for embedding processing
      await ingestionJobRepository.create({
        fileId: String(savedFile._id),
      });

      return [savedFile];
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to process file from URL: ${error.message}`);
      }
      throw error;
    }
  }

  async downloadFile(
    key: string,
  ): Promise<{ buffer: ArrayBuffer; headers: Headers }> {
    // Proxy download request to fs service
    const response = await fetch(
      `${this.fsServiceUrl}/download/${encodeURIComponent(key)}`,
    );
    if (!response.ok) {
      throw new Error("Failed to download file from fs service");
    }
    const buffer = await response.arrayBuffer();
    return { buffer, headers: response.headers };
  }

  async generatePresignedUrls(keys: string[]): Promise<Record<string, string>> {
    if (!keys || keys.length === 0) {
      return {};
    }

    const response = await fetch(
      `${this.fsServiceUrl}/presigned-urls?validateExistence=true`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          keys: keys,
        }),
      },
    );

    if (!response.ok) {
      throw new Error("Failed to generate presigned URLs from fs service");
    }

    const result = await response.json();
    return result.urls || {};
  }

  generatePresignedUrl(key: string): string {
    // Generate a direct access URL for the frontend
    return `${this.appGatewayHost}/files/download/${encodeURIComponent(key)}`;
  }

  isImageFile(fileType: string): boolean {
    const imageTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/svg+xml",
    ];
    return imageTypes.includes(fileType.toLowerCase());
  }

  isOfficeDocument(fileType: string): boolean {
    const officeTypes = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
      "application/vnd.ms-excel", // .xls
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
      "application/msword", // .doc
      "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
      "application/vnd.ms-powerpoint", // .ppt
    ];
    return officeTypes.includes(fileType.toLowerCase());
  }

  generateOfficeProxyUrl(presignedUrl: string): string {
    // Generate a proxy URL for Office Online viewing
    return `${
      this.appGatewayHost
    }/files/proxy/external?url=${encodeURIComponent(presignedUrl)}`;
  }

  async createBoardFileUpload(
    fileData: Partial<IBoardUploadFile>,
  ): Promise<IBoardUploadFile> {
    const file = new BoardUploadFile(fileData);
    return await file.save();
  }

  async proxyExternalUrl(
    url: string,
  ): Promise<{ buffer: ArrayBuffer; contentType: string; filename: string }> {
    // Fetch the file from the external URL
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Failed to fetch file from external URL: ${response.status} ${response.statusText}`,
      );
    }

    const buffer = await response.arrayBuffer();
    const contentType =
      response.headers.get("content-type") || "application/octet-stream";

    // Extract filename from URL or use a default
    const urlParts = url.split("/");
    const filename =
      urlParts[urlParts.length - 1].split("?")[0] || "document.xlsx";

    return { buffer, contentType, filename };
  }
  // Upload multi files to board-fileupload
  async uploadMultiFiles(
    files: any[],
    metadata: any,
  ): Promise<IBoardUploadFile[]> {
    // === Validate metadata ===
    if (!metadata.organization_id) {
      throw new Error("organization_id is required");
    }
    if (!metadata.board_id) {
      throw new Error("board_id is required");
    }
    if (!metadata.last_updated_by) {
      throw new Error("last_updated_by is required");
    }

    // === Parse last_updated_by safely ===
    let lastUpdatedBy = metadata.last_updated_by;
    if (typeof lastUpdatedBy === "string") {
      try {
        lastUpdatedBy = JSON.parse(lastUpdatedBy);
      } catch (error) {
        throw new Error("Invalid last_updated_by format");
      }
    }

    // === Check if file_url is provided (new URL-based upload) ===
    if (metadata.file_url) {
      return await this._uploadFromUrl(metadata, lastUpdatedBy);
    }

    // === Validate files array (for traditional upload) ===
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error("At least one file must be provided");
    }

    // === Allowed file types ===
    const allowedMimeTypes = [
      "text/csv",
      "application/pdf",
      "application/vnd.ms-excel", // .xls
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
    ];

    const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
    const uploadedFiles: IBoardUploadFile[] = [];

    // === Process each file individually ===
    for (const file of files) {
      if (!file || !file.buffer) {
        throw new Error("Invalid file format");
      }

      // --- Validate size ---
      if (file.size > MAX_FILE_SIZE) {
        throw new Error(
          `File "${file.originalname}" exceeds 20MB limit (got ${(
            file.size /
            (1024 * 1024)
          ).toFixed(2)}MB)`,
        );
      }

      // --- Validate file type ---
      if (!allowedMimeTypes.includes(file.mimetype)) {
        throw new Error(
          `File "${file.originalname}" has unsupported type "${file.mimetype}". Only CSV, Excel, and PDF are allowed.`,
        );
      }

      // --- Prepare form data for upload ---
      const fsFormData = new FormData();
      fsFormData.append(
        "file",
        new Blob([file.buffer], { type: file.mimetype }),
        file.originalname,
      );

      // --- Upload to FS service ---
      const fsResponse = await fetch(`${this.fsServiceUrl}/upload`, {
        method: "POST",
        body: fsFormData,
      });

      if (!fsResponse.ok) {
        throw new Error(
          `Failed to upload file "${file.originalname}" to FS service`,
        );
      }

      const fsResult = await fsResponse.json();

      // --- Save metadata to DB ---
      const fileData = {
        name: file.originalname,
        organization_id: metadata.organization_id,
        board_id: metadata.board_id,
        last_updated_by: lastUpdatedBy,
        key: fsResult.data.key,
        file_type: file.mimetype,
        file_size: file.size,
      };

      const savedFile = await this.createBoardFileUpload(fileData);
      uploadedFiles.push(savedFile);
    }

    return uploadedFiles;
  }

  // Private helper method to upload file from URL
  private async _uploadFromUrl(
    metadata: any,
    lastUpdatedBy: any,
  ): Promise<IBoardUploadFile[]> {
    const fileUrl = metadata.file_url;

    // === Allowed file types ===
    const allowedMimeTypes = [
      "text/csv",
      "application/pdf",
      "application/vnd.ms-excel", // .xls
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
    ];

    const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

    try {
      // --- Download file from URL ---
      const fileResponse = await fetch(fileUrl);

      if (!fileResponse.ok) {
        throw new Error(
          `Failed to download file from URL: ${fileResponse.status} ${fileResponse.statusText}`,
        );
      }

      // --- Get file buffer and metadata ---
      const fileBuffer = await fileResponse.arrayBuffer();
      const contentType =
        fileResponse.headers.get("content-type") || "application/octet-stream";

      // Extract filename from URL
      const urlParts = fileUrl.split("/");
      const filenameWithQuery = urlParts[urlParts.length - 1];
      const filename = filenameWithQuery.split("?")[0] || "document.pdf";

      // --- Validate file size ---
      if (fileBuffer.byteLength > MAX_FILE_SIZE) {
        throw new Error(
          `File "${filename}" exceeds 20MB limit (got ${(
            fileBuffer.byteLength /
            (1024 * 1024)
          ).toFixed(2)}MB)`,
        );
      }

      // --- Validate file type ---
      if (!allowedMimeTypes.includes(contentType)) {
        throw new Error(
          `File "${filename}" has unsupported type "${contentType}". Only CSV, Excel, and PDF are allowed.`,
        );
      }

      // --- Prepare form data for upload to FS service ---
      const fsFormData = new FormData();
      fsFormData.append(
        "file",
        new Blob([fileBuffer], { type: contentType }),
        filename,
      );

      // --- Upload to FS service ---
      const fsResponse = await fetch(`${this.fsServiceUrl}/upload`, {
        method: "POST",
        body: fsFormData,
      });

      if (!fsResponse.ok) {
        throw new Error(`Failed to upload file "${filename}" to FS service`);
      }

      const fsResult = await fsResponse.json();

      // --- Save metadata to DB ---
      const fileData = {
        name: filename,
        organization_id: metadata.organization_id,
        board_id: metadata.board_id,
        last_updated_by: lastUpdatedBy,
        key: fsResult.data.key,
        file_type: contentType,
        file_size: fileBuffer.byteLength,
      };

      const savedFile = await this.createBoardFileUpload(fileData);
      return [savedFile];
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to process file from URL: ${error.message}`);
      }
      throw error;
    }
  }

  async detectBoardFieldsFromFiles(metadata: any) {
    // === Validate metadata ===
    if (!metadata.org_id) {
      throw new Error("organization_id is required");
    }

    if (!metadata.board_id) {
      throw new Error("board_id is required");
    }

    if (!metadata.files) {
      throw new Error("files are required");
    }

    const dectectedFiles = await fetch(
      `${this.aiServiceUrl}/databoard/detect-fields`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          org_id: metadata.org_id,
          board_id: metadata.board_id,
          files: metadata.files,
        }),
      },
    );

    if (!dectectedFiles.ok) {
      throw new Error("Failed to detect files to board via AI service");
    }

    const result = await dectectedFiles.json();
    return result;
  }

  async previewDataboard(metadata: any) {
    // === Validate metadata ===
    if (!metadata.org_id) {
      throw new Error("org_id is required");
    }

    if (!metadata.board_id) {
      throw new Error("board_id is required");
    }

    if (!metadata.files) {
      throw new Error("files are required");
    }

    const mergePreviewResponse = await fetch(
      `${this.aiServiceUrl}/databoard/merge-preview`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          org_id: metadata.org_id,
          board_id: metadata.board_id,
          files: metadata.files,
        }),
      },
    );

    if (!mergePreviewResponse.ok) {
      throw new Error("Failed to merge preview via AI service");
    }

    const result = await mergePreviewResponse.json();
    return result;
  }

  async importAIToDataboard(metadata: any) {
    // === Validate metadata ===
    if (!metadata.org_id) {
      throw new Error("org_id is required");
    }

    if (!metadata.board_id) {
      throw new Error("board_id is required");
    }

    if (!metadata.files) {
      throw new Error("files are required");
    }

    const mergePreviewResponse = await fetch(
      `${this.aiServiceUrl}/databoard/ai-import-databoard`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          org_id: metadata.org_id,
          board_id: metadata.board_id,
          files: metadata.files,
        }),
      },
    );

    if (!mergePreviewResponse.ok) {
      throw new Error("Failed to merge preview via AI service");
    }

    const result = await mergePreviewResponse.json();
    return result;
  }

  async getBoardFileUploads(metadata: any) {
    // === Validate metadata ===
    if (!metadata.org_id) {
      throw new Error("org_id is required");
    }

    if (!metadata.board_id) {
      throw new Error("board_id is required");
    }

    const mergePreviewResponse = await BoardUploadFile.find({
      organization_id: metadata.org_id,
      board_id: metadata.board_id,
    });

    if (!mergePreviewResponse) {
      throw new Error("Failed to retrieve board file uploads");
    }

    return mergePreviewResponse;
  }
}

export default new FileService();
