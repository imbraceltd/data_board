import logger from "../../infrastructure/logging/logger";
import { Dropbox } from "dropbox";
import axios from "axios";
import config from "../../config";
import { ExternalFolder } from "../interfaces/external-folder.interface";
import { ExternalFile } from "../interfaces/external-file.interface";
import { ExternalSource } from "../enums/external-source.enum";

interface DropboxToken {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface DropboxFolder {
  ".tag": "folder";
  id: string;
  name: string;
  path_lower: string;
  path_display: string;
}

interface DropboxFile {
  ".tag": "file";
  id: string;
  name: string;
  path_lower: string;
  path_display: string;
  size: number;
  client_modified: string;
  server_modified: string;
}

class DropboxService {
  getAuthUrl(): string {
    const params = new URLSearchParams({
      client_id: config.dropbox.appKey,
      response_type: "code",
      redirect_uri: config.dropbox.redirectUri,
      token_access_type: "offline", // Request refresh token
    });

    return `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
  }

  async getAccessToken(code: string): Promise<DropboxToken> {
    try {
      const response = await axios.post(
        "https://api.dropboxapi.com/oauth2/token",
        new URLSearchParams({
          code,
          grant_type: "authorization_code",
          client_id: config.dropbox.appKey,
          client_secret: config.dropbox.appSecret,
          redirect_uri: config.dropbox.redirectUri,
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      return {
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token,
        expires_in: response.data.expires_in || 14400, // Default 4 hours
        token_type: response.data.token_type,
      };
    } catch (error: any) {
      logger.error(
        "Error getting Dropbox access token:",
        error.response?.data || error.message
      );
      throw new Error("Failed to get access token from Dropbox");
    }
  }

  async refreshAccessToken(refreshToken: string): Promise<DropboxToken> {
    try {
      const response = await axios.post(
        "https://api.dropboxapi.com/oauth2/token",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: config.dropbox.appKey,
          client_secret: config.dropbox.appSecret,
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      return {
        access_token: response.data.access_token,
        expires_in: response.data.expires_in || 14400,
        token_type: response.data.token_type,
      };
    } catch (error: any) {
      logger.error(
        "Error refreshing Dropbox token:",
        error.response?.data || error.message
      );
      throw new Error("Failed to refresh Dropbox access token");
    }
  }

  createAuthenticatedClient(accessToken: string): Dropbox {
    return new Dropbox({
      accessToken,
    });
  }

  // Helper method to get total file count recursively for a folder and all subfolders
  private async getFolderTotalFileCountRecursive(
    accessToken: string,
    folderPath: string
  ): Promise<number> {
    try {
      const dbx = this.createAuthenticatedClient(accessToken);
      let totalFileCount = 0;

      const response = await dbx.filesListFolder({
        path: folderPath,
        include_mounted_folders: true,
        recursive: false, // We'll handle recursion manually for better control
      });

      // Count files in this folder
      const files = response.result.entries.filter(
        (entry: any) => entry[".tag"] === "file"
      );
      totalFileCount += files.length;

      // Get all subfolders
      const subfolders = response.result.entries.filter(
        (entry: any) => entry[".tag"] === "folder"
      );

      // Recursively count files in all subfolders IN PARALLEL
      const subfolderCounts = await Promise.all(
        subfolders.map((subfolder) =>
          this.getFolderTotalFileCountRecursive(
            accessToken,
            (subfolder as any).path_lower
          )
        )
      );

      // Sum up all subfolder counts
      totalFileCount += subfolderCounts.reduce((sum, count) => sum + count, 0);

      return totalFileCount;
    } catch (error: any) {
      logger.error(
        `Error getting file count for Dropbox folder ${folderPath}:`,
        error.message || error
      );
      return 0;
    }
  }

  async getDriveRootFolders(accessToken: string): Promise<ExternalFolder[]> {
    const dbx = this.createAuthenticatedClient(accessToken);

    try {
      const response = await dbx.filesListFolder({
        path: "",
        include_mounted_folders: true,
      });

      // Get file counts for all folders in parallel (recursive count of all files)
      const foldersWithCounts = await Promise.all(
        response.result.entries
          .filter((entry: any) => entry[".tag"] === "folder")
          .map(async (folder: any) => {
            const fileCount = await this.getFolderTotalFileCountRecursive(
              accessToken,
              folder.path_lower
            );
            return {
              id: folder.id,
              name: folder.name,
              webUrl: undefined,
              createdDateTime: undefined,
              lastModifiedDateTime: undefined,
              parentReference: {
                id: "root",
                path: "/",
              },
              childCount: fileCount, // Total files in this folder and all subfolders
              source: ExternalSource.DROPBOX,
            };
          })
      );

      return foldersWithCounts;
    } catch (error: any) {
      logger.error("Error getting Dropbox root folders:", error);
      throw new Error("Failed to get Dropbox folders");
    }
  }

  async getDriveFolders(
    accessToken: string,
    folderId: string = "",
    skip?: number,
    limit?: number,
    sortBy?: string,
    sortOrder?: "asc" | "desc"
  ): Promise<ExternalFolder[]> {
    const dbx = this.createAuthenticatedClient(accessToken);

    try {
      // If folderId is provided and starts with 'id:', use it as path
      // Otherwise use it as a path string
      const path = folderId === "" || folderId === "root" ? "" : folderId;

      const response = await dbx.filesListFolder({
        path,
        include_mounted_folders: true,
      });

      // Get file counts for all folders in parallel (recursive count of all files)
      let folders = await Promise.all(
        response.result.entries
          .filter((entry: any) => entry[".tag"] === "folder")
          .map(async (folder: any) => {
            const fileCount = await this.getFolderTotalFileCountRecursive(
              accessToken,
              folder.path_lower
            );
            return {
              id: folder.id,
              name: folder.name,
              webUrl: undefined,
              createdDateTime: undefined,
              lastModifiedDateTime: undefined,
              parentReference: {
                id: folderId || "root",
                path: folder.path_display || "/",
              },
              childCount: fileCount, // Total files in this folder and all subfolders
              source: ExternalSource.DROPBOX,
            };
          })
      );

      // Apply sorting if requested
      if (sortBy) {
        const direction = sortOrder === "desc" ? -1 : 1;
        folders.sort((a: any, b: any) => {
          const aVal = a[sortBy as keyof typeof a];
          const bVal = b[sortBy as keyof typeof b];
          if (aVal < bVal) return -1 * direction;
          if (aVal > bVal) return 1 * direction;
          return 0;
        });
      }

      // Apply pagination
      const startIndex = skip || 0;
      const endIndex = limit ? startIndex + limit : undefined;
      return folders.slice(startIndex, endIndex);
    } catch (error: any) {
      logger.error("Error getting Dropbox folders:", error);
      throw new Error("Failed to get Dropbox folders");
    }
  }

  async getDriveFiles(
    accessToken: string,
    folderId: string = "",
    skip?: number,
    limit?: number,
    sortBy?: string,
    sortOrder?: "asc" | "desc",
    recursive?: boolean
  ): Promise<ExternalFile[]> {
    const dbx = this.createAuthenticatedClient(accessToken);

    try {
      const path = folderId === "" || folderId === "root" ? "" : folderId;

      const response = await dbx.filesListFolder({
        path,
        include_mounted_folders: true,
      });

      let files: ExternalFile[] = response.result.entries
        .filter((entry: any) => entry[".tag"] === "file")
        .map((file: any) => ({
          id: file.id,
          name: file.name,
          webUrl: undefined,
          size: file.size || 0,
          mimeType: this.getMimeType(file.name),
          createdDateTime: file.client_modified,
          lastModifiedDateTime: file.server_modified,
          parentReference: {
            id: folderId || "root",
            path: file.path_display || "/",
          },
          source: ExternalSource.DROPBOX,
        }));

      // If recursive, get files from all subfolders
      if (recursive) {
        const subfolders = response.result.entries.filter(
          (entry: any) => entry[".tag"] === "folder"
        );

        if (subfolders.length > 0) {
          // Recursively get files from all subfolders in parallel
          const subfolderFilesArrays = await Promise.all(
            subfolders.map((folder: any) =>
              this.getDriveFiles(
                accessToken,
                folder.path_lower,
                undefined,
                undefined,
                undefined,
                undefined,
                true
              )
            )
          );

          // Flatten and combine all files
          for (const subfolderFiles of subfolderFilesArrays) {
            files.push(...subfolderFiles);
          }
        }
      }

      // Apply sorting if requested
      if (sortBy) {
        const direction = sortOrder === "desc" ? -1 : 1;
        files.sort((a: any, b: any) => {
          let sortField = sortBy;
          // Map common sort fields
          switch (sortBy) {
            case "last_updated_time":
              sortField = "lastModifiedDateTime";
              break;
            case "created_time":
              sortField = "createdDateTime";
              break;
          }
          const aVal = a[sortField];
          const bVal = b[sortField];
          if (aVal < bVal) return -1 * direction;
          if (aVal > bVal) return 1 * direction;
          return 0;
        });
      }

      // Apply pagination
      const startIndex = skip || 0;
      const endIndex = limit ? startIndex + limit : undefined;
      return files.slice(startIndex, endIndex);
    } catch (error: any) {
      logger.error("Error getting Dropbox files:", error);
      throw new Error("Failed to get Dropbox files");
    }
  }

  async getDriveItem(accessToken: string, itemPath: string): Promise<any> {
    const dbx = this.createAuthenticatedClient(accessToken);

    try {
      const response = await dbx.filesGetMetadata({
        path: itemPath,
      });

      return response.result;
    } catch (error: any) {
      logger.error("Error getting Dropbox item:", error);
      throw new Error("Failed to get Dropbox item");
    }
  }

  async downloadFile(
    accessToken: string,
    filePath: string
  ): Promise<{ url: string; filename: string }> {
    const dbx = this.createAuthenticatedClient(accessToken);

    try {
      // Get temporary download link
      const response = await dbx.filesGetTemporaryLink({
        path: filePath,
      });

      const filename = filePath.split("/").pop() || "download";

      return {
        url: response.result.link,
        filename,
      };
    } catch (error: any) {
      logger.error("Error downloading Dropbox file:", error);
      throw new Error("Failed to download Dropbox file");
    }
  }

  async validateToken(accessToken: string): Promise<boolean> {
    try {
      const dbx = this.createAuthenticatedClient(accessToken);
      await dbx.usersGetCurrentAccount();
      return true;
    } catch (error) {
      return false;
    }
  }

  // Helper method to determine MIME type from file extension
  private getMimeType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase();
    const mimeTypes: { [key: string]: string } = {
      pdf: "application/pdf",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ppt: "application/vnd.ms-powerpoint",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      txt: "text/plain",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      zip: "application/zip",
    };

    return mimeTypes[ext || ""] || "application/octet-stream";
  }

  // Get list of changes (for sync purposes)
  async getFileChanges(accessToken: string, cursor?: string): Promise<any> {
    const dbx = this.createAuthenticatedClient(accessToken);

    try {
      if (cursor) {
        // Continue with existing cursor
        const response = await dbx.filesListFolderContinue({
          cursor,
        });
        return {
          entries: response.result.entries,
          cursor: response.result.cursor,
          has_more: response.result.has_more,
        };
      } else {
        // Get latest cursor for the entire Dropbox
        const response = await dbx.filesListFolderGetLatestCursor({
          path: "",
          recursive: true,
          include_mounted_folders: true,
        });

        return {
          entries: [],
          cursor: response.result.cursor,
          has_more: false,
        };
      }
    } catch (error: any) {
      logger.error("Error getting Dropbox changes:", error);
      throw new Error("Failed to get Dropbox changes");
    }
  }
}

export default new DropboxService();
