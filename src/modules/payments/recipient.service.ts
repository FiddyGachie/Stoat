/**
 * PayPal recipient profiles for provider agents (SPEC v2.1 FR-037).
 *
 * Only a signed-in person creates or verifies a profile. The value is encrypted at rest, indexed
 * only by a keyed hash, and shown only as a mask. Agents never see it and cannot change it.
 * Changing the value resets verification, which also invalidates any approval made against the
 * old recipient (approvals bind the recipient hash).
 */
import { DbClient } from '../../db/connection.js';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors.js';
import { decryptRecipient, encryptRecipient, hashRecipient, maskRecipient } from '../../common/recipient-crypto.js';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export interface RecipientView {
  agent_id: string;
  recipient_type: string;
  recipient_masked: string;
  verification_status: 'pending' | 'verified' | 'rejected';
  consent_at: string;
  verified_at: string | null;
}

export interface RecipientForPayout {
  id: string;
  recipient_type: string;
  ciphertext: string;
  hash: string;
  masked: string;
  verification_status: string;
}

export class RecipientService {
  constructor(private db: DbClient) {}

  private async assertProvider(tenantId: string, agentId: string) {
    const ag = await this.db.query<{ role: string }>(`SELECT role FROM agents WHERE tenant_id = $1 AND id = $2`, [tenantId, agentId]);
    if (!ag.rows[0]) throw new NotFoundError('Agent', agentId);
    if (ag.rows[0].role !== 'provider') throw new ValidationError('Only provider agents receive payouts.');
  }

  async setProfile(p: { tenantId: string; agentId: string; type?: string; value: unknown; consent: unknown; userId: string }): Promise<RecipientView> {
    const type = String(p.type ?? 'EMAIL').toUpperCase();
    if (type !== 'EMAIL') throw new ValidationError('Only EMAIL recipients are supported in this version.');
    if (p.consent !== true) throw new ValidationError('The provider owner must confirm consent to receive payouts at this address.');
    const value = String(p.value ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(value)) throw new ValidationError('Enter a valid PayPal email address.');
    await this.assertProvider(p.tenantId, p.agentId);
    try {
      const res = await this.db.query<any>(
        `INSERT INTO provider_paypal_profiles
           (tenant_id, provider_id, recipient_type, recipient_ciphertext, recipient_hash, recipient_masked, verification_status, consent_at, set_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', now(), $7)
         ON CONFLICT (tenant_id, provider_id) DO UPDATE SET
           recipient_type = EXCLUDED.recipient_type, recipient_ciphertext = EXCLUDED.recipient_ciphertext,
           recipient_hash = EXCLUDED.recipient_hash, recipient_masked = EXCLUDED.recipient_masked,
           verification_status = 'pending', verification_source = NULL, verified_by = NULL, verified_at = NULL,
           consent_at = now(), set_by = EXCLUDED.set_by, updated_at = now()
         RETURNING *`,
        [p.tenantId, p.agentId, type, encryptRecipient(value), hashRecipient(type, value), maskRecipient(type, value), p.userId]
      );
      return this.view(res.rows[0]);
    } catch (err: any) {
      if (err?.code === '23505') throw new ConflictError('RECIPIENT_IN_USE', 'That PayPal recipient is already registered to another provider.');
      throw err;
    }
  }

  /** A person confirms they saw the masked recipient and that it is the right one. */
  async verify(p: { tenantId: string; agentId: string; userId: string; confirmMasked: unknown }): Promise<RecipientView> {
    const cur = await this.db.query<any>(`SELECT * FROM provider_paypal_profiles WHERE tenant_id = $1 AND provider_id = $2`, [p.tenantId, p.agentId]);
    if (!cur.rows[0]) throw new NotFoundError('Recipient profile', p.agentId);
    if (String(p.confirmMasked ?? '') !== cur.rows[0].recipient_masked) {
      throw new ValidationError('Confirmation does not match the recipient on file. Re-read the masked address and confirm it exactly.');
    }
    const upd = await this.db.query<any>(
      `UPDATE provider_paypal_profiles SET verification_status = 'verified', verification_source = 'human_confirmed_masked',
              verified_by = $3, verified_at = now(), updated_at = now()
       WHERE tenant_id = $1 AND provider_id = $2 RETURNING *`,
      [p.tenantId, p.agentId, p.userId]
    );
    return this.view(upd.rows[0]);
  }

  async getMasked(tenantId: string, agentId: string): Promise<RecipientView | null> {
    const r = await this.db.query<any>(`SELECT * FROM provider_paypal_profiles WHERE tenant_id = $1 AND provider_id = $2`, [tenantId, agentId]);
    return r.rows[0] ? this.view(r.rows[0]) : null;
  }

  /** Internal: what the payout planner needs. Never returned by an API. */
  async loadForPayout(tenantId: string, agentId: string): Promise<RecipientForPayout | null> {
    const r = await this.db.query<any>(`SELECT * FROM provider_paypal_profiles WHERE tenant_id = $1 AND provider_id = $2`, [tenantId, agentId]);
    const row = r.rows[0];
    return row ? { id: row.id, recipient_type: row.recipient_type, ciphertext: row.recipient_ciphertext, hash: row.recipient_hash, masked: row.recipient_masked, verification_status: row.verification_status } : null;
  }

  /** Internal: decrypt only at the moment the payout request to PayPal is built. */
  reveal(ciphertext: string): string {
    return decryptRecipient(ciphertext);
  }

  private view(row: any): RecipientView {
    return {
      agent_id: row.provider_id,
      recipient_type: row.recipient_type,
      recipient_masked: row.recipient_masked,
      verification_status: row.verification_status,
      consent_at: new Date(row.consent_at).toISOString(),
      verified_at: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    };
  }
}
