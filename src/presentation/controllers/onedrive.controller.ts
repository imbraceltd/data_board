/**
 * OneDrive Controller for Hono
 *
 * Handles all OneDrive-related HTTP requests including:
 * - Authentication (OAuth flow)
 * - File/Folder operations
 * - Webhook handling
 * - Sync management
 */

import type { Context } from "hono";
import { randomUUID } from "crypto";
import onedriveService from "../../core/services/onedrive.service";
import onedrivePollingService from "../../core/services/onedrive-polling.service";
import onedriveSyncService from "../../core/services/onedrive-sync.service";
import { onedriveSessionRepository } from "../../infrastructure/database/repositories";
import OneDriveSubscription from "../../db/models/onedrive-subscription.model";
import Folder from "../../db/models/folder.model";
import { ExternalSource } from "../../core/enums/external-source.enum";
import config from "../../config";
import logger from "../../infrastructure/logging/logger";

// Helper: Generate a unique session ID for OAuth state
function generateUniqueSessionId(): string {
  return `onedrive_session_${randomUUID()}`;
}

// Helper: Generate re-auth response
function generateReauthResponse(message: string) {
  const newSessionId = generateUniqueSessionId();
  const authUrl = onedriveService.getAuthUrl();
  const authUrlWithState = `${authUrl}&state=${newSessionId}`;

  return {
    success: false,
    message,
    data: null,
    auth_url: authUrlWithState,
    session_id: newSessionId,
    requires_reauth: true,
  };
}

class OneDriveController {
  // --- Authentication Routes ---

