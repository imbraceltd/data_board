/**
 * Dropbox Controller for Hono
 */

import type { Context } from "hono";
import { randomUUID } from "crypto";
import dropboxService from "../../core/services/dropbox.service";
import { dropboxSessionRepository } from "../../infrastructure/database/repositories";
import config from "../../config";
import logger from "../../infrastructure/logging/logger";

// Helper: Generate a unique session ID for OAuth state
function generateUniqueSessionId(): string {
  return `dropbox_session_${randomUUID()}`;
}

// Helper: Generate re-auth response
function generateReauthResponse(message: string) {
  const newSessionId = generateUniqueSessionId();
  const authUrl = dropboxService.getAuthUrl();
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

class DropboxController {
  // --- Authentication Routes ---

  /**
   * Initiate Dropbox Authentication
   * GET /api/auth/dropbox/initiate
   */
  initiateAuth = async (c: Context) => {
    const sessionId = generateUniqueSessionId();
    const authUrl = dropboxService.getAuthUrl();
    const authUrlWithState = `${authUrl}&state=${encodeURIComponent(sessionId)}`;

    return c.json({
      success: true,
      message: "Dropbox authentication URL generated",
      data: {
        auth_url: authUrlWithState,
        session_id: sessionId,
      },
    });
  };

  /**
   * Handle Authentication Callback
   * GET /api/auth/dropbox/callback
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
      `Processing Dropbox callback with code: ${code.substring(0, 10)}...`,
    );

    try {
      const tokenData = await dropboxService.getAccessToken(code);
      logger.info("Dropbox token exchange successful");

      const expiresAt = Date.now() + tokenData.expires_in * 1000;

      await dropboxSessionRepository.upsertBySessionId(sessionId, {
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
             body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #0061ff 0%, #60efff 100%); }
             .container { background: white; padding: 3rem; border-radius: 1rem; box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center; max-width: 400px; }
             h1 { color: #1f2937; }
             p { color: #6b7280; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Login Successful!</h1>
            <p>You have successfully authenticated with Dropbox. Please return to iMBrace to continue.</p>
          </div>
          <script>
            (function() {
              const authData = {
                type: 'AUTH_SUCCESS',
                provider: 'dropbox',
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
                   try { localStorage.setItem('dropbox_auth_success', JSON.stringify(authData)); } catch(e){}
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
      logger.error("Dropbox callback processing error:", error);
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
   * GET /api/auth/dropbox/session/status
   */
  getSessionStatus = async (c: Context) => {
    const sessionId = c.req.query("sessionId");

    if (!sessionId) {
      return c.json({ success: false, message: "Session ID is required" }, 400);
    }

    const tokenData = await dropboxSessionRepository.findBySessionId(sessionId);
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

  // --- Dropbox API Routes ---

  /**
   * Get Folders
   * GET /api/dropbox/folders
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

    let allFolders;
    if (folderId) {
      allFolders = await dropboxService.getDriveFolders(
        tokenData.access_token,
        folderId,
      );
    } else {
      allFolders = await dropboxService.getDriveRootFolders(
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
   * GET /api/dropbox/files
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

    const allFiles = await dropboxService.getDriveFiles(
      tokenData.access_token,
      folderId || "",
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
   * GET /api/dropbox/files/download
   */
  downloadFile = async (c: Context) => {
    const sessionId = c.req.query("sessionId");
    const filePath = c.req.query("filePath");

    if (!sessionId || !filePath)
      return c.json(
        { success: false, message: "Session ID and File Path required" },
        400,
      );

    const tokenData = await this._getSessionAndRefreshToken(sessionId);
    if (!tokenData)
      return c.json(generateReauthResponse("Session expired"), 401);

    const downloadData = await dropboxService.downloadFile(
      tokenData.access_token,
      filePath,
    );
    return c.redirect(downloadData.url);
  };

  // --- Private Helpers ---

  private async _getSessionAndRefreshToken(sessionId: string) {
    let tokenData = await dropboxSessionRepository.findBySessionId(sessionId);
    if (!tokenData) return null;

    if (Date.now() >= tokenData.expires_at) {
      if (tokenData.refresh_token) {
        try {
          const newTokenData = await dropboxService.refreshAccessToken(
            tokenData.refresh_token,
          );
          tokenData = await dropboxSessionRepository.upsertBySessionId(
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

export const dropboxController = new DropboxController();
