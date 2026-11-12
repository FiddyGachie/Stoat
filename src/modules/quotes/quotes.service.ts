import { DbClient } from '../../db/connection.js';
import { Decimal } from 'decimal.js';
import { EventsService } from '../events/events.service.js';
import { ValidationError, NotFoundError, ConflictError } from '../../common/errors.js';
import { toDecimalString } from '../../common/decimal.js';

export interface RequestQuoteInput {
  tenantId: string;
  buyerId: string;
  missionId: string;
  serviceId: string;
  requestedScope?: Record<string, any>;
  quantity?: number | string;
  currency?: string;
  deadline?: string;
  correlationId?: string;
}

export class QuotesService {
  private eventsService: EventsService;

  constructor(private db: DbClient) {
    this.eventsService = new EventsService(db);
  }

  async requestQuote(input: RequestQuoteInput): Promise<any> {
    // 1. Verify mission
    const missionRes = await this.db.query(
      'SELECT id, buyer_id, budget, reserved_budget, currency, status FROM missions WHERE id = $1 AND tenant_id = $2',
      [input.missionId, input.tenantId]
    );
    if (missionRes.rows.length === 0 || missionRes.rows[0].buyer_id !== input.buyerId) {
      throw new NotFoundError('Mission', input.missionId);
    }
    if (missionRes.rows[0].status !== 'created') {
      throw new ConflictError('MISSION_NOT_OPEN', `This mission is '${missionRes.rows[0].status}', so it cannot take new quotes.`);
    }

    // 2. Verify service
    const serviceRes = await this.db.query(
      'SELECT id, provider_id, unit_price, currency, status, verification_profile FROM services WHERE id = $1 AND tenant_id = $2',
      [input.serviceId, input.tenantId]
    );
    if (serviceRes.rows.length === 0 || serviceRes.rows[0].status !== 'active') {
      throw new NotFoundError('Service', input.serviceId);
    }

    const service = serviceRes.rows[0];
    const qty = new Decimal(input.quantity || 1);
    if (qty.lessThanOrEqualTo(0)) {
      throw new ValidationError('Quantity must be greater than zero.');
    }

    const unitPrice = new Decimal(service.unit_price);
    const totalPrice = unitPrice.times(qty);
    const priceStr = toDecimalString(totalPrice);
    const currency = input.currency || service.currency || 'USD';

    // 3. Create quote request
    const deadline = input.deadline || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2 hours
    const expiresAt = new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString(); // 1 hour expiry

    const qrRes = await this.db.query(
      `INSERT INTO quote_requests (
        id, tenant_id, mission_id, buyer_id, service_id, requested_scope, quantity, currency, deadline, status
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 'answered'
      ) RETURNING id`,
      [
        input.tenantId,
        input.missionId,
        input.buyerId,
        input.serviceId,
        JSON.stringify(input.requestedScope || {}),
        qty.toString(),
        currency,
        deadline,
      ]
    );
    const quoteRequestId = qrRes.rows[0].id;

    // 4. Issue quote
    const terms = {
      quantity: qty.toNumber(),
      unit_price: service.unit_price,
      scope: input.requestedScope || {},
      verification_profile: typeof service.verification_profile === 'string'
        ? JSON.parse(service.verification_profile)
        : service.verification_profile,
    };

    const quoteRes = await this.db.query(
      `INSERT INTO quotes (
        id, tenant_id, quote_request_id, service_id, provider_id, price, currency, terms, expires_at, status
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 'offered'
      ) RETURNING id, tenant_id, quote_request_id, service_id, provider_id, price, currency, terms, expires_at, status, created_at`,
      [
        input.tenantId,
        quoteRequestId,
        input.serviceId,
        service.provider_id,
        priceStr,
        currency,
        JSON.stringify(terms),
        expiresAt,
      ]
    );

    const quote = quoteRes.rows[0];
    quote.price = String(quote.price);
    quote.terms = typeof quote.terms === 'string' ? JSON.parse(quote.terms) : quote.terms;

    // 5. Append economic event
    await this.eventsService.appendEvent({
      tenantId: input.tenantId,
      aggregateType: 'mission',
      aggregateId: input.missionId,
      eventType: 'QUOTE_ISSUED',
      actorType: 'agent',
      actorId: service.provider_id,
      correlationId: input.correlationId,
      amount: quote.price,
      currency: quote.currency,
      payload: {
        quote_id: quote.id,
        service_id: quote.service_id,
        price: quote.price,
        expires_at: quote.expires_at,
      },
    });

    return quote;
  }

  async getQuote(tenantId: string, quoteId: string, buyerId?: string): Promise<any> {
    const res = await this.db.query(
      `SELECT q.id, q.quote_request_id, q.service_id, q.provider_id, q.price, q.currency,
              q.terms, q.expires_at, q.status, q.created_at, qr.mission_id
       FROM quotes q
       LEFT JOIN quote_requests qr ON qr.id = q.quote_request_id
       WHERE q.tenant_id = $1 AND q.id = $2 AND ($3::uuid IS NULL OR qr.buyer_id = $3)`,
      [tenantId, quoteId, buyerId ?? null]
    );

    if (res.rows.length === 0) {
      throw new NotFoundError('Quote', quoteId);
    }

    const row = res.rows[0];
    return {
      ...row,
      price: String(row.price),
      terms: typeof row.terms === 'string' ? JSON.parse(row.terms) : row.terms,
    };
  }

  async listMissionQuotes(tenantId: string, missionId: string, buyerId?: string): Promise<any[]> {
    const mission = await this.db.query(
      `SELECT id FROM missions
       WHERE tenant_id = $1 AND id = $2 AND ($3::uuid IS NULL OR buyer_id = $3)`,
      [tenantId, missionId, buyerId ?? null],
    );
    if (mission.rows.length === 0) throw new NotFoundError("Mission", missionId);

    const result = await this.db.query(
      `SELECT q.id, q.quote_request_id, q.service_id, s.name AS service_name,
              q.provider_id, q.price, q.currency, q.terms, q.expires_at, q.status,
              q.created_at, a.id AS agreement_id, a.status AS agreement_status, a.funding_status
       FROM quote_requests qr
       JOIN quotes q ON q.quote_request_id = qr.id AND q.tenant_id = qr.tenant_id
       JOIN services s ON s.id = q.service_id AND s.tenant_id = q.tenant_id
       LEFT JOIN agreements a ON a.quote_id = q.id AND a.tenant_id = q.tenant_id
       WHERE qr.tenant_id = $1 AND qr.mission_id = $2
       ORDER BY q.created_at DESC`,
      [tenantId, missionId],
    );
    return result.rows.map((row) => ({
      ...row,
      price: String(row.price),
      terms: typeof row.terms === "string" ? JSON.parse(row.terms) : row.terms,
    }));
  }
}
