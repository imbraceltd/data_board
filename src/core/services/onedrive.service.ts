import logger from "../../infrastructure/logging/logger";
import { Client } from "@microsoft/microsoft-graph-client";
import axios from "axios";
import config from "../../config";
import { ExternalFolder } from "../interfaces/external-folder.interface";
import { ExternalFile } from "../interfaces/external-file.interface";
import { ExternalSource } from "../enums/external-source.enum";

interface OneDriveToken {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface OneDriveFolder {
  id: string;
  name: string;
  parentReference?: {
    id: string;
    path: string;
  };
  folder?: {
    childCount: number;
  };
  createdDateTime: string;
  lastModifiedDateTime: string;
  webUrl?: string;
  specialFolder?: {
    name: string;
  };
}

interface OneDriveFile {
  id: string;
  name: string;
  size: number;
  file?: {
    mimeType: string;
  };
  createdDateTime: string;
  lastModifiedDateTime: string;
  "@microsoft.graph.downloadUrl"?: string;
  webUrl?: string;
}

interface OneDriveUserProfile {
  id: string;
  displayName: string;
  mail: string;
  userPrincipalName: string;
}

class OneDriveService {
  getAuthUrl(): string {
    const { clientId, redirectUri } = config.onedrive;
    const scope =
      "https://graph.microsoft.com/Files.Read.All https://graph.microsoft.com/Sites.Read.All https://graph.microsoft.com/User.Read offline_access";

    // Use /common endpoint for multi-tenant applications that support personal accounts
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&scope=${encodeURIComponent(scope)}`;
  }

  async getAccessToken(code: string): Promise<OneDriveToken> {
    // For multi-tenant apps using /common during auth, use /common for token exchange too
    const tokenEndpoint = `https://login.microsoftonline.com/common/oauth2/v2.0/token`;

    const params = new URLSearchParams({
      client_id: config.onedrive.clientId,
      client_secret: config.onedrive.clientSecret,
      code: code,
      grant_type: "authorization_code",
      redirect_uri: config.onedrive.redirectUri,
    });

    try {
      const response = await axios.post(tokenEndpoint, params, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      return response.data;
    } catch (error: any) {
      logger.error("=== MICROSOFT TOKEN EXCHANGE ERROR ===");
      logger.error("HTTP Status:", error.response?.status);
      logger.error(
        "Error Response:",
        JSON.stringify(error.response?.data, null, 2)
      );
      logger.error("Token Endpoint:", tokenEndpoint);
      logger.error("Request Params:", {
        client_id: config.onedrive.clientId.substring(0, 10) + "...",
        code: code.substring(0, 10) + "...",
        redirect_uri: config.onedrive.redirectUri,
      });
      throw new Error("Failed to get access token");
    }
  }

  async refreshAccessToken(refreshToken: string): Promise<OneDriveToken> {
    // For multi-tenant apps, use /common for refresh token exchanges
    const tokenEndpoint = `https://login.microsoftonline.com/common/oauth2/v2.0/token`;

    const params = new URLSearchParams({
      client_id: config.onedrive.clientId,
      client_secret: config.onedrive.clientSecret,
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
      logger.error("=== REFRESH TOKEN ERROR ===");
      logger.error("Refresh Token Endpoint:", tokenEndpoint);
      logger.error(
        "Error Response:",
        JSON.stringify(error.response?.data, null, 2)
      );
      logger.error("Refresh token length:", refreshToken.length);
      throw new Error("Failed to refresh access token");
    }
  }

  createAuthenticatedClient(accessToken: string): Client {
    return Client.init({
      authProvider: (done) => {
        done(null, accessToken);
      },
    });
  }

  async getUserProfile(accessToken: string): Promise<OneDriveUserProfile> {
    try {
      const client = this.createAuthenticatedClient(accessToken);
      const response = await client.api("/me").get();
      return response as OneDriveUserProfile;
    } catch (error: any) {
      logger.error(
        "Error getting user profile:",
        error.response?.data || error.message
      );
      throw new Error("Failed to get user profile");
    }
  }

  // Helper method to get total file count recursively for a folder and all subfolders
  private async getFolderFileCount(
    accessToken: string,
    folderId: string
  ): Promise<number> {
    try {
      const client = this.createAuthenticatedClient(accessToken);
      const endpoint =
        folderId === "root"
          ? "/me/drive/root/children"
          : `/me/drive/items/${folderId}/children`;

      let totalFileCount = 0;
      let nextLink: string | undefined = undefined;
      let currentEndpoint = endpoint;

      // Fetch all children using pagination
      const subfolders: string[] = [];
      do {
        const response = await client.api(currentEndpoint).get();

        // Count only files (items without folder property)
        const files = response.value.filter((item: any) => item.file);
        totalFileCount += files.length;

        // Collect subfolder IDs for recursion
        const folders = response.value.filter((item: any) => item.folder);
        subfolders.push(...folders.map((f: any) => f.id));

        nextLink = response["@odata.nextLink"];
        if (nextLink) {
          // Extract the path from the full URL for the next page
          currentEndpoint = nextLink;
        }
      } while (nextLink);

      // Recursively count files in all subfolders IN PARALLEL
      const subfolderCounts = await Promise.all(
        subfolders.map((subfolderId) =>
          this.getFolderFileCount(accessToken, subfolderId)
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
      // Return 0 if we can't get the count
      return 0;
    }
  }

  async getDriveRootFolders(accessToken: string): Promise<ExternalFolder[]> {
    try {
      const client = this.createAuthenticatedClient(accessToken);

      const response = await client.api("/me/drive/root/children").get();

      // Get file counts for all folders in parallel
      const foldersWithCounts = await Promise.all(
        response.value
          .filter((item: any) => item.folder)
          .map(async (item: any) => {
            const fileCount = await this.getFolderFileCount(
              accessToken,
              item.id
            );
            return {
              id: item.id,
              name: item.name,
              webUrl: item.webUrl,
              size: item.size,
              createdDateTime: item.createdDateTime,
              lastModifiedDateTime: item.lastModifiedDateTime,
              parentReference: item.parentReference
                ? {
                    id: item.parentReference.id,
                    path: item.parentReference.path,
                    name: item.parentReference.name,
                  }
                : undefined,
              childCount: fileCount, // Total files in this folder and all subfolders recursively
              source: ExternalSource.ONEDRIVE,
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
    folderId: string = "root",
    skip?: number,
    limit?: number,
    sortBy?: string,
    sortOrder?: "asc" | "desc"
  ): Promise<ExternalFolder[]> {
    try {
      const client = this.createAuthenticatedClient(accessToken);
      const endpoint =
        folderId === "root"
          ? "/me/drive/root/children"
          : `/me/drive/items/${folderId}/children`;

      let apiCall = client.api(endpoint);

      // Add pagination using OData query parameters
      if (skip !== undefined) {
        apiCall = apiCall.skip(skip);
      }
      if (limit !== undefined) {
        apiCall = apiCall.top(limit);
      }

      // Add sorting using OData $orderby
      if (sortBy) {
        const direction = sortOrder === "desc" ? "desc" : "asc";
        // Map common sort fields to OneDrive field names
        let sortField = sortBy;
        switch (sortBy) {
          case "last_updated_time":
            sortField = "lastModifiedDateTime";
            break;
          case "created_time":
            sortField = "createdDateTime";
            break;
        }
        apiCall = apiCall.orderby(`${sortField} ${direction}`);
      }

      const response = await apiCall.get();

      // Get file counts for all folders in parallel
      const foldersWithCounts = await Promise.all(
        response.value
          .filter((item: any) => item.folder)
          .map(async (item: any) => {
            const fileCount = await this.getFolderFileCount(
              accessToken,
              item.id
            );
            return {
              id: item.id,
              name: item.name,
              webUrl: item.webUrl,
              size: item.size,
              createdDateTime: item.createdDateTime,
              lastModifiedDateTime: item.lastModifiedDateTime,
              parentReference: item.parentReference
                ? {
                    id: item.parentReference.id,
                    path: item.parentReference.path,
                    name: item.parentReference.name,
                  }
                : undefined,
              childCount: fileCount, // Total files in this folder and all subfolders recursively
              source: ExternalSource.ONEDRIVE,
            };
          })
      );

      return foldersWithCounts;
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
    folderId: string = "root",
    skip?: number,
    limit?: number,
    sortBy?: string,
    sortOrder?: "asc" | "desc",
    recursive?: boolean
  ): Promise<ExternalFile[]> {
    try {
      const client = this.createAuthenticatedClient(accessToken);
      const endpoint =
        folderId === "root"
          ? "/me/drive/root/children"
          : `/me/drive/items/${folderId}/children`;

      let apiCall = client.api(endpoint);

      // When using recursive mode, we need to collect all files first before applying pagination
      // So we DON'T apply skip/limit at the API level when recursive=true
      if (!recursive) {
        // Add pagination using OData query parameters (only for non-recursive mode)
        if (skip !== undefined) {
          apiCall = apiCall.skip(skip);
        }
        if (limit !== undefined) {
          apiCall = apiCall.top(limit);
        }

        // Add sorting using OData $orderby
        if (sortBy) {
          const direction = sortOrder === "desc" ? "desc" : "asc";
          // Map common sort fields to OneDrive field names
          let sortField = sortBy;
          switch (sortBy) {
            case "last_updated_time":
              sortField = "lastModifiedDateTime";
              break;
            case "created_time":
              sortField = "createdDateTime";
              break;
          }
          apiCall = apiCall.orderby(`${sortField} ${direction}`);
        }
      }

      const response = await apiCall.get();

      let files: ExternalFile[] = response.value
        .filter((item: any) => item.file)
        .map((item: any) => ({
          id: item.id,
          name: item.name,
          webUrl: item.webUrl,
          size: item.size,
          mimeType: item.file?.mimeType,
          createdDateTime: item.createdDateTime,
          lastModifiedDateTime: item.lastModifiedDateTime,
          parentReference: item.parentReference
            ? {
                id: item.parentReference.id,
                path: item.parentReference.path,
                name: item.parentReference.name,
              }
            : undefined,
          downloadUrl: item["@microsoft.graph.downloadUrl"],
          source: ExternalSource.ONEDRIVE,
        }));

      // If recursive, get files from all subfolders
      if (recursive) {
        const subfolders = response.value.filter((item: any) => item.folder);

        if (subfolders.length > 0) {
          // Recursively get files from all subfolders in parallel
          const subfolderFilesArrays = await Promise.all(
            subfolders.map((folder: any) =>
              this.getDriveFiles(
                accessToken,
                folder.id,
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

      // Apply sorting if requested (for recursive mode)
      if (recursive && sortBy) {
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

      // Apply pagination (for recursive mode, or if API-level pagination wasn't used)
      if (recursive) {
        const startIndex = skip || 0;
        const endIndex = limit ? startIndex + limit : undefined;
        return files.slice(startIndex, endIndex);
      }

      return files;
    } catch (error: any) {
      logger.error(
        "Error getting drive files:",
        error.response?.data || error.message
      );
      throw new Error("Failed to get drive files");
    }
  }

  async getDriveItem(
    accessToken: string,
    itemId: string
  ): Promise<OneDriveFile | OneDriveFolder> {
    try {
      const client = this.createAuthenticatedClient(accessToken);

      const response = await client.api(`/me/drive/items/${itemId}`).get();

      return response as OneDriveFile | OneDriveFolder;
    } catch (error: any) {
      logger.error(
        "Error getting drive item:",
        error.response?.data || error.message
      );
      throw new Error("Failed to get drive item");
    }
  }

  async downloadFile(
    accessToken: string,
    itemId: string
  ): Promise<{ url: string; filename: string }> {
    try {
      const client = this.createAuthenticatedClient(accessToken);

      const response = await client.api(`/me/drive/items/${itemId}`).get();

      if (!response["@microsoft.graph.downloadUrl"]) {
        throw new Error("Download URL not available");
      }

      return {
        url: response["@microsoft.graph.downloadUrl"],
        filename: response.name,
      };
    } catch (error: any) {
      logger.error(
        "Error downloading file:",
        error.response?.data || error.message
      );
      throw new Error("Failed to download file");
    }
  }

  // Create a subscription for change notifications
  async createSubscription(
    accessToken: string,
    resource: string,
    notificationUrl: string,
    expirationDateTime: string,
    clientState: string
  ): Promise<any> {
    try {
      const client = this.createAuthenticatedClient(accessToken);

      const subscription = {
        changeType: "updated",
        notificationUrl,
        resource,
        expirationDateTime,
        clientState,
      };

      const response = await client.api("/subscriptions").post(subscription);
      return response;
    } catch (error: any) {
      logger.error(
        "Error creating subscription:",
        error.response?.data || error.message
      );
      throw new Error("Failed to create subscription");
    }
  }

  // Renew a subscription
  async renewSubscription(
    accessToken: string,
    subscriptionId: string,
    expirationDateTime: string
  ): Promise<any> {
    try {
      const client = this.createAuthenticatedClient(accessToken);

      const response = await client
        .api(`/subscriptions/${subscriptionId}`)
        .patch({ expirationDateTime });

      return response;
    } catch (error: any) {
      logger.error(
        "Error renewing subscription:",
        error.response?.data || error.message
      );
      throw new Error("Failed to renew subscription");
    }
  }

  // Delete a subscription
  async deleteSubscription(
    accessToken: string,
    subscriptionId: string
  ): Promise<void> {
    try {
      const client = this.createAuthenticatedClient(accessToken);
      await client.api(`/subscriptions/${subscriptionId}`).delete();
    } catch (error: any) {
      logger.error(
        "Error deleting subscription:",
        error.response?.data || error.message
      );
      throw new Error("Failed to delete subscription");
    }
  }

  // Get changes using delta query
  async getDelta(
    accessToken: string,
    deltaLink?: string,
    folderId?: string,
    driveId?: string
  ): Promise<any> {
    try {
      const client = this.createAuthenticatedClient(accessToken);

      // If deltaLink is provided, use it; otherwise start fresh from folder or root
      let endpoint = deltaLink;
      if (!endpoint) {
        if (driveId && folderId) {
          endpoint = `/drives/${driveId}/items/${folderId}/delta`;
        } else {
          endpoint = folderId
            ? `/me/drive/items/${folderId}/delta`
            : "/me/drive/root/delta";
        }
      }

      logger.info(`Calling Delta Endpoint: ${endpoint}`);

      const response = await client.api(endpoint).get();

      return {
        changes: response.value,
        deltaLink: response["@odata.deltaLink"],
        nextLink: response["@odata.nextLink"],
      };
    } catch (error: any) {
      const errorMessage = error.message || "Unknown error";
      const errorCode = error.code || error.statusCode;
      const errorBody = error.body ? JSON.parse(error.body) : null;
      const errorType = errorBody?.error?.code || errorCode;

      logger.error("Error getting delta:", errorMessage);
      if (errorBody) {
        logger.error("Error details:", JSON.stringify(errorBody, null, 2));
      }

      // Create a more detailed error object
      const detailedError: any = new Error("Failed to get delta");
      detailedError.code = errorType;
      detailedError.statusCode = errorCode;
      detailedError.originalError = errorBody || error;

      throw detailedError;
    }
  }

  // Helper method to validate token
  async validateToken(accessToken: string): Promise<boolean> {
    try {
      const client = this.createAuthenticatedClient(accessToken);
      await client.api("/me/drive/root").get();
      return true;
    } catch (error) {
      return false;
    }
  }
}

export default new OneDriveService();
