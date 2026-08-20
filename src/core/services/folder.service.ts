import { IFolder, FolderSourceType } from "../../db/models/folder.model";
import { folderRepository } from "../../infrastructure/database/repositories/folder.repository";
import { fileRepository } from "../../infrastructure/database/repositories/file.repository";
import logger from "../utils/logger";
import { NotFoundError } from "../utils/errors";

class FolderService {
  async createFolder(folderData: Partial<IFolder>): Promise<IFolder> {
    // Build path from parent folder path + current folder name
    if (folderData.parent_folder_id && folderData.parent_folder_id !== "root") {
      const parentFolder = await this.getFolderById(
        folderData.parent_folder_id,
      );
      if (parentFolder) {
        folderData.path = `${parentFolder.path}/${folderData.name}`;
      } else {
        throw new Error("Parent folder not found");
      }
    } else {
      // Root level folder
      folderData.path = `/${folderData.name}`;
    }

    return await folderRepository.create(folderData);
  }

  async getAllFolders(ignoreAssistant: boolean = false): Promise<IFolder[]> {
    const query: any = {};
    if (ignoreAssistant) {
      query.source_type = { $ne: "assistant" };
    }
    const folders = await folderRepository.findMany(query);

    // Calculate and populate file_count for each folder (includes all files in subfolders)
    const foldersWithCounts = await Promise.all(
      folders.map(async (folder) => {
        const id = (folder as any)._id || folder.id;
        const totalFileCount = await this.calculateTotalFileCount(
          id.toString(),
        );
        // Update the folder object with the calculated count
        let folderObj: any;
        if (typeof (folder as any).toObject === "function") {
          folderObj = (folder as any).toObject();
        } else {
          folderObj = { ...folder };
        }
        folderObj.file_count = totalFileCount;
        return folderObj;
      }),
    );

    return foldersWithCounts as IFolder[];
  }

  async getFolderById(id: string): Promise<IFolder | null> {
    return await folderRepository.findById(id);
  }

  /**
   * Resolve a folder for an upload by id, creating it if it does not exist.
   *
   * - Existing folder in the same organization -> returned as-is.
   * - Existing folder in a different organization -> NotFoundError (404),
   *   hiding cross-tenant existence.
   * - No folder -> a new folder is created using the given id, named after the
   *   given name (falling back to the id), at the organization root.
   */
  async ensureFolder(
    folderId: string,
    organizationId: string,
    name?: string,
  ): Promise<IFolder> {
    const existing = await this.getFolderById(folderId);

    if (existing) {
      if (existing.organization_id !== organizationId) {
        throw new NotFoundError("Folder not found");
      }
      return existing;
    }

    const folderName = name?.trim() || folderId;

    return await this.createFolder({
      _id: folderId,
      name: folderName,
      organization_id: organizationId,
      parent_folder_id: "root",
      source_type: FolderSourceType.UPLOAD,
    } as Partial<IFolder>);
  }

