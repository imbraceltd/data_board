/**
 * Middleware Index
 *
 * Central export point for all Hono middleware
 */

export { errorHandler } from "./errorHandler.middleware";
export { httpLogger } from "./logger.middleware";
export { requestContext } from "./request-context.middleware";
export { databaseMiddleware } from "./database.middleware";

// Board-specific middleware
export {
  injectDatabase,
  extractUserContext,
  resolveTeamScope,
  extractCredentials,
  requireOrganization,
  requireUser,
  requestLogger,
} from "./context.middleware";

export {
  errorHandler as boardErrorHandler,
  corsConfig,
} from "./error.middleware";
