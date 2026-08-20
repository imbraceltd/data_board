/**
 * Error Handler Middleware for Hono
 *
 * Global error handler that catches all errors in the Hono application
 * Maps custom error classes to appropriate HTTP status codes and responses
 */

import type { Context } from "hono";
import { AppError } from "../../domain/shared/errors";
import logger from "../../infrastructure/logging/logger";

/**
 * Error handler middleware
 * Use with app.onError() in Hono
 */
export const errorHandler = (err: Error, c: Context) => {
  let statusCode = 500;
  let message = "Internal server error";
  let code: string | undefined;

  // Handle custom AppError instances
  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    code = err.code;
  }

  // Log error with context
  const cause = (err as any).cause;
  logger.error(`${err.name}: ${err.message}`, {
    stack: err.stack,
    cause: cause instanceof Error ? { message: cause.message, stack: cause.stack } : cause,
    url: c.req.url,
    method: c.req.method,
  });

  // Determine if we should expose error details
  const isDevelopment = process.env.NODE_ENV === "development";

  // Build error response
  const errorResponse: any = {
    success: false,
    error: {
      message,
    },
  };

  // Add error code if available
  if (code) {
    errorResponse.error.code = code;
  }

  // Add stack trace in development
  if (isDevelopment && err.stack) {
    errorResponse.error.stack = err.stack;
  }

  // Return error response
  return c.json(errorResponse, statusCode);
};