  /**
   * Get a folder and all its subfolders by parent folder ID,
   * including file names for each folder and total file counts.
   *
   * Performance optimizations:
   * - Collects all folder IDs first, then batch-queries file names & counts in 2 queries
   * - Uses projection (name + folder_id only) to avoid loading full file documents
   * - Uses $in operator for batch counting instead of N+1 per-folder queries
   * - Returns minimal payload suitable for AI agent consumption
   */
  async getFolderWithSubfolders(
    parentFolderId: string,
    recursive: boolean = false,
    ignoreAssistant: boolean = false,
  ): Promise<{
    folder: {
      id: string;
      name: string;
      path: string;
      parent_folder_id: string;
      file_count: number;
      files: string[];
    };
    subfolders: {
      id: string;
      name: string;
      path: string;
      parent_folder_id: string;
      file_count: number;
      files: string[];
    }[];
    total_files: number;
  } | null> {
    const folder = await this.getFolderById(parentFolderId);
    if (!folder) {
      return null;
    }

    let subfolders: IFolder[];
    if (recursive) {
      subfolders = await this.getAllSubfoldersRecursive(parentFolderId);
    } else {
      subfolders = await this.getSubfolders(parentFolderId, ignoreAssistant);
    }

    if (ignoreAssistant && recursive) {
      subfolders = subfolders.filter(
        (f: IFolder) => f.source_type !== "assistant",
      );
    }

    // Collect all folder IDs (parent + subfolders) for batch queries
    const allFolderIds = [
      parentFolderId,
      ...subfolders.map((sf: any) => ((sf as any)._id || sf.id).toString()),
    ];

    // Batch query: get file projection (id, name, remarks, folder_id) for ALL folders in one query
    const allFileEntries =
      await fileRepository.findNamesByFolderIds(allFolderIds);

    // Group files by folder_id using a Map for O(1) lookups
    const filesByFolderId = new Map<string, { id: string; name: string; remarks?: string }[]>();
    for (const entry of allFileEntries) {
      const fid = entry.folder_id.toString();
      if (!filesByFolderId.has(fid)) {
        filesByFolderId.set(fid, []);
      }
      filesByFolderId.get(fid)!.push({ id: entry._id.toString(), name: entry.name, remarks: entry.remarks });
    }

    // Build minimal parent folder result
    const folderResult = this.buildMinimalFolder(folder, filesByFolderId);

    // Build minimal subfolder results
    const subfoldersResult = subfolders.map((subfolder) =>
      this.buildMinimalFolder(subfolder, filesByFolderId),
    );

    // Total files across parent folder and all subfolders
    const totalFiles = allFileEntries.length;

    return {
      folder: folderResult,
      subfolders: subfoldersResult,
      total_files: totalFiles,
    };
  }

  /**
   * Minimal folder shape returned by batch queries (for AI agent consumption)
   */
  private buildMinimalFolder(
    folder: IFolder,
    filesByFolderId: Map<string, { id: string; name: string; remarks?: string }[]>,
  ) {
    const folderId = ((folder as any)._id || folder.id).toString();
    const files = filesByFolderId.get(folderId) || [];
    return {
      id: folderId,
      name: folder.name,
      path: folder.path,
      parent_folder_id: folder.parent_folder_id,
      file_count: files.length,
      files,
    };
  }

  /**
   * Get multiple folders and all their subfolders by an array of parent folder IDs.
   * Optimised for batch: collects ALL folder IDs across every parent, then does
   * a single file-name projection query for the entire set.
   */
  async getFoldersWithSubfolders(
    parentFolderIds: string[],
    recursive: boolean = false,
    ignoreAssistant: boolean = false,
  ): Promise<{
    folders: {
      id: string;
      name: string;
      path: string;
      parent_folder_id: string;
      file_count: number;
      files: string[];
      subfolders: {
        id: string;
        name: string;
        path: string;
        parent_folder_id: string;
        file_count: number;
        files: string[];
      }[];
    }[];
    total_files: number;
  }> {
    // 1. Fetch all requested parent folders in parallel
    const parentFolders = await Promise.all(
      parentFolderIds.map((id) => this.getFolderById(id)),
    );

    // 2. For each found parent, collect its subfolders in parallel
    const perParentSubfolders = await Promise.all(
      parentFolders.map(async (folder, idx) => {
        if (!folder) return null;
        let subs: IFolder[];
        if (recursive) {
          subs = await this.getAllSubfoldersRecursive(parentFolderIds[idx]);
        } else {
          subs = await this.getSubfolders(parentFolderIds[idx], ignoreAssistant);
        }
        if (ignoreAssistant && recursive) {
          subs = subs.filter((f) => f.source_type !== "assistant");
        }
        return { folder, subfolders: subs };
      }),
    );

    // 3. Collect every folder ID (parents + all subfolders) for a single batch file query
    const allFolderIds: string[] = [];
    for (const entry of perParentSubfolders) {
      if (!entry) continue;
      const parentId = ((entry.folder as any)._id || entry.folder.id).toString();
      allFolderIds.push(parentId);
      for (const sf of entry.subfolders) {
        allFolderIds.push(((sf as any)._id || sf.id).toString());
      }
    }

    // 4. Single batch query: file projection (id, name, remarks, folder_id) for ALL folders
    const allFileEntries =
      allFolderIds.length > 0
        ? await fileRepository.findNamesByFolderIds(allFolderIds)
        : [];

    // 5. Group files by folder_id
    const filesByFolderId = new Map<string, { id: string; name: string; remarks?: string }[]>();
    for (const entry of allFileEntries) {
      const fid = entry.folder_id.toString();
      if (!filesByFolderId.has(fid)) {
        filesByFolderId.set(fid, []);
      }
      filesByFolderId.get(fid)!.push({ id: entry._id.toString(), name: entry.name, remarks: entry.remarks });
    }

    // 6. Build the response per parent folder
    const folders = perParentSubfolders
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .map((entry) => {
        const parentResult = this.buildMinimalFolder(entry.folder, filesByFolderId);
        const subfoldersResult = entry.subfolders.map((sf) =>
          this.buildMinimalFolder(sf, filesByFolderId),
        );
        return {
          ...parentResult,
          subfolders: subfoldersResult,
        };
      });

    return {
      folders,
      total_files: allFileEntries.length,
    };
  }

