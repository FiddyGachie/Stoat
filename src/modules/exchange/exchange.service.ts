import { DbClient } from '../../db/connection.js';

export interface ServiceListing {
  id: string;
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
}

export class ExchangeService {
  constructor(private db: DbClient) {}

  async listServices(tenantId: string, category?: string): Promise<ServiceListing[]> {
    let sql = `
      SELECT id, name, description, category, pricing_model, unit_price, currency, unit,
             constraints, verification_profile, status
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
      `SELECT id, name, description, category, pricing_model, unit_price, currency, unit,
              constraints, verification_profile, status
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
}
