/**
 * Health Controller for Hono
 *
 * Simple health check endpoint
 */

import type { Context } from "hono";
import { isDatabaseConnected } from "../../infrastructure/database/factory";

/**
 * Health Controller Class
 */
class HealthController {
  /**
   * Health check endpoint
   * Returns application status and database connectivity
   */
  check = async (c: Context) => {
    const dbConnected = isDatabaseConnected();

    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      database: dbConnected ? "connected" : "disconnected",
    });
  };
}

// Export singleton instance
export const healthController = new HealthController();
