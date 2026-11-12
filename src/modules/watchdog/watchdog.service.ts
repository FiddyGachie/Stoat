import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type { AuthenticatedPrincipal } from "../../common/types.js";
import { ForbiddenActionError, ValidationError } from "../../common/errors.js";
import { transaction, type DbClient } from "../../db/connection.js";
import { notifyInTx } from "../wallet/notification.service.js";
import { MandateService } from "../mandates/mandate.service.js";
import { HoldService } from "./hold.service.js";
import { getFlags } from "../agentic/feature-flags.js";
import {
  DEFAULT_RESPONSES,
  DETECTORS,
  DETECTOR_NAMES,
  type DetectorName,
  type DetectorResponse,
  type NamedFinding,
} from "./detectors/index.js";
import {
  loadPriceOutlierFacts,
  loadReconciliationFacts,
  loadRevisionFacts,
  loadSpendSpikeFacts,
  loadUnusualProviderFacts,
  loadWalletDepletingFacts,
} from "./watchdog-facts.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const ADMIN_ROLES = new Set(["operator", "supervisor"]);
const DEFAULT_DEADLINE_MS = 30_000;
const CLEAR_STREAK_TO_RESOLVE = 2;
const DETECTOR_ERROR_THRESHOLD = 3;
const INTEGER_THRESHOLDS = new Set([
  "min_observations",
  "max_events",
  "max_age_minutes",
]);

export const DEFAULT_THRESHOLDS: Record<DetectorName, Record<string, number | string>> = {
  spend_spike: { multiplier: 3.0, min_observations: 5 },
  price_outlier: { multiplier: 2.0, min_observations: 5 },
  repeated_revision: { max_events: 3 },
  unusual_provider: { min_price: "500.00" },
  wallet_depleting: { horizon_hours: 24 },
  reconciliation_exception: { max_age_minutes: 60 },
};

export const THRESHOLD_BOUNDS: Record<DetectorName, Record<string, [number | string, number | string]>> = {
  spend_spike: { multiplier: [1.1, 100], min_observations: [3, 60] },
  price_outlier: { multiplier: [1.1, 100], min_observations: [3, 200] },
  repeated_revision: { max_events: [1, 20] },
  unusual_provider: { min_price: ["0.01", "999999999.99"] },
  wallet_depleting: { horizon_hours: [1, 168] },
  reconciliation_exception: { max_age_minutes: [5, 10080] },
};

/** Which responses a Detector can apply (design: hold needs a Hold subject, suspend needs a Mandate). */
const ALLOWED_RESPONSES: Record<DetectorName, DetectorResponse[]> = {
  spend_spike: ["none", "suspend_mandate"],
  price_outlier: ["none", "hold", "suspend_mandate"],
  repeated_revision: ["none"],
  unusual_provider: ["none", "hold", "suspend_mandate"],
  wallet_depleting: ["none"],
  reconciliation_exception: ["none"],
};

type Loader = (db: DbClient, tenantId: string, now: Date, extraIds: string[]) => Promise<unknown[]>;
const LOADERS: Record<DetectorName, Loader> = {
  spend_spike: loadSpendSpikeFacts,
  price_outlier: loadPriceOutlierFacts,
  repeated_revision: loadRevisionFacts,
  unusual_provider: loadUnusualProviderFacts,
  wallet_depleting: loadWalletDepletingFacts,
  reconciliation_exception: loadReconciliationFacts,
};

export interface DetectorCounters {
  findings: number;
  new_alerts: number;
  updated_alerts: number;
  resolved_alerts: number;
  skipped_baseline: number;
  responses_applied: number;
  response_errors: number;
  error?: string;
}

export interface WatchdogRunSummary {
  runId: string;
  status: "ok" | "partial" | "timeout";
  counters: Partial<Record<DetectorName, DetectorCounters>>;
}

interface AlertRow {
  id: string;
  subject_type: string;
  subject_id: string;
  clear_streak: number;
}

