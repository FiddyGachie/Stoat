import { StoatError } from "../../common/errors.js";

export class FeatureDisabledError extends StoatError {
  constructor(flag: string) {
    super(
      "FEATURE_DISABLED",
      `The ${flag} feature is disabled for this tenant.`,
      403,
      { flag },
    );
  }
}

export class MandateRefusalError extends StoatError {
  constructor(code: string, details?: Record<string, unknown>) {
    super(
      code,
      "The requested acceptance is outside the Mandate's permitted terms.",
      422,
      details,
    );
  }
}

export class RateLimitedError extends StoatError {
  constructor(scope: string) {
    super("RATE_LIMITED", "The request rate limit was reached.", 429, {
      scope,
    });
  }
}

export class HoldActiveError extends StoatError {
  constructor(details?: Record<string, unknown>) {
    super(
      "HOLD_ACTIVE",
      "This operation is blocked by an active Hold.",
      422,
      details,
    );
  }
}

export class HoldSubjectInvalidError extends StoatError {
  constructor() {
    super(
      "HOLD_SUBJECT_INVALID",
      "The requested Hold subject is invalid.",
      422,
    );
  }
}

export class MandateTermsImmutableError extends StoatError {
  constructor() {
    super(
      "MANDATE_TERMS_IMMUTABLE",
      "Mandate terms cannot be changed after creation.",
      400,
    );
  }
}

export class MandateRequiresWalletModeError extends StoatError {
  constructor() {
    super(
      "MANDATE_REQUIRES_WALLET_MODE",
      "Mandates require wallet funding mode.",
      409,
    );
  }
}

export class MandateStateConflictError extends StoatError {
  constructor(details?: Record<string, unknown>) {
    super(
      "MANDATE_STATE_CONFLICT",
      "The Mandate is in a state that does not allow this change.",
      409,
      details,
    );
  }
}

export class AgentOutputInvalidError extends StoatError {
  constructor(
    message = "Agent output failed schema or domain validation.",
    details?: Record<string, unknown>,
  ) {
    super("AGENT_OUTPUT_INVALID", message, 422, details);
  }
}

export class ModelTimeoutError extends StoatError {
  constructor() {
    super(
      "MODEL_TIMEOUT",
      "The model call exceeded its time limit and its output was discarded.",
      504,
    );
  }
}

export class ModelBudgetExceededError extends StoatError {
  constructor() {
    super(
      "MODEL_BUDGET_EXCEEDED",
      "The tenant's daily model-cost budget was reached.",
      429,
    );
  }
}

export class ProposalTooLargeError extends StoatError {
  constructor(maxBytes: number) {
    super(
      "PROPOSAL_TOO_LARGE",
      "The proposal payload exceeds the size limit.",
      413,
      { max_bytes: maxBytes },
    );
  }
}

export class ProposalExpiredError extends StoatError {
  constructor() {
    super(
      "PROPOSAL_EXPIRED",
      "The proposal has expired and cannot be approved.",
      409,
    );
  }
}

export class ProposalInvalidError extends StoatError {
  constructor(reasonCodes: string[]) {
    super("PROPOSAL_INVALID", "The proposal failed validation.", 422, {
      reason_codes: reasonCodes,
    });
  }
}

export class InvalidDateRangeError extends StoatError {
  constructor() {
    super(
      "INVALID_DATE_RANGE",
      "The date range is malformed, reversed or longer than 366 days.",
      400,
    );
  }
}

export class AnalyticsTimeoutError extends StoatError {
  constructor() {
    super(
      "ANALYTICS_TIMEOUT",
      "The analytics query exceeded its time limit.",
      504,
    );
  }
}

export class QuestionInvalidError extends StoatError {
  constructor() {
    super("QUESTION_INVALID", "The question must be 1 to 500 characters.", 400);
  }
}
