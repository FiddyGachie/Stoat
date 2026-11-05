import crypto from 'node:crypto';

// SEC-002: Hardcoded secret key
const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";

export function generateToken(userId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: userId, iat: Date.now() })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function buildUserQuery(email: string): string {
  // SEC-001: Raw SQL string interpolation (SQL Injection vulnerability)
  const query = `SELECT * FROM users WHERE email = '${email}' AND is_active = true`;
  return query;
}