export interface ThresholdConfig {
  params: Record<string, number | string>;
  response: DetectorResponse;
}

function parseJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

export async function loadThresholds(
  db: DbClient,
  tenantId: string,
): Promise<Record<DetectorName, ThresholdConfig>> {
  const rows = await db.query<{ detector: string; params: unknown; response: DetectorResponse }>(
    "SELECT detector, params, response FROM watchdog_thresholds WHERE tenant_id = $1",
    [tenantId],
  );
  const out = {} as Record<DetectorName, ThresholdConfig>;
  for (const name of DETECTOR_NAMES) {
    out[name] = { params: { ...DEFAULT_THRESHOLDS[name] }, response: DEFAULT_RESPONSES[name] };
  }
  for (const r of rows.rows) {
    if (!(r.detector in out)) continue;
    const name = r.detector as DetectorName;
    out[name] = {
      params: { ...DEFAULT_THRESHOLDS[name], ...parseJson<Record<string, number | string>>(r.params) },
      response: r.response,
    };
  }
  return out;
}

/** Positive numbers within bounds only; the old value stays on failure (R5.11, R5.12). */
export function validateThresholdParams(
  detector: DetectorName,
  params: Record<string, unknown>,
): Record<string, number | string> {
  const bounds = THRESHOLD_BOUNDS[detector];
  if (!bounds) throw new ValidationError(`Unknown detector '${detector}'.`, { fields: ["detector"] });
  const clean: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    const bound = bounds[key];
    if (!bound) {
      throw new ValidationError(`Unknown threshold '${key}' for ${detector}.`, { fields: [key] });
    }
    const isMoney = typeof bound[0] === "string";
    let num: Decimal;
    try {
      if (
        (isMoney && typeof value !== "string") ||
        (!isMoney && typeof value !== "number") ||
        typeof value === "boolean" ||
        value === null ||
        (typeof value === "string" && value.trim() === "")
      ) {
        throw new Error("not numeric");
      }
      if (typeof value !== "number" && typeof value !== "string") {
        throw new Error("not numeric");
      }
      num = new Decimal(value);
      if (!num.isFinite()) throw new Error("not finite");
      if (INTEGER_THRESHOLDS.has(key) && !num.isInteger()) {
        throw new Error("must be an integer");
      }
    } catch {
      throw new ValidationError(
        `Threshold '${key}' must be a positive number between ${bound[0]} and ${bound[1]}.`,
        { fields: [key], min: bound[0], max: bound[1] },
      );
    }
    if (!num.gt(0) || num.lt(bound[0]) || num.gt(bound[1])) {
      throw new ValidationError(
        `Threshold '${key}' must be a positive number between ${bound[0]} and ${bound[1]}.`,
        { fields: [key], min: bound[0], max: bound[1] },
      );
    }
    clean[key] = isMoney ? num.toFixed(2) : num.toNumber();
  }
  return clean;
}

export class WatchdogService {
  constructor(private readonly db: DbClient) {}

