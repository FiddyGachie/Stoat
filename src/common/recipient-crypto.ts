import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { StoatError } from './errors.js';

/**
 * Encryption for PayPal recipient identifiers (AES-256-GCM) and the keyed hash used for
 * uniqueness and approval binding. In production RECIPIENT_ENCRYPTION_KEY is required
 * (64 hex characters, base64 of 32 bytes, or any random string of at least 32 characters, which is
 * hashed to 32 bytes); outside production a key is derived from JWT_SECRET
 * so development works without extra setup. Recipient plaintext never reaches logs, prompts,
 * agents or the browser.
 */
let cached: { source: string; key: Buffer } | undefined;

function loadKey(): Buffer {
  const raw = process.env.RECIPIENT_ENCRYPTION_KEY?.trim();
  if (raw) {
    if (cached?.source === raw) return cached.key;
    let key: Buffer;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
    else if (/^[A-Za-z0-9+/]{43}=?$/.test(raw) && Buffer.from(raw, 'base64').length === 32) key = Buffer.from(raw, 'base64');
    else if (raw.length >= 32) key = createHash('sha256').update(raw).digest();
    else throw new StoatError('RECIPIENT_KEY_INVALID', 'RECIPIENT_ENCRYPTION_KEY must be at least 32 random characters.', 503);
    cached = { source: raw, key };
    return key;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new StoatError('RECIPIENT_KEY_MISSING', 'RECIPIENT_ENCRYPTION_KEY is not set, so PayPal recipients cannot be stored.', 503);
  }
  const secret = process.env.JWT_SECRET || 'stoat-development-only';
  if (cached?.source === `derived:${secret}`) return cached.key;
  const key = scryptSync(secret, 'stoat-recipient-v1', 32);
  cached = { source: `derived:${secret}`, key };
  return key;
}

export function encryptRecipient(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loadKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

export function decryptRecipient(payload: string): string {
  const [v, iv, tag, body] = payload.split(':');
  if (v !== 'v1' || !iv || !tag || !body) throw new StoatError('RECIPIENT_CORRUPT', 'Stored recipient data is unreadable.', 500);
  const decipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

/** Keyed hash of the normalised recipient. Safe to index and compare; cannot be reversed without the key. */
export function hashRecipient(type: string, normalised: string): string {
  return createHmac('sha256', loadKey()).update(`${type}:${normalised}`).digest('hex');
}

/** a***@e***.com : enough for a human to recognise, not enough to use. */
export function maskRecipient(type: string, normalised: string): string {
  if (type === 'EMAIL') {
    const [local, domain = ''] = normalised.split('@');
    const dot = domain.lastIndexOf('.');
    const host = dot > 0 ? domain.slice(0, dot) : domain;
    const tld = dot > 0 ? domain.slice(dot) : '';
    return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${tld}`;
  }
  return `${normalised.slice(0, 2)}***${normalised.slice(-2)}`;
}
