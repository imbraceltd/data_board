/**
 * Base application error class
 * All custom errors should extend this class
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    this.code = code;

    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * 400 - Bad Request
 * Used for validation errors and malformed requests
 */
export class ValidationError extends AppError {
  constructor(message: string = "Validation failed", code: string = "40000") {
    super(message, 400, code);
    this.name = "ValidationError";
  }
}

/**
 * 401 - Unauthorized
 * Used for authentication errors
 */
export class AuthenticationError extends AppError {
  constructor(
    message: string = "Authentication failed",
    code: string = "40100",
  ) {
    super(message, 401, code);
    this.name = "AuthenticationError";
  }
}

/**
 * 403 - Forbidden
 * Used for authorization errors
 */
export class AuthorizationError extends AppError {
  constructor(
    message: string = "Authorization failed",
    code: string = "40300",
  ) {
    super(message, 403, code);
    this.name = "AuthorizationError";
  }
}

/**
 * 404 - Not Found
 * Used when a resource is not found
 */
export class NotFoundError extends AppError {
  constructor(message: string = "Resource not found", code: string = "40400") {
    super(message, 404, code);
    this.name = "NotFoundError";
  }
}

/**
 * 409 - Conflict
 * Used for resource conflicts (e.g., duplicate entries)
 */
export class ConflictError extends AppError {
  constructor(message: string = "Resource conflict", code: string = "40900") {
    super(message, 409, code);
    this.name = "ConflictError";
  }
}

/**
 * 500 - Internal Server Error
 * Used for database and other internal errors
 */
export class DatabaseError extends AppError {
  constructor(message: string = "Database error", code: string = "50000") {
    super(message, 500, code);
    this.name = "DatabaseError";
  }
}

/**
 * 500 - Internal Server Error
 * Used for external service failures
 */
export class ExternalServiceError extends AppError {
  constructor(
    message: string = "External service error",
    code: string = "50001",
  ) {
    super(message, 500, code);
    this.name = "ExternalServiceError";
  }
}

/**
 * 503 - Service Unavailable
 * Used when a service is temporarily unavailable
 */
export class ServiceUnavailableError extends AppError {
  constructor(message: string = "Service unavailable", code: string = "50300") {
    super(message, 503, code);
    this.name = "ServiceUnavailableError";
  }
}

/**
 * Alias for AuthenticationError (for consistency)
 */
export const UnauthorizedError = AuthenticationError;

/**
 * Specialised error for POST /boards/:parentId/attach-child and
 * POST /boards/:parentId/detach-child/:childId. Carries a stable string `code`
 * (e.g. CHILD_ALREADY_NESTED, FIELD_NAME_TAKEN) and an optional `details`
 * payload so the controller can echo legacy-shaped 4xx response bodies
 * (e.g. { code, message, unmapped_item_ids }).
 */
export class AttachDetachError extends AppError {
  public readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    statusCode: number,
    details?: Record<string, unknown>,
  ) {
    super(message, statusCode, code);
    this.name = "AttachDetachError";
    this.details = details;
  }
}