  async setThreshold(input: {
    tenantId: string;
    detector: string;
    params?: Record<string, unknown>;
    response?: DetectorResponse;
    admin: AuthenticatedPrincipal;
    correlationId?: string;
  }): Promise<ThresholdConfig> {
    if (input.admin.type !== "user" || !ADMIN_ROLES.has(String(input.admin.role))) {
      throw new ForbiddenActionError();
    }
    if (!(DETECTOR_NAMES as string[]).includes(input.detector)) {
      throw new ValidationError(`Unknown detector '${input.detector}'.`, { fields: ["detector"] });
    }
    const detector = input.detector as DetectorName;
    const params = validateThresholdParams(detector, input.params ?? {});
    if (input.response && !ALLOWED_RESPONSES[detector].includes(input.response)) {
      throw new ValidationError(
        `Response '${input.response}' cannot be applied by ${detector}.`,
        { fields: ["response"] },
      );
    }
    return transaction(async (tx) => {
      const current = await loadThresholds(tx, input.tenantId);
      const old = current[detector];
      const next: ThresholdConfig = {
        params: { ...old.params, ...params },
        response: input.response ?? old.response,
      };
      await tx.query(
        `INSERT INTO watchdog_thresholds (tenant_id, detector, params, response, updated_by, updated_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,now())
         ON CONFLICT (tenant_id, detector) DO UPDATE
           SET params = EXCLUDED.params, response = EXCLUDED.response,
               updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [input.tenantId, detector, JSON.stringify(next.params), next.response, input.admin.id],
      );
      await tx.query(
        `INSERT INTO audit_logs
           (tenant_id, actor_type, actor_id, action, resource_type, resource_id,
            correlation_id, outcome, metadata)
         VALUES ($1,'user',$2,'watchdog.threshold.set','tenant',$1,$3,'success',$4::jsonb)`,
        [
          input.tenantId,
          input.admin.id,
          input.correlationId ?? randomUUID(),
          JSON.stringify({ detector, old: old, new: next, at: new Date().toISOString() }),
        ],
      );
      return next;
    });
  }

  async evaluateTenant(
    tenantId: string,
    opts: { now?: Date; deadlineMs?: number } = {},
  ): Promise<WatchdogRunSummary> {
    const now = opts.now ?? new Date();
    const deadline = Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const run = await this.db.query<{ id: string }>(
      "INSERT INTO watchdog_runs (tenant_id) VALUES ($1) RETURNING id",
      [tenantId],
    );
    const runId = run.rows[0].id;
    const thresholds = await loadThresholds(this.db, tenantId);
    const counters: Partial<Record<DetectorName, DetectorCounters>> = {};
    let timedOut = false;
    let failed = false;

    for (const name of DETECTOR_NAMES) {
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      const c: DetectorCounters = {
        findings: 0,
        new_alerts: 0,
        updated_alerts: 0,
        resolved_alerts: 0,
        skipped_baseline: 0,
        responses_applied: 0,
        response_errors: 0,
      };
      counters[name] = c;
      try {
        await this.evaluateDetector(tenantId, name, thresholds[name], now, runId, c);
        await this.db.query(
          `INSERT INTO watchdog_detector_state (tenant_id, detector, consecutive_failures)
           VALUES ($1,$2,0)
           ON CONFLICT (tenant_id, detector) DO UPDATE SET consecutive_failures = 0`,
          [tenantId, name],
        );
      } catch (error) {
        failed = true;
        c.error = error instanceof Error ? error.message : String(error);
        await this.recordDetectorFailure(tenantId, name, c.error, runId);
      }
    }

    const status: WatchdogRunSummary["status"] = timedOut ? "timeout" : failed ? "partial" : "ok";
    await this.db.query(
      "UPDATE watchdog_runs SET finished_at = now(), status = $2, counters = $3::jsonb WHERE id = $1",
      [runId, status, JSON.stringify(counters)],
    );
    return { runId, status, counters };
  }

  private async recordDetectorFailure(
    tenantId: string,
    detector: DetectorName,
    message: string,
    runId: string,
  ): Promise<void> {
    try {
      await transaction(async (tx) => {
        const state = await tx.query<{ consecutive_failures: number }>(
          `INSERT INTO watchdog_detector_state
             (tenant_id, detector, consecutive_failures, last_error, last_error_at)
           VALUES ($1,$2,1,$3,now())
           ON CONFLICT (tenant_id, detector) DO UPDATE
             SET consecutive_failures = watchdog_detector_state.consecutive_failures + 1,
                 last_error = EXCLUDED.last_error, last_error_at = now()
           RETURNING consecutive_failures`,
          [tenantId, detector, message.slice(0, 500)],
        );
        // Notify once, exactly at the third consecutive failure (R5.10).
        if (state.rows[0].consecutive_failures === DETECTOR_ERROR_THRESHOLD) {
          await notifyInTx(tx, {
            tenantId,
            kind: "detector_error",
            recipient: { admins: true },
            title: "Watchdog detector failing",
            body: `The ${detector} detector failed ${DETECTOR_ERROR_THRESHOLD} evaluations in a row.`,
            entityType: "watchdog_detector",
            eventId: `detector_error:${tenantId}:${detector}:${runId}`,
          });
        }
      });
    } catch {
      console.error(
        `[Watchdog] could not record failure state for ${detector} in run ${runId}`,
      );
    }
  }

  private async evaluateDetector(
    tenantId: string,
    name: DetectorName,
    config: ThresholdConfig,
    now: Date,
    runId: string,
    c: DetectorCounters,
  ): Promise<void> {
    const open = await this.db.query<AlertRow>(
      `SELECT id, subject_type, subject_id, clear_streak FROM watchdog_alerts
        WHERE tenant_id = $1 AND detector = $2 AND status = 'open'`,
      [tenantId, name],
    );
    const facts = await LOADERS[name](
      this.db,
      tenantId,
      now,
      open.rows.map((r) => r.subject_id),
    );
    const detector = DETECTORS[name];
    const result = (
      detector.evaluate as unknown as (
        f: unknown,
        t: unknown,
        n: Date,
      ) => { findings: NamedFinding[]; skippedBaseline: number }
    )(facts, config.params, now);
    c.findings = result.findings.length;
    c.skipped_baseline = result.skippedBaseline;

    const seen = new Set<string>();
    for (const finding of result.findings) {
      seen.add(`${finding.subjectType}:${finding.subjectId}`);
      const existing = open.rows.find(
        (r) => r.subject_type === finding.subjectType && r.subject_id === finding.subjectId,
      );
      if (existing) {
        await this.db.query(
          "UPDATE watchdog_alerts SET last_seen_at = $2, clear_streak = 0 WHERE id = $1",
          [existing.id, now],
        );
        c.updated_alerts++;
        continue;
      }
      const alertId = await this.createAlert(
        tenantId,
        name,
        detector.version,
        finding,
        config,
        now,
        runId,
      );
      if (!alertId) {
        c.updated_alerts++; // lost an insert race: an open Alert already exists
        continue;
      }
      c.new_alerts++;
      await this.applyResponse(tenantId, alertId, finding, config.response, runId, c);
    }

    for (const row of open.rows) {
      if (seen.has(`${row.subject_type}:${row.subject_id}`)) continue;
      const streak = row.clear_streak + 1;
      if (streak >= CLEAR_STREAK_TO_RESOLVE) {
        await this.db.query(
          `UPDATE watchdog_alerts SET status = 'resolved', resolved_at = $2, clear_streak = $3
            WHERE id = $1`,
          [row.id, now, streak],
        );
        c.resolved_alerts++;
      } else {
        await this.db.query("UPDATE watchdog_alerts SET clear_streak = $2 WHERE id = $1", [
          row.id,
          streak,
        ]);
      }
    }
  }

  private async resolveOwner(
    tx: DbClient,
    tenantId: string,
    finding: NamedFinding,
  ): Promise<string | null> {
    if (finding.mandateId) {
      const m = await tx.query<{ owner_user_id: string }>(
        "SELECT owner_user_id FROM mandates WHERE id = $1 AND tenant_id = $2",
        [finding.mandateId, tenantId],
      );
      if (m.rows[0]) return m.rows[0].owner_user_id;
    }
    if (finding.subjectType === "wallet") {
      const w = await tx.query<{ owner_user_id: string }>(
        "SELECT owner_user_id FROM wallets WHERE id = $1 AND tenant_id = $2",
        [finding.subjectId, tenantId],
      );
      return w.rows[0]?.owner_user_id ?? null;
    }
    if (finding.holdSubject?.type === "reservation") {
      const owner = await tx.query<{ owner_user_id: string }>(
        `SELECT w.owner_user_id
           FROM wallet_reservations r
           JOIN wallets w ON w.id = r.wallet_id AND w.tenant_id = r.tenant_id
          WHERE r.tenant_id = $1 AND r.id = $2`,
        [tenantId, finding.holdSubject.id],
      );
      return owner.rows[0]?.owner_user_id ?? null;
    }
    return null;
  }

  /** Insert (once per open subject) and notify in one transaction. Returns null on conflict. */
  private async createAlert(
    tenantId: string,
    name: DetectorName,
    version: string,
    finding: NamedFinding,
    config: ThresholdConfig,
    now: Date,
    runId: string,
  ): Promise<string | null> {
    const response = this.effectiveResponse(config.response, finding);
    return transaction(async (tx) => {
      const ownerId = await this.resolveOwner(tx, tenantId, finding);
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO watchdog_alerts
           (tenant_id, detector, detector_version, severity, subject_type, subject_id,
            mandate_id, owner_user_id, evidence, response, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$11)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          tenantId,
          name,
          version,
          finding.severity,
          finding.subjectType,
          finding.subjectId,
          finding.mandateId ?? null,
          ownerId,
          JSON.stringify(finding.evidence),
          response,
          now,
        ],
      );
      const id = inserted.rows[0]?.id;
      if (!id) return null;
      const flags = await getFlags(tx, tenantId);
      if (
        flags.watchdog_explanations &&
        ["medium", "high", "critical"].includes(finding.severity)
      ) {
        await tx.query(
          `INSERT INTO jobs (tenant_id, type, payload, status, priority, max_attempts)
           SELECT $1, 'watchdog_explain',
             jsonb_build_object('tenant_id', $1::text, 'alert_id', $2::text, 'correlation_id', $3::text),
             'queued', 2, 3
           WHERE NOT EXISTS (
             SELECT 1 FROM jobs
              WHERE tenant_id = $1 AND type = 'watchdog_explain'
                AND payload->>'alert_id' = $2::text
                AND status IN ('queued', 'running', 'succeeded')
           )`,
          [tenantId, id, runId],
        );
      }
      if (finding.severity === "high" || finding.severity === "critical") {
        const common = {
          tenantId,
          kind: "watchdog_alert" as const,
          title: `Watchdog alert: ${name.replace(/_/g, " ")}`,
          body: `A ${finding.severity} severity alert was raised by the ${name.replace(/_/g, " ")} detector.`,
          entityType: "watchdog_alert",
          entityId: id,
        };
        await notifyInTx(tx, { ...common, recipient: { admins: true }, eventId: `watchdog_alert:${id}:admin` });
        if (ownerId) {
          await notifyInTx(tx, {
            ...common,
            recipient: { userId: ownerId },
            eventId: `watchdog_alert:${id}:owner`,
          });
        }
      }
      return id;
    });
  }

  /** A configured response the finding cannot support degrades to alert only. */
  private effectiveResponse(response: DetectorResponse, finding: NamedFinding): DetectorResponse {
    if (response === "hold" && !finding.holdSubject) return "none";
    if (response === "suspend_mandate" && !finding.mandateId) return "none";
    return response;
  }

  private async applyResponse(
    tenantId: string,
    alertId: string,
    finding: NamedFinding,
    configured: DetectorResponse,
    runId: string,
    c: DetectorCounters,
  ): Promise<void> {
    const response = this.effectiveResponse(configured, finding);
    if (response === "none") return;
    try {
      if (response === "hold" && finding.holdSubject) {
        await new HoldService(this.db).placeHold({
          tenantId,
          subjectType: finding.holdSubject.type,
          subjectId: finding.holdSubject.id,
          reasonCode: `watchdog_${finding.detector}`,
          alertId,
          placer: { type: "system" },
          correlationId: runId,
        });
      } else if (response === "suspend_mandate" && finding.mandateId) {
        await new MandateService(this.db).suspendForWatchdog({
          tenantId,
          mandateId: finding.mandateId,
          alertId,
          correlationId: runId,
        });
      }
      c.responses_applied++;
    } catch {
      // A failed response leaves the Alert open for people; the run continues.
      c.response_errors++;
    }
  }
}

export { NIL_UUID as WATCHDOG_SYSTEM_ID };
