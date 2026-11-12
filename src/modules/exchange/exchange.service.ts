import { randomUUID } from "node:crypto";
import { DbClient, transaction } from '../../db/connection.js';
import { Decimal } from "decimal.js";
import { ValidationError } from '../../common/errors.js';
import { toDecimalString, validateAmount } from '../../common/decimal.js';

/** Rule ids the grounded verifier understands for code review (SEC/BUG/PERF families). */
const DEFAULT_REVIEW_PROFILE = {
  method: 'grounded_verification',
  version: '1.0.0',
  allowed_rules: ['SEC-001', 'SEC-002', 'SEC-003', 'BUG-001', 'BUG-002', 'PERF-001'],
  allowed_severities: ['low', 'medium', 'high', 'critical'],
  max_findings: 10,
  min_coverage_pct: 100,
};
export interface ServiceListing {
  id: string;
  provider_id: string;
  name: string;
  description: string;
  category: string;
  pricing_model: string;
  unit_price: string;
  currency: string;
  unit: string;
  constraints: any;
  verification_profile: any;
  status: string;
  /** True when the provider will consider a lower price. The floor itself is never exposed. */
  negotiable?: boolean;
  /** hosted: Stoat runs the model review; external: the provider delivers through the API. */
  execution_mode?: string;
}

export class ExchangeService {
  constructor(private db: DbClient) {}

  async listServices(tenantId: string, category?: string): Promise<ServiceListing[]> {
    let sql = `
      SELECT id, provider_id, name, description, category, pricing_model, unit_price, currency, unit,
             constraints, verification_profile, status, (min_price IS NOT NULL) AS negotiable, execution_mode
      FROM services
      WHERE tenant_id = $1 AND status = 'active'
    `;
    const params: any[] = [tenantId];

    if (category) {
      sql += ' AND category = $2';
      params.push(category);
    }

    sql += ' ORDER BY created_at ASC';

    const res = await this.db.query(sql, params);
    return res.rows.map((row: any) => ({
      ...row,
      unit_price: String(row.unit_price),
      constraints: typeof row.constraints === 'string' ? JSON.parse(row.constraints) : row.constraints,
      verification_profile: typeof row.verification_profile === 'string' ? JSON.parse(row.verification_profile) : row.verification_profile,
    }));
  }

