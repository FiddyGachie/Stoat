/**
 * NotificationService: in-app money notifications with optional email (R13, R7.15-7.21).
 *
 * Deterministic code only. A notification never carries an action that moves money; links are
 * navigation only (R13.12). Content is limited to amounts, currency and masked identifiers and is
 * checked by `sanitizeNotificationText` (R13.11).
 *
 * Persisted notifications change only by mark-read, low-balance resolve, and the depletion
 * shortfall update; migration 008 enforces that with a trigger (R13.13).
 */
import { DbClient } from "../../db/connection.js";
import { NotFoundError, ValidationError } from "../../common/errors.js";
import { parseMoney } from "./wallet-math.js";

export const NOTIFICATION_KINDS = [
  "deposit_captured",
  "deposit_failed",
  "deposit_mismatch",
  "deposit_stuck",
  "low_balance",
  "depleted",
  "topped_up",
  "topup_incomplete",
  "mission_completed",
  "refund_completed",
  "refund_failed",
  "reconciliation_exception",
  "trial_balance_mismatch",
  "wallet_balance_mismatch",
  "mandate_exhausted",
  "watchdog_alert",
  "detector_error",
  "proposal_execution_failed",
  "agent_integrity_violation",
  "model_budget_reached",
  "held_accrual_stuck",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Addressed to every Admin of the tenant and never to the Owner (R13.6). */
export const ADMIN_ONLY_KINDS: ReadonlySet<NotificationKind> =
  new Set<NotificationKind>([
    "deposit_mismatch",
    "deposit_stuck",
    "refund_failed",
    "reconciliation_exception",
    "trial_balance_mismatch",
    "wallet_balance_mismatch",
    "detector_error",
    "proposal_execution_failed",
    "agent_integrity_violation",
    "model_budget_reached",
    "held_accrual_stuck",
  ]);

/** Addressed to the Owner (a specific user), not fanned out to Admins. */
const OWNER_ONLY_KINDS: ReadonlySet<NotificationKind> =
  new Set<NotificationKind>(["topup_incomplete", "mandate_exhausted"]);

/** Kinds that also request an email where a provider is configured (R7.15). */
const EMAIL_KINDS: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  "low_balance",
  "depleted",
]);

export const EMAIL_MAX_ATTEMPTS = 3;
export const PAGE_SIZE = 50;
const ADMIN_ROLES = ["operator", "supervisor"];

// ---------------------------------------------------------------------------
// Sanitization (R13.11)
// ---------------------------------------------------------------------------

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/;
const SECRET_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/, // JWT
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i, // authorization header value
  /\b(sk|pk|rk)_[A-Za-z0-9_]{8,}/i, // provider style keys
  /\b(token|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|api[_ -]?key|password|passwd|secret|authorization|credential)s?\b\s*[:=]/i,
  /[A-Za-z0-9+/_=-]{32,}/, // long opaque run (base64, hex, PayPal client credentials)
];

/** Why a text was refused, or null when it is acceptable. UUIDs are allowed (masked entity IDs). */
export function findUnsafeContent(text: string): "email" | "secret" | null {
  const probe = text.replace(UUID_RE, "id");
  if (EMAIL_RE.test(probe)) return "email";
  if (SECRET_PATTERNS.some((re) => re.test(probe))) return "secret";
  return null;
}

/**
 * Validate and trim a title (1-120) and body (1-1000). Rejects token-like strings, secrets and
 * email addresses. Throws ValidationError naming the field and rule, never echoing the content.
 */
export function sanitizeNotificationText(input: {
  title: unknown;
  body: unknown;
}): {
  title: string;
  body: string;
} {
  const check = (
    field: "title" | "body",
    value: unknown,
    max: number,
  ): string => {
    if (typeof value !== "string") {
      throw new ValidationError(`Notification ${field} must be a string.`, {
        field,
      });
    }
    const v = value.trim();
    if (v.length < 1 || v.length > max) {
      throw new ValidationError(
        `Notification ${field} must be 1 to ${max} characters.`,
        { field },
      );
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) {
      throw new ValidationError(
        `Notification ${field} contains control characters.`,
        { field },
      );
    }
    const unsafe = findUnsafeContent(v);
    if (unsafe) {
      throw new ValidationError(
        `Notification ${field} contains a ${unsafe}, which is not allowed.`,
        {
          field,
          reason: unsafe,
        },
      );
    }
    return v;
  };
  return {
    title: check("title", input.title, 120),
    body: check("body", input.body, 1000),
  };
}

