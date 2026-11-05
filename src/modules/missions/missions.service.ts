import { DbClient } from '../../db/connection.js';
import { EventsService } from '../events/events.service.js';
import { ValidationError, NotFoundError } from '../../common/errors.js';
import { validateAmount, toDecimalString } from '../../common/decimal.js';

export interface CreateMissionInput {
  tenantId: string;
  buyerId: string;
  title: string;
  brief: string;
  budget: string;
  currency?: string;
  deadline?: string;
  correlationId?: string;
}

export class MissionsService {
  private eventsService: EventsService;

  constructor(private db: DbClient) {
    this.eventsService = new EventsService(db);
  }

  async createMission(input: CreateMissionInput): Promise<any> {
    if (!input.title || !input.brief) {
      throw new ValidationError('Mission title and brief are required.');
    }

    if (!validateAmount(input.budget)) {
      throw new ValidationError(`Invalid mission budget: ${input.budget}. Must be a positive decimal.`);
    }

    const currency = input.currency || 'USD';
    const deadline = input.deadline || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const budgetDecimal = toDecimalString(input.budget);

    const res = await this.db.query(
      `INSERT INTO missions (
        id, tenant_id, buyer_id, title, brief, budget, reserved_budget, currency, deadline, status
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, 0, $6, $7, 'created'
      ) RETURNING id, tenant_id, buyer_id, title, brief, budget, reserved_budget, currency, deadline, status, created_at`,
      [input.tenantId, input.buyerId, input.title, input.brief, budgetDecimal, currency, deadline]
    );

    const mission = res.rows[0];
    mission.budget = String(mission.budget);
    mission.reserved_budget = String(mission.reserved_budget);

    // Append economic event
    await this.eventsService.appendEvent({
      tenantId: input.tenantId,
      aggregateType: 'mission',
      aggregateId: mission.id,
      eventType: 'MISSION_CREATED',
      actorType: 'agent',
      actorId: input.buyerId,
      correlationId: input.correlationId,
      amount: mission.budget,
      currency: mission.currency,
      payload: {
        title: mission.title,
        budget: mission.budget,
        deadline: mission.deadline,
      },
    });

    return mission;
  }

  async listMissions(tenantId: string): Promise<any[]> {
    const res = await this.db.query(
      `SELECT id, buyer_id, title, brief, budget, reserved_budget, currency, deadline, status, created_at
       FROM missions
       WHERE tenant_id = $1
       ORDER BY created_at DESC`,
      [tenantId]
    );

    return res.rows.map((row: any) => ({
      ...row,
      budget: String(row.budget),
      reserved_budget: String(row.reserved_budget),
    }));
  }

  async getMission(tenantId: string, missionId: string): Promise<any> {
    const res = await this.db.query(
      `SELECT id, buyer_id, title, brief, budget, reserved_budget, currency, deadline, status, created_at
       FROM missions
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, missionId]
    );

    if (res.rows.length === 0) {
      throw new NotFoundError('Mission', missionId);
    }

    const row = res.rows[0];
    return {
      ...row,
      budget: String(row.budget),
      reserved_budget: String(row.reserved_budget),
    };
  }
}