  async updateFolder(
    id: string,
    updateData: Partial<IFolder>,
  ): Promise<IFolder | null> {
    // If name is being updated, rebuild the path
    if (updateData.name) {
      const currentFolder = await this.getFolderById(id);
      if (currentFolder) {
        if (
          currentFolder.parent_folder_id &&
          currentFolder.parent_folder_id !== "root"
        ) {
          const parentFolder = await this.getFolderById(
            currentFolder.parent_folder_id,
          );
          if (parentFolder) {
            updateData.path = `${parentFolder.path}/${updateData.name}`;
          }
        } else {
          // Root level folder
          updateData.path = `/${updateData.name}`;
        }
      }
    }

    return await folderRepository.update(id, updateData);
  }

  async deleteFolder(id: string): Promise<IFolder | null> {
    const folder = await this.getFolderById(id);
    if (!folder) return null;

    // Get all subfolders recursively
    const allSubfolders = await this.getAllSubfoldersRecursive(id);
    const allFolderIds = [
      id,
      ...allSubfolders.map((sf: any) => (sf._id || sf.id).toString()),
    ];

    // Delete files in all folders (including subfolders), with embedding cleanup
    const fileService = (await import("./file.service")).default;
    for (const subfolder of allSubfolders) {
      const subId = (subfolder as any)._id || subfolder.id;
      await fileService.deleteFilesByFolder(subId.toString());
    }
    await fileService.deleteFilesByFolder(id);

    // Check and clear AI assistants that use this folder as default_folder_id
    try {
      const aiMongoDB = (await import("../../db/ai-mongodb")).default;

      // Check all folders being deleted (including subfolders)
      for (const folderId of allFolderIds) {
        // Find assistants using this folder
        const assistants =
          await aiMongoDB.findAssistantsByDefaultFolder(folderId);

        if (assistants.length > 0) {
          logger.info(
            `Found ${assistants.length} assistant(s) using folder ${folderId} as default_folder_id`,
          );
          logger.info(
            `Assistant IDs: ${assistants.map((a: any) => a._id || a.id).join(", ")}`,
          );

          // Clear the default_folder_id for these assistants
          const updatedCount =
            await aiMongoDB.clearDefaultFolderForAssistants(folderId);
          logger.info(
            `Cleared default_folder_id for ${updatedCount} assistant(s) that were using folder: ${folderId}`,
          );
        }
      }
    } catch (error) {
      logger.error("Error updating AI assistants for folders:", error);
      // Don't fail the folder deletion if assistant update fails
    }

    // Delete rag embeddings for all folders being deleted
    try {
      const aiMongoDB = (await import("../../db/ai-mongodb")).default;
      for (const folderId of allFolderIds) {
        const deletedEmbeddings = await aiMongoDB.deleteEmbeddingsByFolderId(folderId);
        logger.info(`Deleted ${deletedEmbeddings} embedding records for folder: ${folderId}`);
      }
    } catch (error) {
      logger.error("Error deleting embedding records for folders:", error);
    }

    // Delete related parquets from AI database for all folders being deleted
    try {
      const aiMongoDB = (await import("../../db/ai-mongodb")).default;
      for (const folderId of allFolderIds) {
        const deletedParquets =
          await aiMongoDB.deleteParquetsByFolderId(folderId);
        logger.info(
          `Deleted ${deletedParquets} parquet records for folder: ${folderId}`,
        );
      }
    } catch (error) {
      logger.error("Error deleting parquet records for folders:", error);
      // Don't fail the folder deletion if parquet deletion fails
    }

    // Delete all subfolders
    for (const subfolder of allSubfolders) {
      const subId = (subfolder as any)._id || subfolder.id;
      await folderRepository.delete(subId.toString());
    }

    // Finally delete the main folder
    await folderRepository.delete(id);

    // Update parent folder count after deletion
    if (folder.parent_folder_id && folder.parent_folder_id !== "root") {
      await this.updateFileCount(folder.parent_folder_id);
    }

    return folder;
  }

