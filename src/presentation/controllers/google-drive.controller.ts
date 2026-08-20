/**
 * Google Drive Controller for Hono
 */

import type { Context } from "hono";
import { randomUUID } from "crypto";
import googleDriveService from "../../core/services/google-drive.service";
import googleDrivePollingService from "../../core/services/google-drive-polling.service";
import { googleDriveSessionRepository } from "../../infrastructure/database/repositories";
import Folder from "../../db/models/folder.model";
import { ExternalSource } from "../../core/enums/external-source.enum";
import config from "../../config";
import logger from "../../infrastructure/logging/logger";
import { stream } from "hono/streaming";

// Helper: Generate a unique session ID for OAuth state
function generateUniqueSessionId(): string {
  return `google_drive_session_${randomUUID()}`;
}

// Helper: Generate re-auth response
function generateReauthResponse(message: string) {
  const newSessionId = generateUniqueSessionId();
  const authUrl = googleDriveService.getAuthUrl();
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

class GoogleDriveController {
  // --- Authentication Routes ---

  /**
   * Initiate Google Drive Authentication
   * GET /api/auth/google-drive/initiate
   */
  initiateAuth = async (c: Context) => {
    const sessionId = generateUniqueSessionId();
    const { clientId, redirectUri } = config.googleDrive;
    const scope = [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive.readonly",
    ].join(" ");

    // Include session ID as state parameter for OAuth flow
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(
      redirectUri,
    )}&scope=${encodeURIComponent(
      scope,
    )}&access_type=offline&prompt=consent&state=${encodeURIComponent(sessionId)}`;

    return c.json({
      success: true,
      message: "Google Drive authentication URL generated",
      data: {
        auth_url: authUrl,
        session_id: sessionId,
      },
    });
  };

  /**
   * Handle Authentication Callback
   * GET /api/auth/google-drive/callback
   */
  handleCallback = async (c: Context) => {
    const code = c.req.query("code");
    const sessionId = c.req.query("state") || "default_session";

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
      `Processing Google Drive callback with code: ${code.substring(0, 10)}...`,
    );

    try {
      const tokenData = await googleDriveService.getAccessToken(code);
      logger.info("Google Drive token exchange successful");

      const expiresAt = Date.now() + tokenData.expires_in * 1000;

      await googleDriveSessionRepository.upsertBySessionId(sessionId, {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
      });

      // Return HTML success page
      return c.html(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Authentication Successful</title>
          <style>
             body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #4285F4 0%, #34A853 100%); }
             .container { background: white; padding: 3rem; border-radius: 1rem; box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center; max-width: 400px; }
             h1 { color: #1f2937; }
             p { color: #6b7280; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Login Successful!</h1>
            <p>You have successfully authenticated with Google Drive. Please return to iMBrace to continue.</p>
          </div>
          <script>
            (function() {
              const authData = {
                type: 'AUTH_SUCCESS',
                provider: 'google_drive',
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
                   try { localStorage.setItem('google_drive_auth_success', JSON.stringify(authData)); } catch(e){}
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
      logger.error("Google Drive callback processing error:", error);
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
   * GET /api/auth/google-drive/session/status
   */
  getSessionStatus = async (c: Context) => {
    const sessionId = c.req.query("sessionId");

    if (!sessionId) {
      return c.json({ success: false, message: "Session ID is required" }, 400);
    }

    const tokenData = await googleDriveSessionRepository.findBySessionId(
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

  // --- Google Drive API Routes ---

  /**
   * Get Folders
   * GET /api/google-drive/folders
   */
  getFolders = async (c: Context) => {
    const queries = c.req.query();
    const { sessionId, parentId, skip, limit, sortBy, sortOrder } = queries;
    const qParam = queries.q;
    const searchQuery = qParam && qParam.trim().length > 0 ? qParam.trim() : "";

    if (!sessionId)
      return c.json({ success: false, message: "Session ID is required" }, 400);

    let tokenData = await this._getSessionAndRefreshToken(sessionId);
    if (!tokenData)
      return c.json(generateReauthResponse("Session expired"), 401);

    let allFolders;
    if (parentId) {
      allFolders = await googleDriveService.getDriveFolders(
        tokenData.access_token,
        parentId,
      );
    } else {
      allFolders = await googleDriveService.getDriveRootFolders(
        tokenData.access_token,
      );
    }

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
   * GET /api/google-drive/files
   */
  getFiles = async (c: Context) => {
    const queries = c.req.query();
    const { sessionId, parentId, skip, limit, sortBy, sortOrder, recursive } =
      queries;
    const qParam = queries.q;
    const searchQuery = qParam && qParam.trim().length > 0 ? qParam.trim() : "";

    if (!sessionId)
      return c.json({ success: false, message: "Session ID is required" }, 400);

    const tokenData = await this._getSessionAndRefreshToken(sessionId);
    if (!tokenData)
      return c.json(generateReauthResponse("Session expired"), 401);

    const isRecursive = recursive === "true";

    const allFiles = await googleDriveService.getDriveFiles(
      tokenData.access_token,
      parentId || "root",
      undefined,
      undefined,
      sortBy,
      sortOrder as "asc" | "desc",
      isRecursive,
      sessionId,
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
   * GET /api/google-drive/files/download
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

    const downloadData = await googleDriveService.downloadFileStream(
      tokenData.access_token,
      fileId,
    );

    c.header(
      "Content-Type",
      downloadData.mimeType || "application/octet-stream",
    );
    c.header(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(downloadData.filename)}"`,
    );

    // Convert Node Readable to Web ReadableStream for Hono
    // Since we are in Node environment with Hono node-server, we can try passing the Node stream directly
    // If not supported, we can wrap it.
    // For now, let's use Hono stream helper

    return stream(c, async (stream) => {
      // Pipe the node stream to the Hono stream
      const nodeStream = downloadData.stream;
      for await (const chunk of nodeStream) {
        await stream.write(chunk);
      }
    });
  };

  // --- Sync Management ---

  /**
   * Get Sync Status
   * GET /api/google-drive/sync/status
   */
  getSyncStatus = async (c: Context) => {
    const status = googleDrivePollingService.getStatus();
    return c.json({
      success: true,
      message: "Polling status retrieved",
      data: status,
    });
  };

  /**
   * Enable Folder Sync
   * PUT /api/google-drive/sync/folders/:folderId/enable
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
   * PUT /api/google-drive/sync/folders/:folderId/disable
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
   * POST /api/google-drive/sync/folders/:folderId
   */
  syncFolder = async (c: Context) => {
    const folderId = c.req.param("folderId");
    await googleDrivePollingService.syncFolderById(folderId);
    return c.json({
      success: true,
      message: "Sync triggered",
      data: { folderId },
    });
  };

  /**
   * Get Sync Enabled Folders
   * GET /api/google-drive/sync/folders
   */
  getSyncEnabledFolders = async (c: Context) => {
    const organizationId = c.req.query("organizationId");
    const query: any = {
      external_source: ExternalSource.GOOGLE_DRIVE,
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

  // --- Private Helpers ---

  private async _getSessionAndRefreshToken(sessionId: string) {
    let tokenData = await googleDriveSessionRepository.findBySessionId(
      sessionId,
    );
    if (!tokenData) return null;

    if (Date.now() >= tokenData.expires_at) {
      if (tokenData.refresh_token) {
        try {
          const newTokenData = await googleDriveService.refreshAccessToken(
            tokenData.refresh_token,
          );
          tokenData = await googleDriveSessionRepository.upsertBySessionId(
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

export const googleDriveController = new GoogleDriveController();
