import { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/connection.js';
import { sha256 } from '../common/crypto.js';
import { IdempotencyConflictError } from '../common/errors.js';

export function idempotencyMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.headers['idempotency-key'] as string;
    if (!key || req.method === 'GET' || req.method === 'HEAD') {
      return next();
    }

    const principal = req.principal;
    if (!principal) {
      return next();
    }

    const tenantId = principal.tenantId;
    const principalId = principal.id;
    const route = req.baseUrl + req.path;
    const requestHash = sha256(req.body || {});

    const db = getDb();
    const existing = await db.query(
      `SELECT request_hash, response_code, response_body 
       FROM idempotency_keys 
       WHERE tenant_id = $1 AND principal_id = $2 AND route = $3 AND idempotency_key = $4`,
      [tenantId, principalId, route, key]
    );

    if (existing.rows.length > 0) {
      const record = existing.rows[0];
      if (record.request_hash !== requestHash) {
        return next(new IdempotencyConflictError());
      }

      // Replay stored response
      res.setHeader('X-Idempotent-Replay', 'true');
      res.status(record.response_code).json(record.response_body);
      return;
    }

    // Intercept response to store it
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      // Restore before sending
      res.json = originalJson;

      const statusCode = res.statusCode;
      // Store in idempotency_keys asynchronously
      if (statusCode >= 200 && statusCode < 300) {
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
        db.query(
          `INSERT INTO idempotency_keys (
            id, tenant_id, principal_id, route, idempotency_key, request_hash, response_code, response_body, expires_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8
          ) ON CONFLICT (tenant_id, principal_id, route, idempotency_key) DO NOTHING;`,
          [tenantId, principalId, route, key, requestHash, statusCode, JSON.stringify(body), expiresAt]
        ).catch((err) => {
          console.error('[Idempotency] Failed to store idempotency record:', err);
        });
      }

      return originalJson(body);
    };

    next();
  };
}
