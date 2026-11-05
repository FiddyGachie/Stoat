import { Request, Response, NextFunction } from 'express';
import { StoatError } from '../common/errors.js';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  const correlationId = req.correlationId || crypto.randomUUID();

  if (err instanceof StoatError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        correlation_id: correlationId,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  console.error('[UnhandledError]', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal error occurred.',
      correlation_id: correlationId,
    },
  });
}