  async deleteMultipleFolders(
    ids: string[],
  ): Promise<{ deletedCount: number }> {
    let deletedCount = 0;
    for (const id of ids) {
      const result = await this.deleteFolder(id);
      if (result) {
        deletedCount++;
      }
    }
    return { deletedCount };
  }

  async getFoldersByOrganization(
    organization_id: string,
    ignoreAssistant: boolean = false,
  ): Promise<IFolder[]> {
    const query: any = { organization_id };
    if (ignoreAssistant) {
      query.source_type = { $ne: "assistant" };
    }
    const folders = await folderRepository.findMany(query);

    // Calculate and populate file_count for each folder (includes all files in subfolders)
    const foldersWithCounts = await Promise.all(
      folders.map(async (folder) => {
        const id = (folder as any)._id || folder.id;
        const totalFileCount = await this.calculateTotalFileCount(
          id.toString(),
        );
        // Update the folder object with the calculated count
        let folderObj: any;
        if (typeof (folder as any).toObject === "function") {
          folderObj = (folder as any).toObject();
        } else {
          folderObj = { ...folder };
        }
        folderObj.file_count = totalFileCount;
        return folderObj;
      }),
    );

    return foldersWithCounts as IFolder[];
  }

  async searchFolders(
    query: string,
    organization_id?: string,
    limit?: number,
    ignoreAssistant: boolean = false,
  ): Promise<IFolder[]> {
    // Repository search handles name regex. For multi-field search we might need to enhance repository
    // But basic name search is supported by repository.search
    // Current Repo search only searches name. The original code searched name OR description OR tags.
    // We should fallback to findMany with complex query if supported, or rely on what repo provides.
    // The MongoAdapter supports Mongoose syntax in findMany/whereClause.
    // So we can pass the $or query to findMany.

    const searchQuery: any = {
      $or: [
        { name: { $regex: query, $options: "i" } },
        { description: { $regex: query, $options: "i" } },
        { tags: { $regex: query, $options: "i" } },
      ],
    };

    if (organization_id) {
      searchQuery.organization_id = organization_id;
    }

    if (ignoreAssistant) {
      searchQuery.source_type = { $ne: "assistant" };
    }

    // Use findMany with limits
    const folders = await folderRepository.findMany(
      searchQuery,
      limit ? { limit } : undefined,
    );

    // Calculate and populate file_count for each folder (includes all files in subfolders)
    const foldersWithCounts = await Promise.all(
      folders.map(async (folder) => {
        const id = (folder as any)._id || folder.id;
        const totalFileCount = await this.calculateTotalFileCount(
          id.toString(),
        );
        let folderObj: any;
        if (typeof (folder as any).toObject === "function") {
          folderObj = (folder as any).toObject();
        } else {
          folderObj = { ...folder };
        }
        folderObj.file_count = totalFileCount;
        return folderObj;
      }),
    );

    return foldersWithCounts as IFolder[];
  }

  async getSubfolders(
    parent_folder_id: string,
    ignoreAssistant: boolean = false,
    skip?: number,
    limit?: number,
    sortBy?: string,
    sortOrder?: "asc" | "desc",
  ): Promise<IFolder[]> {
    const query: any = { parent_folder_id };
    if (ignoreAssistant) {
      query.source_type = { $ne: "assistant" };
    }

    const options: any = {};
    if (skip !== undefined) options.skip = skip;
    if (limit !== undefined) options.limit = limit;

    // Apply sorting via options
    if (sortBy) {
      const direction = sortOrder || "asc";
      options.orderBy = [{ field: sortBy, direction }];

      // Map common sort fields to actual field names
      switch (sortBy) {
        case "last_updated_time":
          options.orderBy[0].field = "updated_at";
          break;
        case "created_time":
          options.orderBy[0].field = "created_at";
          break;
      }
    }

    const folders = await folderRepository.findMany(query, options);

    // Calculate and populate file_count
    const foldersWithCounts = await Promise.all(
      folders.map(async (folder) => {
        const id = (folder as any)._id || folder.id;
        const totalFileCount = await this.calculateTotalFileCount(
          id.toString(),
        );
        let folderObj: any;
        if (typeof (folder as any).toObject === "function") {
          folderObj = (folder as any).toObject();
        } else {
          folderObj = { ...folder };
        }
        folderObj.file_count = totalFileCount;
        return folderObj;
      }),
    );

    return foldersWithCounts as IFolder[];
  }

