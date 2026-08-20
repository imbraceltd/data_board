/**
 * Providers Controller for Hono
 *
 * Reports which external storage providers (OneDrive, Google Drive, Dropbox)
 * are wired up via env credentials so the frontend can show/hide their
 * "connect" buttons. Only booleans are returned — client ids/secrets/keys are
 * never exposed.
 */

import type { Context } from "hono";
import config from "../../config";

class ProvidersController {
  /**
   * GET /api/providers
   * Lists storage providers and whether each has usable credentials configured.
   */
  list = async (c: Context) => {
    const { onedrive, googleDrive, dropbox } = config;
    const providers = [
      { provider: "onedrive", configured: !!(onedrive.clientId && onedrive.clientSecret) },
      { provider: "google_drive", configured: !!(googleDrive.clientId && googleDrive.clientSecret) },
      { provider: "dropbox", configured: !!(dropbox.appKey && dropbox.appSecret) },
    ];
    return c.json({ success: true, data: providers });
  };
}

// Export singleton instance
export const providersController = new ProvidersController();
