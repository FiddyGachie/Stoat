import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";

function deriveKey(
  secret: string,
  salt: string,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, keyLength, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export async function hashCredential(secret: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await deriveKey(secret, salt, 64);
  return `scrypt$${salt}$${key.toString("hex")}`;
}

export async function verifyCredential(
  secret: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, salt, expectedHex] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    !/^[0-9a-f]{32}$/i.test(salt ?? "") ||
    !/^[0-9a-f]{128}$/i.test(expectedHex ?? "")
  ) {
    return false;
  }
  const expected = Buffer.from(expectedHex, "hex");
  const actual = await deriveKey(secret, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

/**
 * Burn the same scrypt cost as a real verification. Call this when the account does not
 * exist so an attacker cannot tell "no such user" from "wrong password" by response time.
 */
export async function verifyAgainstDummy(secret: string): Promise<false> {
  dummyHash ??= hashCredential("stoat-timing-equaliser");
  await verifyCredential(secret, await dummyHash);
  return false;
}

export function jwtSecret(): string {
  const configured = process.env.JWT_SECRET;
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "JWT_SECRET must be configured with at least 32 characters.",
    );
  }
  return "stoat-jwt-secret-key-32-chars-minimum!";
}

export type PrincipalType = "user" | "agent";

/**
 * Humans work a full session; agents get short-lived tokens (AGENTS.md section 4) and
 * re-authenticate with their secret. Both are overridable for deployments.
 */
export function accessTokenTtlSeconds(type: PrincipalType): number {
  const fromEnv = Number(
    type === "user"
      ? process.env.USER_TOKEN_TTL_SECONDS
      : process.env.AGENT_TOKEN_TTL_SECONDS,
  );
  if (Number.isInteger(fromEnv) && fromEnv >= 60 && fromEnv <= 7 * 24 * 3600)
    return fromEnv;
  return type === "user" ? 8 * 3600 : 15 * 60;
}

export function issueAccessToken(subject: string, type: PrincipalType): string {
  return jwt.sign({ type }, jwtSecret(), {
    subject,
    expiresIn: accessTokenTtlSeconds(type),
    algorithm: "HS256",
  });
}

/** Verify a bearer JWT. Pinning the algorithm blocks HS384/HS512 and alg-confusion variants. */
export function verifyAccessToken(token: string): jwt.JwtPayload {
  return jwt.verify(token, jwtSecret(), {
    algorithms: ["HS256"],
  }) as jwt.JwtPayload;
}
