import { Request, Response, NextFunction } from "express";
import { StoatError } from "../common/errors.js";

interface HttpishError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
  code?: string;
  expose?: boolean;
}

function send(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  res.status(status).json({
    error: {
      code,
      message,
      correlation_id: req.correlationId || crypto.randomUUID(),
      ...(details ? { details } : {}),
    },
  });
}

export function errorHandler(
  err: HttpishError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction,
): void {
  if (err instanceof StoatError) {
    // Tell well-behaved clients when to retry a throttled request.
    const retryAfter = err.details?.retry_after_seconds;
    if (err.statusCode === 429 && typeof retryAfter === "number") {
      res.setHeader("Retry-After", String(retryAfter));
    }
    send(req, res, err.statusCode, err.code, err.message, err.details);
    return;
  }

  // Malformed JSON / oversized bodies from express.json(): client errors, not server faults.
  if (err.type === "entity.parse.failed") {
    send(req, res, 400, "INVALID_JSON", "Request body is not valid JSON.");
    return;
  }
  if (err.type === "entity.too.large") {
    send(req, res, 413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
    return;
  }

  // Postgres 22P02 = invalid text representation, e.g. a non-UUID in a :id path segment
  // or JSON field. The caller supplied a bad identifier; do not leak it as a 500.
  if (err.code === "22P02") {
    send(
      req,
      res,
      400,
      "VALIDATION_FAILED",
      "One of the supplied identifiers or values is malformed.",
    );
    return;
  }

  console.error("[UnhandledError]", err);
  send(
    req,
    res,
    500,
    "INTERNAL_SERVER_ERROR",
    "An unexpected internal error occurred.",
  );
}