  async getFilesInFolder(
    folder_id: string,
    skip: number = 0,
    limit?: number,
    sortBy?: string,
    sortOrder?: "asc" | "desc",
  ) {
    // Already using fileRepository via fileService, but we can call fileRepository directly for cleaner deps?
    // The original code called fileService.getFilesByFolder which we refactored to use repository.
    // So this method is safe as is, but we can remove the lazy import of fileService if we want.
    // Let's stick to using fileRepository directly for consistency in this file.

    // Re-implementing logic with fileRepository
    const options: any = { skip };
    if (limit) options.limit = limit;

    if (sortBy) {
      options.orderBy = [{ field: sortBy, direction: sortOrder || "asc" }];
      if (sortBy === "last_updated_time")
        options.orderBy[0].field = "updated_at";
      if (sortBy === "created_time") options.orderBy[0].field = "created_at";
    } else {
      options.orderBy = [{ field: "updated_at", direction: "desc" }];
    }

    return await fileRepository.findByFolderId(folder_id, options);
  }

  async searchFilesInFolder(
    folder_id: string,
    searchQuery: string,
    skip: number = 0,
    limit?: number,
    sortBy?: string,
    sortOrder?: "asc" | "desc",
  ) {
    // Refactored to use fileRepository
    // fileRepository actually has searchInFolder method!

    // Map sorting options
    // The repository method might not take full sort options yet looking at interface, let's look at schema
    // FileRepository.searchInFolder(folderId, query, options)

    const options: any = { skip };
    if (limit) options.limit = limit;

    if (sortBy) {
      options.orderBy = [{ field: sortBy, direction: sortOrder || "asc" }];
      if (sortBy === "last_updated_time")
        options.orderBy[0].field = "updated_at";
      if (sortBy === "created_time") options.orderBy[0].field = "created_at";
    }

    const files = await fileRepository.searchInFolder(
      folder_id,
      searchQuery,
      options,
    );

    logger.info(
      `Searching for "${searchQuery}" in folder ${folder_id}, found ${files.length} files by name only`,
    );
    return files;
  }

  async getFilesInFolderRecursive(
    folder_id: string,
    skip: number = 0,
    limit?: number,
    sortBy?: string,
    sortOrder?: "asc" | "desc",
  ) {
    // Get files from the current folder
    const directFiles = await this.getFilesInFolder(folder_id);
    let allFiles = [...directFiles];

    // Get all subfolders recursively
    const subfolders = await this.getAllSubfoldersRecursive(folder_id);

    // Get files from all subfolders
    for (const subfolder of subfolders) {
      const subId = (subfolder as any)._id || subfolder.id;
      const subfolderFiles = await this.getFilesInFolder(subId.toString());
      allFiles = allFiles.concat(subfolderFiles);
    }

    // Apply sorting in memory since we are merging results
    if (sortBy) {
      const sortDirection = sortOrder === "desc" ? -1 : 1;

      allFiles.sort((a: any, b: any) => {
        let aValue: any;
        let bValue: any;

        switch (sortBy) {
          case "name":
            aValue = a.name || "";
            bValue = b.name || "";
            break;
          case "tags":
            // Handle tags as string (new schema) or array (old)
            const aTags =
              typeof a.tags === "string"
                ? a.tags
                : a.tags && a.tags.length > 0
                  ? a.tags[0]
                  : "";
            const bTags =
              typeof b.tags === "string"
                ? b.tags
                : b.tags && b.tags.length > 0
                  ? b.tags[0]
                  : "";
            aValue = aTags;
            bValue = bTags;
            break;
          case "remarks":
            aValue = a.remarks || "";
            bValue = b.remarks || "";
            break;
          case "last_updated_time":
            aValue = a.updated_at ? new Date(a.updated_at).getTime() : 0;
            bValue = b.updated_at ? new Date(b.updated_at).getTime() : 0;
            break;
          case "created_time":
            aValue = a.created_at ? new Date(a.created_at).getTime() : 0;
            bValue = b.created_at ? new Date(b.created_at).getTime() : 0;
            break;
          default:
            aValue = a.name || "";
            bValue = b.name || "";
        }

        if (aValue < bValue) return -1 * sortDirection;
        if (aValue > bValue) return 1 * sortDirection;
        return 0;
      });
    }

    // Apply pagination
    const paginatedFiles = limit
      ? allFiles.slice(skip, skip + limit)
      : allFiles.slice(skip);

    return paginatedFiles;
  }