  async getService(tenantId: string, serviceId: string): Promise<ServiceListing | null> {
    const res = await this.db.query(
      `SELECT id, provider_id, name, description, category, pricing_model, unit_price, currency, unit,
              constraints, verification_profile, status, (min_price IS NOT NULL) AS negotiable, execution_mode
       FROM services
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, serviceId]
    );

    if (res.rows.length === 0) {
      return null;
    }

    const row = res.rows[0];
    return {
      ...row,
      unit_price: String(row.unit_price),
      constraints: typeof row.constraints === 'string' ? JSON.parse(row.constraints) : row.constraints,
      verification_profile: typeof row.verification_profile === 'string' ? JSON.parse(row.verification_profile) : row.verification_profile,
    };
  }

  async publishService(input: {
    tenantId: string;
    providerId: string;
    name?: unknown;
    description?: unknown;
    category?: unknown;
    unitPrice?: unknown;
    currency?: unknown;
    unit?: unknown;
    constraints?: unknown;
    schema?: unknown;
    verificationProfile?: unknown;
    minPrice?: unknown;
    executionMode?: unknown;
    correlationId?: string;
  }): Promise<ServiceListing> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    const category = typeof input.category === 'string' ? input.category.trim() : '';
    const unit = typeof input.unit === 'string' ? input.unit.trim() : '';
    const unitPrice = typeof input.unitPrice === 'string' ? input.unitPrice : '';
    const currency = typeof input.currency === 'string' ? input.currency.toUpperCase() : '';

    if (!name || name.length > 120 || !description || description.length > 2000) {
      throw new ValidationError('Service name and description are required and must be within the allowed length.');
    }
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(category)) {
      throw new ValidationError('Category must be a lowercase identifier.');
    }
    if (!unit || unit.length > 40 || !validateAmount(unitPrice) || !new Decimal(unitPrice).greaterThan(0)) {
      throw new ValidationError('A unit, and a positive decimal unit price with up to 6 places, are required.');
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ValidationError('Currency must be a three-letter ISO currency code.');
    }
    let minPrice: string | null = null;
    if (input.minPrice !== undefined && input.minPrice !== null && input.minPrice !== '') {
      if (typeof input.minPrice !== 'string' || !validateAmount(input.minPrice) || !new Decimal(input.minPrice).greaterThan(0) || new Decimal(input.minPrice).greaterThan(unitPrice)) {
        throw new ValidationError('min_price must be a positive decimal no higher than the unit price.');
      }
      minPrice = toDecimalString(input.minPrice);
    }
    const executionMode = input.executionMode === undefined || input.executionMode === null || input.executionMode === '' ? 'external' : input.executionMode;
    if (executionMode !== 'hosted' && executionMode !== 'external') {
      throw new ValidationError("execution_mode must be 'hosted' (Stoat runs the review) or 'external' (you deliver through the API).");
    }
    const objectOrEmpty = (value: unknown, field: string): Record<string, unknown> => {
      if (value === undefined) return {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(`${field} must be an object.`);
      }
      return value as Record<string, unknown>;
    };

    const constraints = objectOrEmpty(input.constraints, 'Constraints');
    const schema = objectOrEmpty(input.schema, 'Schema');
    const suppliedProfile = objectOrEmpty(input.verificationProfile, 'Verification profile');
    // A service with no allowed rules can never pass grounded verification, so it could
    // never be paid. Default to the standard review profile, and reject profiles that
    // would make delivery impossible rather than letting the provider find out later.
    const verificationProfile = Object.keys(suppliedProfile).length === 0 ? { ...DEFAULT_REVIEW_PROFILE } : suppliedProfile;
    const rules = (verificationProfile as { allowed_rules?: unknown }).allowed_rules;
    if (
      !Array.isArray(rules) ||
      rules.length === 0 ||
      rules.length > 50 ||
      !rules.every((r) => typeof r === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(r))
    ) {
      throw new ValidationError('verification_profile.allowed_rules must list 1-50 rule ids, otherwise no delivery could ever be verified.');
    }
    const service = await transaction(async (tx) => {
      const result = await tx.query<ServiceListing>(
        `INSERT INTO services (
           tenant_id, provider_id, name, description, category, pricing_model, unit_price,
           currency, unit, constraints, schema, verification_profile, status, min_price, execution_mode
         ) VALUES ($1, $2, $3, $4, $5, 'fixed_unit', $6, $7, $8, $9, $10, $11, 'active', $12, $13)
         RETURNING id, provider_id, name, description, category, pricing_model, unit_price,
                   currency, unit, constraints, verification_profile, status, execution_mode`,
        [
          input.tenantId,
          input.providerId,
          name,
          description,
          category,
          toDecimalString(unitPrice),
          currency,
          unit,
          JSON.stringify(constraints),
          JSON.stringify(schema),
          JSON.stringify(verificationProfile),
          minPrice,
          executionMode,
        ],
      );
      await tx.query(
        `INSERT INTO audit_logs (
           tenant_id, actor_type, actor_id, action, resource_type, resource_id,
           correlation_id, outcome, metadata
         ) VALUES ($1, 'agent', $2, 'service.publish', 'service', $3, $4, 'success', $5)`,
        [
          input.tenantId,
          input.providerId,
          result.rows[0].id,
          input.correlationId ?? randomUUID(),
          JSON.stringify({ category, currency, unit_price: toDecimalString(unitPrice) }),
        ],
      );
      return result.rows[0];
    });
    return {
      ...service,
      unit_price: String(service.unit_price),
      constraints: typeof service.constraints === 'string' ? JSON.parse(service.constraints) : service.constraints,
      verification_profile: typeof service.verification_profile === 'string'
        ? JSON.parse(service.verification_profile)
        : service.verification_profile,
    };
  }
}

