export enum ErrorCode {
  VALIDATION_ERROR = "VALIDATION_ERROR",
  NOT_FOUND = "NOT_FOUND",
  CONFLICT = "CONFLICT",
  INVALID_STATE_TRANSITION = "INVALID_STATE_TRANSITION",
  UNSUPPORTED_PROVIDER_OPERATION = "UNSUPPORTED_PROVIDER_OPERATION",
  PROVIDER_ERROR = "PROVIDER_ERROR",
  WEBHOOK_VERIFICATION_FAILED = "WEBHOOK_VERIFICATION_FAILED",
  INTERNAL_ERROR = "INTERNAL_ERROR",
  TIMEOUT = "TIMEOUT",
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details: unknown;

  constructor(code: ErrorCode, message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(ErrorCode.VALIDATION_ERROR, message, 400, details);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(ErrorCode.NOT_FOUND, message, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(ErrorCode.CONFLICT, message, 409, details);
    this.name = "ConflictError";
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(message: string) {
    super(ErrorCode.INVALID_STATE_TRANSITION, message, 409);
    this.name = "InvalidStateTransitionError";
  }
}

export class UnsupportedProviderOperationError extends AppError {
  constructor(message: string) {
    super(ErrorCode.UNSUPPORTED_PROVIDER_OPERATION, message, 422);
    this.name = "UnsupportedProviderOperationError";
  }
}

export class ProviderError extends AppError {
  constructor(message: string, details?: unknown) {
    super(ErrorCode.PROVIDER_ERROR, message, 502, details);
    this.name = "ProviderError";
  }
}

export class WebhookVerificationError extends AppError {
  constructor(message: string) {
    super(ErrorCode.WEBHOOK_VERIFICATION_FAILED, message, 401);
    this.name = "WebhookVerificationError";
  }
}