  async searchFilesInFolderRecursive(
    folder_id: string,
    searchQuery: string,
    skip: number = 0,
    limit?: number,
    sortBy?: string,
    sortOrder?: "asc" | "desc",
  ) {
    // Get all folder IDs (current folder + all subfolders)
    const subfolders = await this.getAllSubfoldersRecursive(folder_id);
    const allFolderIds = [
      folder_id,
      ...subfolders.map((sf: any) => (sf._id || sf.id).toString()),
    ];

    // Build complex query for repository
    // We need to search matching name AND in folder list
    // Repository findMany supports this via Mongo syntax { folder_id: { $in: ... }, name: regex }
    const fileRegex = new RegExp(searchQuery, "i");
    const query = {
      folder_id: { $in: allFolderIds },
      name: fileRegex,
    };

    // Sort options
    const options: any = {};
    if (sortBy) {
      options.orderBy = [{ field: sortBy, direction: sortOrder || "asc" }];
      if (sortBy === "last_updated_time")
        options.orderBy[0].field = "updated_at";
      if (sortBy === "created_time") options.orderBy[0].field = "created_at";
    }

    // We can't apply skip/limit here directly if we want to print total count before pagination?
    // Original code: await query (fetches all), then paginate manually.
    // This is inefficient but preserves original behavior.

    const allFiles = await fileRepository.findMany(query, options);

    // Apply pagination manually after fetching all results
    const paginatedFiles = limit
      ? allFiles.slice(skip, skip + limit)
      : allFiles.slice(skip);

    logger.info(
      `Recursively searching for "${searchQuery}" in folder ${folder_id} and subfolders, found ${allFiles.length} files`,
    );
    return paginatedFiles;
  }

  async getAllSubfoldersRecursive(parentId: string): Promise<IFolder[]> {
    const subfolders = await this.getSubfolders(parentId);
    let allSubfolders = [...subfolders];

    for (const subfolder of subfolders) {
      const subId = (subfolder as any)._id || subfolder.id;
      const nestedSubfolders = await this.getAllSubfoldersRecursive(
        subId.toString(),
      );
      allSubfolders = allSubfolders.concat(nestedSubfolders);
    }

    return allSubfolders;
  }

  // Calculate total file count for a folder including all subfolders recursively
  async calculateTotalFileCount(folderId: string): Promise<number> {
    // Get direct files in this folder using Repository
    const directFiles = await fileRepository.findByFolderId(folderId);
    let totalCount = directFiles.length;

    // Get all subfolders recursively
    const subfolders = await this.getAllSubfoldersRecursive(folderId);

    // Add files from all subfolders
    for (const subfolder of subfolders) {
      const subId = (subfolder as any)._id || subfolder.id;
      const subfolderFiles = await fileRepository.findByFolderId(
        subId.toString(),
      );
      totalCount += subfolderFiles.length;
    }

    return totalCount;
  }

  // Update file count for a folder and all its parent folders
  async updateFileCount(folderId: string): Promise<void> {
    // Implementation using repository updateFileCount is cleaner
    const totalCount = await this.calculateTotalFileCount(folderId);

    // Update this folder's count
    await folderRepository.updateFileCount(folderId, totalCount);

    // Update parent folders recursively
    const folder = await this.getFolderById(folderId);
    if (
      folder &&
      folder.parent_folder_id &&
      folder.parent_folder_id !== "root"
    ) {
      await this.updateFileCount(folder.parent_folder_id);
    }
  }

