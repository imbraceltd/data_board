import logger from "../../infrastructure/logging/logger";
import axios from "axios";
import config from "../../config";
import { ExternalFolder } from "../interfaces/external-folder.interface";
import { ExternalFile } from "../interfaces/external-file.interface";
import { google } from "googleapis";
import { ExternalSource } from "../enums/external-source.enum";

interface GoogleDriveToken {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

interface GoogleDriveFolder {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
}

interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  downloadUrl?: string;
}

class GoogleDriveService {
  private drive: any;

  getAuthUrl(): string {
    const { clientId, redirectUri } = config.googleDrive;
    const scope = [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive.readonly",
    ].join(" ");

    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;
  }

  async getAccessToken(code: string): Promise<GoogleDriveToken> {
    const tokenEndpoint = "https://oauth2.googleapis.com/token";

    const params = new URLSearchParams({
      client_id: config.googleDrive.clientId,
      client_secret: config.googleDrive.clientSecret,
      code: code,
      grant_type: "authorization_code",
      redirect_uri: config.googleDrive.redirectUri,
    });

    try {
      const response = await axios.post(tokenEndpoint, params, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      return response.data;
    } catch (error: any) {
      logger.error("=== GOOGLE DRIVE TOKEN EXCHANGE ERROR ===");
      logger.error("HTTP Status:", error.response?.status);
      logger.error(
        "Error Response:",
        JSON.stringify(error.response?.data, null, 2)
      );
      logger.error("Token Endpoint:", tokenEndpoint);
      throw new Error("Failed to get access token");
    }
  }

  async refreshAccessToken(refreshToken: string): Promise<GoogleDriveToken> {
    const tokenEndpoint = "https://oauth2.googleapis.com/token";

    const params = new URLSearchParams({
      client_id: config.googleDrive.clientId,
      client_secret: config.googleDrive.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    try {
      const response = await axios.post(tokenEndpoint, params, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      return response.data;
    } catch (error: any) {
      logger.error("=== GOOGLE DRIVE REFRESH TOKEN ERROR ===");
      logger.error(
        "Error Response:",
        JSON.stringify(error.response?.data, null, 2)
      );
      throw new Error("Failed to refresh access token");
    }
  }

  createAuthenticatedClient(accessToken: string) {
    const oauth2Client = new google.auth.OAuth2(
      config.googleDrive.clientId,
      config.googleDrive.clientSecret,
      config.googleDrive.redirectUri
    );

    oauth2Client.setCredentials({
      access_token: accessToken,
    });

    return google.drive({ version: "v3", auth: oauth2Client });
  }

  // Helper method to get total file count (excluding folders) recursively for a folder
  private async getFolderTotalFileCountRecursive(
    accessToken: string,
    folderId: string
  ): Promise<number> {
    try {
      const drive = this.createAuthenticatedClient(accessToken);
      let totalFileCount = 0;

      // Get direct files in this folder (excluding Google Workspace folders)
      let pageToken: string | undefined = undefined;
      do {
        const response: any = await drive.files.list({
          q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder' and mimeType != 'application/vnd.google-apps.shortcut'`,
          fields: "nextPageToken, files(id)",
          pageSize: 1000,
          pageToken: pageToken,
        });

        totalFileCount += response.data.files?.length || 0;
        pageToken = response.data.nextPageToken || undefined;
      } while (pageToken);

      // Get all subfolders
      pageToken = undefined;
      const subfolders: string[] = [];
      do {
        const response: any = await drive.files.list({
          q: `'${folderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
          fields: "nextPageToken, files(id)",
          pageSize: 1000,
          pageToken: pageToken,
        });

        if (response.data.files) {
          subfolders.push(...response.data.files.map((f: any) => f.id));
        }
        pageToken = response.data.nextPageToken || undefined;
      } while (pageToken);

      // Recursively count files in all subfolders IN PARALLEL
      const subfolderCounts = await Promise.all(
        subfolders.map((subfolderId) =>
          this.getFolderTotalFileCountRecursive(accessToken, subfolderId)
        )
      );

      // Sum up all subfolder counts
      totalFileCount += subfolderCounts.reduce((sum, count) => sum + count, 0);

      return totalFileCount;
    } catch (error: any) {
      logger.error(
        `Error getting file count for folder ${folderId}:`,
        error.message
      );
      return 0;
    }
  }

  async getDriveRootFolders(accessToken: string): Promise<ExternalFolder[]> {
    try {
      const drive = this.createAuthenticatedClient(accessToken);

      const fetchStartTime = Date.now();
      const response = await drive.files.list({
        q: "mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed = false",
        fields:
          "files(id,name,webViewLink,parents,createdTime,modifiedTime,size)",
        orderBy: "name",
      });

      if (!response.data.files) {
        return [];
      }

      // Get file counts for all folders in parallel (recursive count of all files)
      const foldersWithCounts = await Promise.all(
        response.data.files.map(async (item: any) => {
          const fileCount = await this.getFolderTotalFileCountRecursive(
            accessToken,
            item.id
          );
          return {
            id: item.id,
            name: item.name,
            webUrl: item.webViewLink,
            size: item.size ? parseInt(item.size) : undefined,
            createdDateTime: item.createdTime,
            lastModifiedDateTime: item.modifiedTime,
            parentReference: {
              id: "root",
              path: "/drive/root",
              name: "root",
            },
            childCount: fileCount, // Total files in this folder and all subfolders
            source: ExternalSource.GOOGLE_DRIVE,
          };
        })
      );
      return foldersWithCounts;
    } catch (error: any) {
      logger.error(
        "Error getting drive root folders:",
        error.response?.data || error.message
      );
      throw new Error("Failed to get drive root folders");
    }
  }

  async getDriveFolders(
    accessToken: string,
    parentId: string = "root",
    skip?: number,
    limit?: number,
    sortBy?: string,
    sortOrder?: "asc" | "desc"
  ): Promise<ExternalFolder[]> {
    try {
      const drive = this.createAuthenticatedClient(accessToken);
      const queryId = parentId === "root" ? "root" : parentId;
      const response = await drive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and '${queryId}' in parents and trashed = false`,
        fields:
          "files(id,name,webViewLink,parents,createdTime,modifiedTime,size)",
        orderBy: "name",
      });

      if (!response.data.files) {
        return [];
      }

      // Get child counts for all folders in parallel
      const countStartTime = Date.now();
      const foldersWithCounts = await Promise.all(
        response.data.files.map(async (item: any) => {
          const fileCount = await this.getFolderTotalFileCountRecursive(
            accessToken,
            item.id
          );
          return {
            id: item.id,
            name: item.name,
            webUrl: item.webViewLink,
            size: item.size ? parseInt(item.size) : undefined,
            createdDateTime: item.createdTime,
            lastModifiedDateTime: item.modifiedTime,
            parentReference: {
              id: parentId,
              path: `/drive/${queryId}`,
              name: parentId === "root" ? "root" : undefined,
            },
            childCount: fileCount, // Total files in this folder and all subfolders
            source: ExternalSource.GOOGLE_DRIVE,
          };
        })
      );

      let folders = foldersWithCounts;

      // Apply sorting if requested
      if (sortBy) {
        const direction = sortOrder === "desc" ? -1 : 1;
        folders.sort((a: any, b: any) => {
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
      const result = folders.slice(startIndex, endIndex);
      return result;
    } catch (error: any) {
      logger.error(
        "Error getting drive folders:",
        error.response?.data || error.message
      );
      throw new Error("Failed to get drive folders");
    }
  }

  async getDriveFiles(
    accessToken: string,
    parentId: string = "root",
    skip?: number,
    limit?: number,
    sortBy?: string,
    sortOrder?: "asc" | "desc",
    recursive?: boolean,
    sessionId?: string
  ): Promise<ExternalFile[]> {
    try {
      const drive = this.createAuthenticatedClient(accessToken);
      const queryId = parentId === "root" ? "root" : parentId;

      const response = await drive.files.list({
        q: `mimeType!='application/vnd.google-apps.folder' and mimeType!='application/vnd.google-apps.shortcut' and '${queryId}' in parents and trashed = false`,
        fields:
          "files(id,name,mimeType,webViewLink,webContentLink,parents,createdTime,modifiedTime,size)",
        orderBy: "name",
      });

      if (!response.data.files) {
        return [];
      }
      logger.info(JSON.stringify(response.data, null, 2));

      let files: ExternalFile[] = response.data.files.map((item: any) => {
        // Use backend proxy endpoint for downloads to avoid CORS issues
        // If sessionId is provided, construct backend URL; otherwise fall back to direct URLs
        let downloadUrl: string;

        if (sessionId) {
          // Use backend proxy endpoint (CORS-safe)
          // Route: /auth/google-drive/files/download (defined in google-drive.router.ts)
          downloadUrl = `/auth/google-drive/files/download?sessionId=${encodeURIComponent(
            sessionId
          )}&fileId=${encodeURIComponent(item.id)}`;
        } else {
          // Fallback to direct URLs (legacy behavior, has CORS issues)
          downloadUrl = item.webContentLink; // For regular files

          // For Google Workspace files (no webContentLink), construct export URL
          if (!downloadUrl && item.mimeType?.includes("google-apps")) {
            // Map Google Workspace MIME types to export formats
            const exportFormats: { [key: string]: string } = {
              "application/vnd.google-apps.document": "application/pdf", // Docs → PDF
              "application/vnd.google-apps.spreadsheet":
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // Sheets → XLSX
              "application/vnd.google-apps.presentation":
                "application/vnd.openxmlformats-officedocument.presentationml.presentation", // Slides → PPTX
              "application/vnd.google-apps.drawing": "application/pdf", // Drawings → PDF
            };

            const exportFormat =
              exportFormats[item.mimeType] || "application/pdf";
            downloadUrl = `https://www.googleapis.com/drive/v3/files/${
              item.id
            }/export?mimeType=${encodeURIComponent(exportFormat)}`;
          } else if (!downloadUrl) {
            // Fallback: use direct download endpoint
            downloadUrl = `https://www.googleapis.com/drive/v3/files/${item.id}?alt=media`;
          }
        }

        return {
          id: item.id,
          name: item.name,
          webUrl: item.webViewLink,
          size: item.size ? parseInt(item.size) : 0,
          mimeType: item.mimeType,
          createdDateTime: item.createdTime,
          lastModifiedDateTime: item.modifiedTime,
          parentReference: {
            id: parentId,
            path: `/drive/${queryId}`,
            name: parentId === "root" ? "root" : undefined,
          },
          downloadUrl: downloadUrl,
          source: ExternalSource.GOOGLE_DRIVE,
        };
      });

      // If recursive, get files from all subfolders
      if (recursive) {
        // Get all subfolders
        const foldersResponse = await drive.files.list({
          q: `mimeType='application/vnd.google-apps.folder' and '${queryId}' in parents and trashed = false`,
          fields: "files(id)",
        });

        if (
          foldersResponse.data.files &&
          foldersResponse.data.files.length > 0
        ) {
          // Recursively get files from all subfolders in parallel
          const subfolderFilesArrays = await Promise.all(
            foldersResponse.data.files.map((folder: any) =>
              this.getDriveFiles(
                accessToken,
                folder.id,
                undefined,
                undefined,
                undefined,
                undefined,
                true,
                sessionId
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
      logger.error(
        "Error getting drive files:",
        error.response?.data || error.message
      );
      throw new Error("Failed to get drive files");
    }
  }

  async downloadFile(
    accessToken: string,
    fileId: string
  ): Promise<{ url: string; filename: string }> {
    try {
      const drive = this.createAuthenticatedClient(accessToken);

      const response = await drive.files.get({
        fileId: fileId,
        fields: "name,webViewLink,mimeType",
      });

      const file = response.data as any;

      let downloadUrl = "";

      if (file.mimeType?.includes("google-apps")) {
        downloadUrl = `https://docs.google.com/feeds/download/documents/export/Export?exportFormat=pdf&id=${fileId}`;
      } else {
        downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
      }

      return {
        url: downloadUrl,
        filename: file.name,
      };
    } catch (error: any) {
      logger.error(
        "Error downloading file:",
        error.response?.data || error.message
      );
      throw new Error("Failed to download file");
    }
  }

  // Download file as a stream to proxy through backend (solves CORS issues)
  async downloadFileStream(
    accessToken: string,
    fileId: string
  ): Promise<{ stream: any; filename: string; mimeType: string }> {
    try {
      const drive = this.createAuthenticatedClient(accessToken);

      // Get file metadata first
      const metadataResponse = await drive.files.get({
        fileId: fileId,
        fields: "name,mimeType",
      });

      const file = metadataResponse.data as any;

      // Download the file content as a stream
      let downloadResponse;

      if (file.mimeType?.includes("google-apps")) {
        // For Google Workspace files, export as PDF
        downloadResponse = await drive.files.export(
          {
            fileId: fileId,
            mimeType: "application/pdf",
          },
          { responseType: "stream" }
        );
      } else {
        // For regular files, download directly
        downloadResponse = await drive.files.get(
          {
            fileId: fileId,
            alt: "media",
          },
          { responseType: "stream" }
        );
      }

      return {
        stream: downloadResponse.data,
        filename: file.name,
        mimeType: file.mimeType?.includes("google-apps")
          ? "application/pdf"
          : file.mimeType || "application/octet-stream",
      };
    } catch (error: any) {
      logger.error(
        "Error streaming file:",
        error.response?.data || error.message
      );
      throw new Error("Failed to stream file");
    }
  }

  // Get changes using Google Drive changes.list API
  async getChanges(
    accessToken: string,
    pageToken?: string
  ): Promise<{
    changes: any[];
    newStartPageToken?: string;
    nextPageToken?: string;
  }> {
    try {
      const drive = this.createAuthenticatedClient(accessToken);

      // If no pageToken provided, get the current start page token first
      if (!pageToken) {
        const startTokenResponse = await drive.changes.getStartPageToken({});
        pageToken = startTokenResponse.data.startPageToken || undefined;

        // Return empty changes since we're just initializing
        return {
          changes: [],
          newStartPageToken: pageToken,
        };
      }

      // Get changes since the provided page token
      const response = await drive.changes.list({
        pageToken: pageToken,
        fields:
          "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,parents,size,trashed,createdTime,modifiedTime))",
        spaces: "drive",
        includeRemoved: true,
      });

      return {
        changes: response.data.changes || [],
        newStartPageToken: response.data.newStartPageToken || undefined,
        nextPageToken: response.data.nextPageToken || undefined,
      };
    } catch (error: any) {
      const errorMessage = error.message || "Unknown error";
      const errorCode = error.code || error.response?.status;

      logger.error("Error getting changes:", errorMessage);
      if (error.response?.data) {
        logger.error(
          "Error details:",
          JSON.stringify(error.response.data, null, 2)
        );
      }

      // Create a more detailed error object
      const detailedError: any = new Error("Failed to get changes");
      detailedError.code = errorCode;
      detailedError.originalError = error.response?.data || error;

      throw detailedError;
    }
  }

  async validateToken(accessToken: string): Promise<boolean> {
    try {
      const drive = this.createAuthenticatedClient(accessToken);
      await drive.files.list({ pageSize: 1 });
      return true;
    } catch (error) {
      return false;
    }
  }
}

export default new GoogleDriveService();