  /**
   * Initiate OneDrive Authentication
   * GET /api/auth/onedrive/initiate
   */
  initiateAuth = async (c: Context) => {
    const sessionId = generateUniqueSessionId();
    const organizationId = c.req.query("organizationId");
    const { clientId, redirectUri } = config.onedrive;
    const scope =
      "https://graph.microsoft.com/Files.Read.All https://graph.microsoft.com/Sites.Read.All https://graph.microsoft.com/User.Read offline_access";

    // Create state object with session ID and organization ID
    const state = JSON.stringify({
      sessionId,
      organizationId: organizationId || null,
    });

    const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(
      redirectUri,
    )}&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}`;

    return c.json({
      success: true,
      message: "OneDrive authentication URL generated",
      data: {
        auth_url: authUrl,
        session_id: sessionId,
      },
    });
  };

  /**
   * Handle Authentication Callback
   * GET /api/auth/onedrive/callback
   */
  handleCallback = async (c: Context) => {
    const code = c.req.query("code");
    const stateStr = c.req.query("state") || "{}";

    if (!code) {
      return c.json(
        {
          success: false,
          message: "Authorization code is required",
          data: null,
        },
        400,
      );
    }

    logger.info(
      `Processing OneDrive callback with code: ${code.substring(0, 10)}...`,
    );

    try {
      const tokenData = await onedriveService.getAccessToken(code);
      logger.info("Token exchange successful");

      // Parse state
      let sessionId = "default_session";
      let organizationId = null;

      try {
        const state = JSON.parse(stateStr);
        sessionId = state.sessionId || sessionId;
        organizationId = state.organizationId;
      } catch (e) {
        sessionId = stateStr; // Legacy fallback
      }

      const expiresAt = Date.now() + tokenData.expires_in * 1000;
      const userProfile = await onedriveService.getUserProfile(
        tokenData.access_token,
      );

      await onedriveSessionRepository.upsertBySessionId(sessionId, {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
        expires_in: tokenData.expires_in,
        organization_id: organizationId,
        // PG stores user info as flat columns (the Mongoose model nested it
        // under `user_info`, which has no Postgres column).
        user_display_name: userProfile.displayName,
        user_email: userProfile.mail || userProfile.userPrincipalName,
      });

      // Return HTML success page (same as original controller)
      return c.html(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Authentication Successful</title>
          <style>
             body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
             .container { background: white; padding: 3rem; border-radius: 1rem; box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center; max-width: 400px; }
             h1 { color: #1f2937; }
             p { color: #6b7280; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Login Successful!</h1>
            <p>You have successfully authenticated with OneDrive. Please return to iMBrace to continue.</p>
          </div>
          <script>
            (function() {
              const authData = {
                type: 'AUTH_SUCCESS',
                provider: 'onedrive',
                sessionId: '${sessionId}',
                timestamp: new Date().toISOString()
              };
              
              function sendAuthMessage(retryCount = 0) {
                if (window.opener && !window.opener.closed) {
                  window.opener.postMessage(authData, '*');
                  const targetOrigin = '${config.webapp_url || "*"}';
                  if (targetOrigin !== '*') window.opener.postMessage(authData, targetOrigin);
                  
                  if (retryCount < 5) setTimeout(() => sendAuthMessage(retryCount + 1), 100 * (retryCount + 1));
                } else {
                   try { localStorage.setItem('onedrive_auth_success', JSON.stringify(authData)); } catch(e){}
                }
              }
              sendAuthMessage();
              setTimeout(() => window.close(), 2000);
            })();
          </script>
        </body>
        </html>
      `);
    } catch (error: any) {
      logger.error("OneDrive callback processing error:", error);
      return c.json(
        {
          success: false,
          message: "Failed to exchange authorization code for access token",
          error: error.message,
        },
        500,
      );
    }
  };

  /**
   * Get Session Status
   * GET /api/auth/onedrive/session/status
   */
  getSessionStatus = async (c: Context) => {
    const sessionId = c.req.query("sessionId");

    if (!sessionId) {
      return c.json({ success: false, message: "Session ID is required" }, 400);
    }

    const tokenData = await onedriveSessionRepository.findBySessionId(
      sessionId,
    );
    if (!tokenData) {
      return c.json({ success: false, message: "Session not found" }, 404);
    }

    const isExpired = Date.now() >= tokenData.expires_at;

    return c.json({
      success: true,
      message: "Session status retrieved successfully",
      data: {
        session_id: sessionId,
        is_expired: isExpired,
        expires_at: tokenData.expires_at,
        time_remaining_ms: Math.max(0, tokenData.expires_at - Date.now()),
      },
    });
  };

  // --- OneDrive API Routes (Folders/Files) ---

  /**
   * Get Folders
   * GET /api/onedrive/folders
   */
  getFolders = async (c: Context) => {
    const queries = c.req.query();
    const { sessionId, folderId, skip, limit, sortBy, sortOrder } = queries;
    const qParam = queries.q;
    const searchQuery = qParam && qParam.trim().length > 0 ? qParam.trim() : "";

    if (!sessionId)
      return c.json({ success: false, message: "Session ID is required" }, 400);

    let tokenData = await this._getSessionAndRefreshToken(sessionId);
    if (!tokenData)
      return c.json(generateReauthResponse("Session expired"), 401);

    // Get folders logic (simplified slightly but preserving logic)
    let allFolders;
    if (folderId) {
      allFolders = await onedriveService.getDriveFolders(
        tokenData.access_token,
        folderId,
      );
    } else {
      allFolders = await onedriveService.getDriveRootFolders(
        tokenData.access_token,
      );
    }

    // Filter, Sort, Paginate
    let filteredFolders = allFolders;
    if (searchQuery) {
      filteredFolders = allFolders.filter((folder: any) =>
        folder.name.toLowerCase().includes(searchQuery.toLowerCase()),
      );
    }

    const totalFolders = filteredFolders.length;
    let folders = [...filteredFolders];

    if (sortBy) {
      const direction = sortOrder === "desc" ? -1 : 1;
      folders.sort((a: any, b: any) => {
        const aVal = a[sortBy];
        const bVal = b[sortBy];
        if (aVal < bVal) return -1 * direction;
        if (aVal > bVal) return 1 * direction;
        return 0;
      });
    }

    const currentSkip = skip ? parseInt(skip, 10) : 0;
    const currentLimit = limit ? parseInt(limit, 10) : undefined;
    if (currentSkip > 0 || currentLimit) {
      const endIndex = currentLimit ? currentSkip + currentLimit : undefined;
      folders = folders.slice(currentSkip, endIndex);
    }

    const currentPage = currentLimit
      ? Math.floor(currentSkip / currentLimit) + 1
      : 1;
    const totalPages = currentLimit
      ? Math.ceil(totalFolders / currentLimit)
      : 1;

    return c.json({
      success: true,
      message: searchQuery
        ? "Folders searched successfully"
        : "Folders retrieved successfully",
      data: folders,
      search_query: searchQuery || null,
      pagination: {
        folder_count: totalFolders,
        current_page: currentPage,
        total_pages: totalPages,
        limit: currentLimit,
        skip: currentSkip,
      },
    });
  };

  /**
   * Get Files
   * GET /api/onedrive/files
   */
  getFiles = async (c: Context) => {
    const queries = c.req.query();
    const { sessionId, folderId, skip, limit, sortBy, sortOrder, recursive } =
      queries;
    const qParam = queries.q;
    const searchQuery = qParam && qParam.trim().length > 0 ? qParam.trim() : "";

    if (!sessionId)
      return c.json({ success: false, message: "Session ID is required" }, 400);

    const tokenData = await this._getSessionAndRefreshToken(sessionId);
    if (!tokenData)
      return c.json(generateReauthResponse("Session expired"), 401);

    const isRecursive = recursive === "true";

    const allFiles = await onedriveService.getDriveFiles(
      tokenData.access_token,
      folderId || "root",
      undefined,
      undefined,
      sortBy,
      sortOrder as "asc" | "desc",
      isRecursive,
    );

    let filteredFiles = allFiles;
    if (searchQuery) {
      filteredFiles = allFiles.filter((file: any) =>
        file.name.toLowerCase().includes(searchQuery.toLowerCase()),
      );
    }

    const totalFiles = filteredFiles.length;
    const currentSkip = skip ? parseInt(skip, 10) : 0;
    const currentLimit = limit ? parseInt(limit, 10) : undefined;

    let files = filteredFiles;
    if (currentLimit) {
      files = filteredFiles.slice(currentSkip, currentSkip + currentLimit);
    } else if (currentSkip > 0) {
      files = filteredFiles.slice(currentSkip);
    }

    const currentPage = currentLimit
      ? Math.floor(currentSkip / currentLimit) + 1
      : 1;
    const totalPages = currentLimit ? Math.ceil(totalFiles / currentLimit) : 1;

    return c.json({
      success: true,
      message: searchQuery
        ? "Files searched successfully"
        : "Files retrieved successfully",
      data: files,
      pagination: {
        file_count: totalFiles,
        current_page: currentPage,
        total_pages: totalPages,
      },
    });
  };

  /**
   * Download File
   * GET /api/onedrive/files/download
   */
  downloadFile = async (c: Context) => {
    const sessionId = c.req.query("sessionId");
    const fileId = c.req.query("fileId");

    if (!sessionId || !fileId)
      return c.json(
        { success: false, message: "Session ID and File ID required" },
        400,
      );

    const tokenData = await this._getSessionAndRefreshToken(sessionId);
    if (!tokenData)
      return c.json(generateReauthResponse("Session expired"), 401);

    const downloadData = await onedriveService.downloadFile(
      tokenData.access_token,
      fileId,
    );
    return c.redirect(downloadData.url);
  };

  // --- Sync & Webhooks ---

  /**
   * Get Sync Status
   * GET /api/onedrive/sync/status
   */
  getSyncStatus = async (c: Context) => {
    const status = onedrivePollingService.getStatus();
    return c.json({
      success: true,
      message: "Polling status retrieved",
      data: status,
    });
  };

  /**
   * Enable Folder Sync
   * PUT /api/onedrive/sync/folders/:folderId/enable
   */
  enableFolderSync = async (c: Context) => {
    const folderId = c.req.param("folderId");
    const folder = await Folder.findByIdAndUpdate(
      folderId,
      { is_sync_enabled: true, synced: false },
      { new: true },
    );

    if (!folder)
      return c.json({ success: false, message: "Folder not found" }, 404);
    return c.json({ success: true, message: "Sync enabled", data: folder });
  };

  /**
   * Disable Folder Sync
   * PUT /api/onedrive/sync/folders/:folderId/disable
   */
  disableFolderSync = async (c: Context) => {
    const folderId = c.req.param("folderId");
    const folder = await Folder.findByIdAndUpdate(
      folderId,
      { is_sync_enabled: false },
      { new: true },
    );

    if (!folder)
      return c.json({ success: false, message: "Folder not found" }, 404);
    return c.json({ success: true, message: "Sync disabled", data: folder });
  };

  /**
   * Sync Folder Now
   * POST /api/onedrive/sync/folders/:folderId
   */
  syncFolder = async (c: Context) => {
    const folderId = c.req.param("folderId");
    await onedrivePollingService.syncFolderById(folderId);
    return c.json({
      success: true,
      message: "Sync triggered",
      data: { folderId },
    });
  };

  /**
   * Get Sync Enabled Folders
   * GET /api/onedrive/sync/folders
   */
  getSyncEnabledFolders = async (c: Context) => {
    const organizationId = c.req.query("organizationId");
    const query: any = {
      external_source: ExternalSource.ONEDRIVE,
      is_sync_enabled: true,
    };
    if (organizationId) query.organization_id = organizationId;

    const folders = await Folder.find(query);
    return c.json({
      success: true,
      message: "Retrieved sync-enabled folders",
      data: folders,
    });
  };

  /**
   * Handle Webhook
   * POST /api/onedrive/webhook
   */
  handleWebhook = async (c: Context) => {
    const validationToken = c.req.query("validationToken");
    if (validationToken) {
      logger.info("Webhook validation request received");
      return c.text(validationToken);
    }

    const { value: notifications } = await c.req.json();
    if (!notifications || !Array.isArray(notifications)) {
      return c.json(
        { success: false, message: "Invalid notification format" },
        400,
      );
    }

    logger.info(`Received ${notifications.length} webhook notifications`);

    // Process async to not block response
    this._processNotifications(notifications).catch((err) =>
      logger.error("Error processing notifications async:", err),
    );

    return c.json({ success: true, message: "Notifications processing" }, 202);
  };

  // --- Private Helpers ---

  private async _processNotifications(notifications: any[]) {
    for (const notification of notifications) {
      const { subscriptionId, clientState } = notification;
      const subscription = await OneDriveSubscription.findOne({
        subscriptionId,
      });

      if (!subscription || subscription.clientState !== clientState) continue;

      const session = await onedriveSessionRepository.findBySessionId(
        subscription.sessionId,
      );
      if (!session) continue;

      try {
        const deltaResult = await onedriveService.getDelta(
          session.access_token,
        );
        const changedIds = deltaResult.changes.map((change: any) => change.id);
        if (changedIds.length > 0) {
          await onedriveSyncService.markAsOutOfSync(
            changedIds,
            ExternalSource.ONEDRIVE,
          );
        }
      } catch (err) {
        logger.error("Error in webhook delta processing:", err);
      }
    }
  }

  private async _getSessionAndRefreshToken(sessionId: string) {
    let tokenData = await onedriveSessionRepository.findBySessionId(sessionId);
    if (!tokenData) return null;

    if (Date.now() >= tokenData.expires_at) {
      if (tokenData.refresh_token) {
        try {
          const newTokenData = await onedriveService.refreshAccessToken(
            tokenData.refresh_token,
          );
          tokenData = await onedriveSessionRepository.upsertBySessionId(
            sessionId,
            {
              access_token: newTokenData.access_token,
              refresh_token:
                newTokenData.refresh_token || tokenData.refresh_token,
              expires_at: Date.now() + newTokenData.expires_in * 1000,
            },
          );
        } catch (e) {
          logger.error("Failed to refresh token", e);
          return null;
        }
      } else {
        return null; // Expired and no refresh token
      }
    }
    return tokenData;
  }
}

export const onedriveController = new OneDriveController();