  // Update file counts for all folders (useful for initial setup or bulk operations)
  async updateAllFileCounts(): Promise<void> {
    const allFolders = await this.getAllFolders();

    for (const folder of allFolders) {
      const id = (folder as any)._id || folder.id;
      await this.updateFileCount(id.toString());
    }
  }

  /**
   * Export folder and its contents as a zip file
   */
  async exportFolderAsZip(
    folderId: string,
    recursive: boolean = true,
  ): Promise<Buffer> {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();

    // Get folder and validate
    const folder = await this.getFolderById(folderId);
    if (!folder) {
      throw new Error(`Folder ${folderId} not found`);
    }

    // Prepare folder metadata
    const folderMetadata: any = {
      version: "1.0",
      exported_at: new Date().toISOString(),
      folder: {
        name: folder.name,
        description: folder.description || undefined,
        tags: folder.tags || [],
        auto_tagging: folder.auto_tagging,
        source_type: folder.source_type,
      },
      subfolders: [] as any[],
    };

    // Get all subfolders if recursive
    let subfolders: IFolder[] = [];
    const folderPathMap = new Map<string, string>();
    folderPathMap.set(folderId, "");

    if (recursive) {
      subfolders = await this.getAllSubfoldersRecursive(folderId);

      // Build subfolder metadata with relative paths
      for (const subfolder of subfolders) {
        const subId = (subfolder as any)._id || subfolder.id;
        const parentId = subfolder.parent_folder_id;
        const parentPath = folderPathMap.get(parentId) || "";
        const currentPath = parentPath
          ? `${parentPath}/${subfolder.name}`
          : subfolder.name;

        folderPathMap.set(subId.toString(), currentPath);

        folderMetadata.subfolders.push({
          name: subfolder.name,
          path: currentPath,
          parent_path: parentPath,
          description: subfolder.description || undefined,
          tags: subfolder.tags || [],
          auto_tagging: subfolder.auto_tagging,
          source_type: subfolder.source_type,
        });
      }
    }

    // Add folder metadata to zip
    zip.file("metadata.json", JSON.stringify(folderMetadata, null, 2));

    // Get all files
    const allFolderIds = [
      folderId,
      ...subfolders.map((sf: any) => (sf._id || sf.id).toString()),
    ];

    const filesMetadata: any[] = [];
    const filesFolder = zip.folder("files");

    if (!filesFolder) {
      throw new Error("Failed to create files folder in zip");
    }

    // Download and add each file to zip
    for (const currentFolderId of allFolderIds) {
      const files = await fileRepository.findByFolderId(currentFolderId);

      for (const file of files) {
        try {
          // Download file from storage
          const fileService = (await import("./file.service")).default;
          const downloadResult = await fileService.downloadFile(file.key);

          // Generate unique filename using file ID and extension
          const fileExt = file.name.split(".").pop() || "bin";
          const fileId = (file as any)._id || file.id;
          const zipFileName = `${fileId}.${fileExt}`;

          // Add file to zip
          filesFolder.file(zipFileName, Buffer.from(downloadResult.buffer));

          // Add file metadata
          const fileFolderId = (file as any).folder_id;
          const folderPathInZip =
            allFolderIds.indexOf(fileFolderId.toString()) === 0
              ? ""
              : folderMetadata.subfolders.find((sf: any) =>
                  subfolders.some(
                    (s: any) =>
                      ((s as any)._id || s.id).toString() ===
                        fileFolderId.toString() &&
                      sf.path ===
                        `${folderPathMap.get(fileFolderId.toString())}`,
                  ),
                )?.path || "";

          filesMetadata.push({
            id: fileId.toString(),
            name: file.name,
            folder_path: folderPathInZip,
            file_type: file.file_type,
            file_size: file.file_size,
            tags: file.tags || [],
            remarks: file.remarks || undefined,
          });

          logger.info(`Added file to zip: ${file.name}`);
        } catch (error) {
          logger.error(`Failed to add file ${file.name} to zip:`, error);
          // Continue with other files
        }
      }
    }

    // Add files metadata to zip
    zip.file("files-metadata.json", JSON.stringify(filesMetadata, null, 2));

    // Generate zip buffer
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    logger.info(
      `Generated zip for folder ${folder.name} (${zipBuffer.length} bytes)`,
    );

    return zipBuffer;
  }

