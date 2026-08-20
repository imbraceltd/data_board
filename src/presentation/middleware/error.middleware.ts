/**
 * Error Handling Middleware
 * Global error handler for the API
 */

import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  UnauthorizedError,
  DatabaseError,
} from "../../domain/shared/errors";
import logger from "../../infrastructure/logging/logger";

/**
 * Global error handling middleware
 */
export function errorHandler() {
  return async (c: Context, next: Next) => {
    try {
      await next();
    } catch (error) {
      logger.error("Request error:", error);

      // Handle custom domain errors
      if (error instanceof ValidationError) {
        return c.json(
          {
            error: "Validation Error",
            message: error.message,
          },
          400,
        );
      }

      if (error instanceof NotFoundError) {
        return c.json(
          {
            error: "Not Found",
            message: error.message,
          },
          404,
        );
      }

      if (error instanceof ConflictError) {
        return c.json(
          {
            error: "Conflict",
            message: error.message,
          },
          409,
        );
      }

      if (error instanceof UnauthorizedError) {
        return c.json(
          {
            error: "Unauthorized",
            message: error.message,
          },
          401,
        );
      }

      if (error instanceof DatabaseError) {
        return c.json(
          {
            error: "Database Error",
            message: "An error occurred while accessing the database",
          },
          500,
        );
      }

      // Handle Hono HTTP exceptions
      if (error instanceof HTTPException) {
        return c.json(
          {
            error: error.message,
          },
          error.status,
        );
      }

      // Handle unknown errors
      const errorMessage =
        error instanceof Error ? error.message : "An unexpected error occurred";

      return c.json(
        {
          error: "Internal Server Error",
          message:
            process.env.NODE_ENV === "development"
              ? errorMessage
              : "An unexpected error occurred",
        },
        500,
      );
    }
  };
}

/**
 * CORS middleware configuration
 */
export function corsConfig() {
  return {
    origin: process.env.ALLOWED_ORIGINS?.split(",") || ["*"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "x-user-id",
      "x-organization-id",
      "x-team-ids",
    ],
    exposeHeaders: ["Content-Length", "X-Request-Id"],
    maxAge: 600,
    credentials: true,
  };
}
