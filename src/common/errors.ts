export interface ErrorPayload {
  error: {
    code: string;
    message: string;
    correlation_id: string;
    details?: Record<string, any>;
  };
}

export class StoatError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: Record<string, any>;

  constructor(code: string, message: string, statusCode: number = 400, details?: Record<string, any>) {
    super(message);
    this.name = 'StoatError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ValidationError extends StoatError {
  constructor(message: string, details?: Record<string, any>) {
    super('VALIDATION_FAILED', message, 400, details);
  }
}

export class NotFoundError extends StoatError {
  constructor(resource: string, id?: string) {
    super('NOT_FOUND', `${resource}${id ? ` '${id}'` : ''} not found.`, 404);
  }
}

export class ForbiddenActionError extends StoatError {
  constructor(message: string = 'You do not have permission to perform this action.') {
    super('FORBIDDEN_ACTION', message, 403);
  }
}

export class ForbiddenError extends StoatError {
  constructor(message: string = 'You do not have permission to perform this action.') {
    super('FORBIDDEN_ACTION', message, 403);
  }
}

export class ConflictError extends StoatError {
  constructor(code: string = 'STATE_CONFLICT', message?: string, details?: Record<string, any>) {
    super(code, message || code, 409, details);
  }
}

export class InvalidTransitionError extends StoatError {
  constructor(message: string, details?: Record<string, any>) {
    super('INVALID_TRANSITION', message, 422, details);
  }
}

export class IdempotencyConflictError extends StoatError {
  constructor(message: string = 'Idempotency key re-used with different request payload.') {
    super('IDEMPOTENCY_CONFLICT', message, 409);
  }
}

export class PolicyDeniedError extends StoatError {
  constructor(message: string, details?: Record<string, any>) {
    super('POLICY_DENIED', message, 422, details);
  }
}

export class BudgetExceededError extends StoatError {
  constructor(message: string = 'Requested spend exceeds mission budget ceiling.', details?: Record<string, any>) {
    super('BUDGET_EXCEEDED', message, 422, details);
  }
}

export class QuoteExpiredError extends StoatError {
  constructor(message: string = 'The quote has expired and cannot be accepted.') {
    super('QUOTE_EXPIRED', message, 422);
  }
}