  /**
   * Import folder from zip file
   */
  async importFolderFromZip(
    zipBuffer: Buffer,
    organizationId: string,
    parentFolderId: string,
    namePrefix?: string,
  ): Promise<IFolder> {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(zipBuffer);

    // Read metadata files
    const metadataFile = zip.file("metadata.json");
    const filesMetadataFile = zip.file("files-metadata.json");

    if (!metadataFile || !filesMetadataFile) {
      throw new Error("Invalid zip format: missing metadata files");
    }

    const metadata = JSON.parse(await metadataFile.async("string"));
    const filesMetadata = JSON.parse(await filesMetadataFile.async("string"));

    logger.info(`Importing folder: ${metadata.folder.name}`);

    // Create root folder
    const rootFolderName = namePrefix
      ? `${namePrefix}${metadata.folder.name}`
      : metadata.folder.name;

    const rootFolder = await this.createFolder({
      name: rootFolderName,
      organization_id: organizationId,
      parent_folder_id: parentFolderId,
      description: metadata.folder.description,
      tags: metadata.folder.tags || [],
      auto_tagging: metadata.folder.auto_tagging || false,
      source_type: metadata.folder.source_type || "upload",
    });

    const rootFolderId = (rootFolder as any)._id || rootFolder.id;

    // Create subfolders (if any)
    const folderPathMap = new Map<string, string>();
    folderPathMap.set("", rootFolderId.toString());

    for (const subfolderMeta of metadata.subfolders || []) {
      const parentPath = subfolderMeta.parent_path;
      const parentId = folderPathMap.get(parentPath);

      if (!parentId) {
        logger.warn(`Parent folder not found for path: ${parentPath}`);
        continue;
      }

      const subfolder = await this.createFolder({
        name: subfolderMeta.name,
        organization_id: organizationId,
        parent_folder_id: parentId,
        description: subfolderMeta.description,
        tags: subfolderMeta.tags || [],
        auto_tagging: subfolderMeta.auto_tagging || false,
        source_type: subfolderMeta.source_type || "upload",
      });

      const subfolderId = (subfolder as any)._id || subfolder.id;
      folderPathMap.set(subfolderMeta.path, subfolderId.toString());

      logger.info(`Created subfolder: ${subfolderMeta.name}`);
    }

    // Import files
    const fileService = (await import("./file.service")).default;

    for (const fileMeta of filesMetadata) {
      try {
        // Get target folder ID
        const targetFolderId = folderPathMap.get(fileMeta.folder_path);
        if (!targetFolderId) {
          logger.warn(`Target folder not found for file: ${fileMeta.name}`);
          continue;
        }

        // Extract file from zip
        const fileExt = fileMeta.name.split(".").pop() || "bin";
        const zipFileName = `${fileMeta.id}.${fileExt}`;
        const fileInZip = zip.file(`files/${zipFileName}`);

        if (!fileInZip) {
          logger.warn(`File not found in zip: ${zipFileName}`);
          continue;
        }

        const fileBuffer = await fileInZip.async("nodebuffer");

        // Upload file to storage
        const uploadedFile = await fileService.uploadFile(
          {
            buffer: fileBuffer,
            originalname: fileMeta.name,
            mimetype: fileMeta.file_type,
            size: fileMeta.file_size,
          },
          {
            folder_id: targetFolderId,
            organization_id: organizationId,
            tags: fileMeta.tags,
            remarks: fileMeta.remarks,
            source_type: "upload",
            last_updated_by: {
              display_name: "Import",
              email: "import@system",
            },
          },
        );

        logger.info(`Imported file: ${fileMeta.name}`);
      } catch (error) {
        logger.error(`Failed to import file ${fileMeta.name}:`, error);
        // Continue with other files
      }
    }

    // Update file counts for all created folders
    await this.updateFileCount(rootFolderId.toString());

    logger.info(`Successfully imported folder: ${rootFolderName}`);
    return rootFolder;
  }
}

export default new FolderService();
