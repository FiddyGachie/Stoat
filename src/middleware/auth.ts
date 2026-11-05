import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/connection.js';
import { AuthenticatedPrincipal, AgentRole, UserRole } from '../common/types.js';
import { ForbiddenActionError, StoatError } from '../common/errors.js';

declare global {
  namespace Express {
    interface Request {
      principal?: AuthenticatedPrincipal;
      correlationId?: string;
    }
  }
}

export function authMiddleware(requiredRole?: (AgentRole | UserRole)[] | (AgentRole | UserRole)) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing or malformed Authorization header with Bearer token.',
            correlation_id: req.correlationId || 'corr_unknown',
          },
        });
        return;
      }

      const token = authHeader.substring(7).trim();
      const db = getDb();
      let principal: AuthenticatedPrincipal | null = null;

      if (token.startsWith('agent:')) {
        const agentId = token.substring(6);
        const result = await db.query(
          'SELECT id, tenant_id, role, name, status, scopes FROM agents WHERE id = $1',
          [agentId]
        );
        if (result.rows.length === 0) {
          res.status(401).json({
            error: {
              code: 'INVALID_CREDENTIALS',
              message: `Agent '${agentId}' not found.`,
              correlation_id: req.correlationId || 'corr_unknown',
            },
          });
          return;
        }

        const agent = result.rows[0];
        if (agent.status !== 'active') {
          res.status(403).json({
            error: {
              code: 'AGENT_SUSPENDED',
              message: `Agent '${agent.name}' is ${agent.status}.`,
              correlation_id: req.correlationId || 'corr_unknown',
            },
          });
          return;
        }

        principal = {
          id: agent.id,
          tenantId: agent.tenant_id,
          type: 'agent',
          role: agent.role as AgentRole,
          scopes: typeof agent.scopes === 'string' ? JSON.parse(agent.scopes) : agent.scopes,
          name: agent.name,
        };
      } else if (token.startsWith('user:')) {
        const userId = token.substring(5);
        const result = await db.query(
          'SELECT id, tenant_id, email, role FROM users WHERE id = $1',
          [userId]
        );
        if (result.rows.length === 0) {
          res.status(401).json({
            error: {
              code: 'INVALID_CREDENTIALS',
              message: `User '${userId}' not found.`,
              correlation_id: req.correlationId || 'corr_unknown',
            },
          });
          return;
        }

        const user = result.rows[0];
        principal = {
          id: user.id,
          tenantId: user.tenant_id,
          type: 'user',
          role: user.role as UserRole,
          scopes: ['all'],
          name: user.email,
        };
      } else {
        // Standard JWT verification
        const secret = process.env.JWT_SECRET || 'stoat-jwt-secret-key-32-chars-minimum!';
        try {
          const decoded = jwt.verify(token, secret) as any;
          principal = {
            id: decoded.sub,
            tenantId: decoded.tenant_id,
            type: decoded.type || 'agent',
            role: decoded.role,
            scopes: decoded.scopes || [],
            name: decoded.name || decoded.sub,
          };
        } catch {
          res.status(401).json({
            error: {
              code: 'INVALID_TOKEN',
              message: 'Invalid or expired JWT token.',
              correlation_id: req.correlationId || 'corr_unknown',
            },
          });
          return;
        }
      }

      req.principal = principal;

      // Role check
      if (requiredRole) {
        const allowedRoles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
        if (!allowedRoles.includes(principal.role)) {
          throw new ForbiddenActionError(
            `Role '${principal.role}' is not authorized. Required: ${allowedRoles.join(', ')}`
          );
        }
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