/** Navigation-only link for the Console (R13.12). Never a state-changing URL. */
export function navigationLink(
  entityType: string | null,
  entityId: string | null,
): string | null {
  if (!entityType || !entityId) return null;
  switch (entityType) {
    case "wallet_deposit":
    case "deposit":
      return `#/wallet?deposit=${entityId}`;
    case "mission":
      return `#/wallet?mission=${entityId}`;
    case "wallet_refund":
    case "refund":
      return `#/wallet?refund=${entityId}`;
    case "wallet":
      return `#/wallet`;
    case "reconciliation_run":
      return `#/reconciliation?run=${entityId}`;
    case "mandate":
      return `#/mandates?mandate=${entityId}`;
    case "proposal":
      return `#/approvals?proposal=${entityId}`;
    case "alert":
      return `#/watchdog?alert=${entityId}`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Posts JSON to EMAIL_API_URL with EMAIL_API_KEY. Errors never include the key. */
export class HttpEmailSender implements EmailSender {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Email provider answered HTTP ${res.status}`);
  }
}

let senderOverride: EmailSender | null = null;
/** Tests inject a transport; pass null to restore the environment-driven sender. */
export function setEmailSender(sender: EmailSender | null): void {
  senderOverride = sender;
}

export function emailSender(): EmailSender | null {
  if (senderOverride) return senderOverride;
  const url = process.env.EMAIL_API_URL;
  const key = process.env.EMAIL_API_KEY;
  return url && key ? new HttpEmailSender(url, key) : null;
}

export const emailConfigured = (): boolean => emailSender() !== null;

async function enqueueEmail(
  tx: DbClient,
  tenantId: string,
  notificationId: string,
  revision: string,
) {
  await tx.query(
    `INSERT INTO jobs (tenant_id, type, payload, status, priority, max_attempts)
     VALUES ($1, 'wallet_email', jsonb_build_object('notification_id', $2::text, 'revision', $3::text), 'queued', 4, $4)`,
    [tenantId, notificationId, revision, EMAIL_MAX_ATTEMPTS],
  );
}

/**
 * `wallet_email` job handler. Sends the stored (sanitized) title and body to the recipient's
 * address, which is read from the user row at send time and never stored on the notification.
 * A failure throws so the runner retries; the job carries max_attempts = 3, after which it is
 * parked. The in-app notification is untouched either way.
 */
export async function deliverEmail(
  db: DbClient,
  payload: { notification_id?: string },
): Promise<string> {
  const sender = emailSender();
  if (!sender) return "email provider not configured";
  const r = await db.query<{ title: string; body: string; email: string }>(
    `SELECT n.title, n.body, u.email
       FROM notifications n JOIN users u ON u.id = n.recipient_user_id
      WHERE n.id = $1`,
    [payload.notification_id],
  );
  const row = r.rows[0];
  if (!row) return "notification not found";
  await sender.send({ to: row.email, subject: row.title, text: row.body });
  return "email sent";
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type NotificationRecipient = { userId: string } | { admins: true };

export interface NotifyInput {
  tenantId: string;
  kind: NotificationKind;
  recipient: NotificationRecipient;
  title: string;
  body: string;
  entityType?: string | null;
  entityId?: string | null;
  /** Idempotency: one notification per (recipient, eventId) (R13.5). */
  eventId: string;
  missionId?: string | null;
}

export interface CreatedNotification {
  id: string;
  recipientUserId: string;
  kind: NotificationKind;
}

/**
 * Create notifications inside the caller's transaction, so they persist only if the event does
 * (R13.2, R13.3). Duplicate (recipient, eventId) is a silent success (R13.5). Returns only the
 * rows created by this call.
 */
export async function notifyInTx(
  tx: DbClient,
  n: NotifyInput,
): Promise<CreatedNotification[]> {
  if (!(NOTIFICATION_KINDS as readonly string[]).includes(n.kind)) {
    throw new ValidationError(`Unknown notification kind '${n.kind}'.`);
  }
  const toAdmins = "admins" in n.recipient;
  if (ADMIN_ONLY_KINDS.has(n.kind) && !toAdmins) {
    throw new ValidationError(
      `Notification kind '${n.kind}' is addressed to Admins only.`,
    );
  }
  if (OWNER_ONLY_KINDS.has(n.kind) && toAdmins) {
    throw new ValidationError(
      `Notification kind '${n.kind}' is addressed to the Owner only.`,
    );
  }
  if (!n.eventId || typeof n.eventId !== "string") {
    throw new ValidationError("Notification eventId is required.");
  }
  const { title, body } = sanitizeNotificationText(n);
  const emailing = EMAIL_KINDS.has(n.kind) && emailConfigured();

  const common = [
    n.tenantId, // 1
    n.kind, // 2
    title, // 3
    body, // 4
    n.entityType ?? null, // 5
    n.entityId ?? null, // 6
    n.eventId, // 7
    n.missionId ?? null, // 8
    emailing ? "pending" : "none", // 9
  ];
  const insertHead = `INSERT INTO notifications
      (id, tenant_id, recipient_user_id, kind, title, body, entity_type, entity_id, event_id, mission_id, email_status)
    SELECT gen_random_uuid(), $1, u.id, $2, $3, $4, $5::text, $6::uuid, $7, $8::uuid, $9
      FROM users u`;
  const tail = `ON CONFLICT DO NOTHING RETURNING id, recipient_user_id`;

  const res = toAdmins
    ? await tx.query<{ id: string; recipient_user_id: string }>(
        `${insertHead} WHERE u.tenant_id = $1 AND u.role = ANY($10::text[]) ${tail}`,
        [...common, ADMIN_ROLES],
      )
    : await tx.query<{ id: string; recipient_user_id: string }>(
        `${insertHead} WHERE u.tenant_id = $1 AND u.id = $10::uuid ${tail}`,
        [...common, (n.recipient as { userId: string }).userId],
      );

  if (emailing) {
    for (const row of res.rows)
      await enqueueEmail(tx, n.tenantId, row.id, "created");
  }
  return res.rows.map((r) => ({
    id: r.id,
    recipientUserId: r.recipient_user_id,
    kind: n.kind,
  }));
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: string | null;
  mission_id: string | null;
  link: string | null;
  created_at: string;
  read_at: string | null;
  updated_at: string | null;
  resolved_at: string | null;
}

const VIEW_COLS = `id, kind, title, body, entity_type, entity_id, mission_id,
  created_at::text AS created_at, read_at::text AS read_at,
  updated_at::text AS updated_at, resolved_at::text AS resolved_at`;

const toView = (r: any): NotificationView => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  body: r.body,
  entity_type: r.entity_type,
  entity_id: r.entity_id,
  mission_id: r.mission_id,
  link: navigationLink(r.entity_type, r.entity_id),
  created_at: r.created_at,
  read_at: r.read_at,
  updated_at: r.updated_at,
  resolved_at: r.resolved_at,
});

const encodeCursor = (createdAt: string, id: string) =>
  Buffer.from(JSON.stringify([createdAt, id])).toString("base64url");

function decodeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(v) &&
      typeof v[0] === "string" &&
      typeof v[1] === "string"
    ) {
      return [v[0], v[1]];
    }
  } catch {
    /* fall through */
  }
  throw new ValidationError("Invalid cursor.", { field: "cursor" });
}

/** Newest first, at most 50 per page. Only the recipient's own notifications (R13.7, R13.10). */
export async function list(
  db: DbClient,
  userId: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<{ items: NotificationView[]; next_cursor: string | null }> {
  const limit = Math.min(
    PAGE_SIZE,
    Math.max(1, Math.floor(opts.limit ?? PAGE_SIZE)),
  );
  const params: any[] = [userId];
  let where = `recipient_user_id = $1`;
  if (opts.cursor) {
    const [ts, id] = decodeCursor(opts.cursor);
    params.push(ts, id);
    where += ` AND (created_at, id) < ($2::timestamptz, $3::uuid)`;
  }
  params.push(limit + 1);
  const r = await db.query(
    `SELECT ${VIEW_COLS} FROM notifications WHERE ${where}
      ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows.slice(0, limit);
  const more = r.rows.length > limit;
  const last = rows[rows.length - 1];
  return {
    items: rows.map(toView),
    next_cursor: more && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

/** Exact unread count; the Console caps the display at "999+" (R13.7). */
export async function unreadCount(
  db: DbClient,
  userId: string,
): Promise<number> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return r.rows[0]?.n ?? 0;
}

/**
 * Recipient only. Sets read_at once per unread state; opening a read notification changes nothing.
 * Anyone else gets the same not-found answer, with no content disclosed (R13.10).
 */
export async function markRead(
  db: DbClient,
  userId: string,
  notificationId: string,
): Promise<NotificationView> {
  await db.query(
    `UPDATE notifications SET read_at = now()
      WHERE id = $1 AND recipient_user_id = $2 AND read_at IS NULL`,
    [notificationId, userId],
  );
  const r = await db.query(
    `SELECT ${VIEW_COLS} FROM notifications WHERE id = $1 AND recipient_user_id = $2`,
    [notificationId, userId],
  );
  if (!r.rows[0]) throw new NotFoundError("Notification", notificationId);
  return toView(r.rows[0]);
}

// ---------------------------------------------------------------------------
// Low balance and depletion
// ---------------------------------------------------------------------------

/** Mark open low-balance notifications of the mission resolved once funding rises (R7.14). */
export async function resolveLowBalance(
  tx: DbClient,
  missionId: string,
): Promise<number> {
  const r = await tx.query(
    `UPDATE notifications SET resolved_at = now()
      WHERE mission_id = $1 AND kind = 'low_balance' AND resolved_at IS NULL RETURNING id`,
    [missionId],
  );
  return r.rows.length;
}

/**
 * Depletion shortfall update (R7.20, R7.21): rewrite the existing depletion notification in place
 * (no second row), reset it to unread, set updated_at, and request a new email where a provider is
 * configured. This is the only content update a notification ever receives.
 *
 * Returns false when the shortfall text is unchanged (nothing to update).
 */
export async function updateDepletionShortfall(
  tx: DbClient,
  notificationId: string,
  shortfall: string,
  currency?: string,
): Promise<boolean> {
  const amt = parseMoney(shortfall, { positive: true });
  if (!amt.ok)
    throw new ValidationError("Shortfall must be a positive decimal string.", {
      reason: amt.reason,
    });

  const cur = await tx.query<{
    tenant_id: string;
    kind: string;
    title: string;
    body: string;
    currency: string | null;
  }>(
    `SELECT n.tenant_id, n.kind, n.title, n.body,
            (SELECT w.currency FROM mission_funding mf JOIN wallets w ON w.id = mf.wallet_id
              WHERE mf.mission_id = n.mission_id) AS currency
       FROM notifications n WHERE n.id = $1 FOR UPDATE`,
    [notificationId],
  );
  const row = cur.rows[0];
  if (!row) throw new NotFoundError("Notification", notificationId);
  if (row.kind !== "depleted") {
    throw new ValidationError(
      "Only a depletion notification takes a shortfall update.",
    );
  }
  const cc = currency ?? row.currency;
  const { title, body } = sanitizeNotificationText({
    title: row.title,
    body: `This mission is out of funds. Shortfall: ${amt.value}${cc ? ` ${cc}` : ""}. Top up the wallet to continue.`,
  });
  if (body === row.body) return false;

  const emailing = emailConfigured();
  await tx.query(
    `UPDATE notifications
        SET title = $2, body = $3, read_at = NULL, updated_at = now(),
            email_status = $4, email_attempts = 0
      WHERE id = $1`,
    [notificationId, title, body, emailing ? "pending" : "none"],
  );
  if (emailing) {
    const rev = await tx.query<{ u: string }>(
      `SELECT updated_at::text AS u FROM notifications WHERE id = $1`,
      [notificationId],
    );
    await enqueueEmail(
      tx,
      row.tenant_id,
      notificationId,
      `shortfall:${rev.rows[0]?.u}`,
    );
  }
  return true;
}
