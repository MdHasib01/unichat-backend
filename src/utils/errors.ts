export type ApiErrorDetail = { field?: string; message: string };

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details: ApiErrorDetail[];
  public readonly expose: boolean;

  constructor(
    message: string,
    statusCode = 500,
    code = 'INTERNAL_ERROR',
    details: ApiErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = statusCode < 500;
    Error.captureStackTrace?.(this, AppError);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details: ApiErrorDetail[] = [], code = 'BAD_REQUEST') {
    super(message, 400, code, details);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details: ApiErrorDetail[] = []) {
    super(message, 422, 'VALIDATION_ERROR', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHORIZED') {
    super(message, 401, code);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action', code = 'FORBIDDEN') {
    super(message, 403, code);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource', code = 'NOT_FOUND') {
    super(`${resource} not found`, 404, code);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists', code = 'CONFLICT') {
    super(message, 409, code);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests, please slow down') {
    super(message, 429, 'RATE_LIMITED');
  }
}

export class IntegrationError extends AppError {
  constructor(message = 'Integration request failed', details: ApiErrorDetail[] = []) {
    super(message, 502, 'INTEGRATION_ERROR', details);
  }
}
