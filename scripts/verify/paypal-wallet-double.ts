/**
 * WalletPayPalDouble: a scripted PayPalGateway for tests and verification scripts ONLY.
 *
 * THIS DOUBLE PROVES NOTHING ABOUT PAYPAL. It returns whatever it is configured to
 * return. A passing check that uses it shows that Stoat's own logic handles the stated
 * PayPal responses, never that PayPal behaves that way. Real behaviour is shown only by
 * Sandbox calls (scripts/verify/wallet-reconciliation.ts).
 *
 * It must never be imported by product code under src/. A static test enforces this
 * (tests/unit/paypal_double_isolation.test.ts).
 */
import type {
  GatewayCapture,
  GatewayOrder,
  GatewayPayout,
  GatewayRefund,
  GatewayRefundState,
  PayPalGateway,
  PayoutItemInput,
  WebhookVerifyInput,
} from "../../src/modules/paypal/paypal.gateway.js";
import { PayPalApiError } from "../../src/modules/paypal/paypal.gateway.js";

export type DoubleMethod =
  | "createOrder"
  | "captureOrder"
  | "getOrder"
  | "getCapture"
  | "refundCapture"
  | "getRefund"
  | "createPayout"
  | "getPayout"
  | "verifyWebhook";

export interface DoubleCall {
  seq: number;
  method: DoubleMethod;
  args: unknown;
  outcome: "ok" | "error";
  errorCode?: string;
}

/** Fail the next `times` calls of `method` (or of any method with "*") with a PayPal-shaped error. */
export interface TransientFailure {
  times: number;
  code?: string;
  statusCode?: number;
}

export interface WalletDoubleConfig {
  environment: "sandbox" | "live";
  orderStatus: string;
  approveUrl: string | null;
  captureStatus: string | null;
  /** Null means "echo the order amount". */
  captureAmount: string | null;
  /** Null means "echo the order currency". */
  captureCurrency: string | null;
  /** Reported as seller_receivable_breakdown.paypal_fee; null means none reported. */
  paypalFee: string | null;
  /** When false, captures come back without a capture ID. */
  returnCaptureId: boolean;
  captureCreateTime: string | null;
  refundStatus: string;
  /** Null means "echo the requested refund amount". */
  refundAmount: string | null;
}

interface OrderRecord {
  id: string;
  amount: string;
  currency: string;
  customId: string;
  requestId: string;
  captured: boolean;
}

export class WalletPayPalDouble implements PayPalGateway {
  environment: "sandbox" | "live";
  config: WalletDoubleConfig;
  readonly calls: DoubleCall[] = [];
  /** Per-method call counters, including failed calls. */
  readonly counters: Record<string, number> = {};
  private failures = new Map<string, TransientFailure>();
  private orders = new Map<string, OrderRecord>();
  private captures = new Map<string, { orderId: string; amount: string; currency: string }>();
  private refunds = new Map<string, GatewayRefundState>();
  private byRequestId = new Map<string, string>();
  private seq = 0;
  private ids = 0;

  constructor(config: Partial<WalletDoubleConfig> = {}) {
    this.config = {
      environment: "sandbox",
      orderStatus: "COMPLETED",
      approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=DOUBLE",
      captureStatus: "COMPLETED",
      captureAmount: null,
      captureCurrency: null,
      paypalFee: null,
      returnCaptureId: true,
      captureCreateTime: null,
      refundStatus: "COMPLETED",
      refundAmount: null,
      ...config,
    };
    this.environment = this.config.environment;
  }

  /** Change behaviour mid-test. */
  configure(patch: Partial<WalletDoubleConfig>): this {
    this.config = { ...this.config, ...patch };
    this.environment = this.config.environment;
    return this;
  }

  /** Make the next `failure.times` calls of `method` fail. Use "*" for every method. */
  failNext(method: DoubleMethod | "*", failure: TransientFailure): this {
    this.failures.set(method, { ...failure });
    return this;
  }

  count(method: DoubleMethod): number {
    return this.counters[method] ?? 0;
  }

  reset(): void {
    this.calls.length = 0;
    for (const k of Object.keys(this.counters)) delete this.counters[k];
    this.failures.clear();
  }

  private nextId(prefix: string): string {
    this.ids += 1;
    return `${prefix}-DOUBLE-${this.ids}`;
  }

  private run<T>(method: DoubleMethod, args: unknown, fn: () => T): T {
    this.counters[method] = (this.counters[method] ?? 0) + 1;
    const key = this.failures.has(method) ? method : this.failures.has("*") ? "*" : null;
    const f = key ? this.failures.get(key) : undefined;
    if (key && f && f.times > 0) {
      f.times -= 1;
      if (f.times === 0) this.failures.delete(key);
      const code = f.code ?? "PAYPAL_UNREACHABLE";
      this.calls.push({ seq: ++this.seq, method, args, outcome: "error", errorCode: code });
      throw new PayPalApiError(code, `Double: scripted failure for ${method}.`, f.statusCode ?? 502);
    }
    try {
      const out = fn();
      this.calls.push({ seq: ++this.seq, method, args, outcome: "ok" });
      return out;
    } catch (err) {
      this.calls.push({ seq: ++this.seq, method, args, outcome: "error", errorCode: (err as { code?: string }).code });
      throw err;
    }
  }

  private captureFor(order: OrderRecord, captureId: string | null): GatewayCapture {
    return {
      orderId: order.id,
      orderStatus: this.config.orderStatus,
      captureId,
      captureStatus: captureId ? this.config.captureStatus : null,
      amount: this.config.captureAmount ?? order.amount,
      currency: this.config.captureCurrency ?? order.currency,
      customId: order.customId,
      paypalFee: this.config.paypalFee,
      createTime: this.config.captureCreateTime,
    };
  }

  private order(orderId: string): OrderRecord {
    const o = this.orders.get(orderId);
    if (!o) throw new PayPalApiError("PAYPAL_REQUEST_REJECTED", "Double: unknown order.", 404, { paypal_status: 404 });
    return o;
  }

  async createOrder(input: Parameters<PayPalGateway["createOrder"]>[0]): Promise<GatewayOrder> {
    return this.run("createOrder", input, () => {
      // Same request ID returns the original order, as PayPal does.
      const prior = this.byRequestId.get(input.requestId);
      if (prior) {
        const o = this.orders.get(prior)!;
        return { id: o.id, status: "CREATED", approveUrl: this.config.approveUrl };
      }
      const id = this.nextId("ORDER");
      this.orders.set(id, { id, amount: input.amount, currency: input.currency, customId: input.customId, requestId: input.requestId, captured: false });
      this.byRequestId.set(input.requestId, id);
      return { id, status: "CREATED", approveUrl: this.config.approveUrl };
    });
  }

  async captureOrder(orderId: string, requestId: string): Promise<GatewayCapture> {
    return this.run("captureOrder", { orderId, requestId }, () => {
      const o = this.order(orderId);
      const key = `cap:${requestId}`;
      let capId = this.byRequestId.get(key) ?? null;
      if (!capId && this.config.returnCaptureId) {
        capId = this.nextId("CAPTURE");
        this.byRequestId.set(key, capId);
        this.captures.set(capId, { orderId, amount: this.config.captureAmount ?? o.amount, currency: this.config.captureCurrency ?? o.currency });
      }
      o.captured = true;
      return this.captureFor(o, capId);
    });
  }

  async getOrder(orderId: string): Promise<GatewayCapture> {
    return this.run("getOrder", { orderId }, () => {
      const o = this.order(orderId);
      const capId = [...this.captures.entries()].find(([, c]) => c.orderId === orderId)?.[0] ?? null;
      return this.captureFor(o, o.captured ? capId : null);
    });
  }

  async getCapture(captureId: string): Promise<GatewayCapture> {
    return this.run("getCapture", { captureId }, () => {
      const c = this.captures.get(captureId);
      if (!c) throw new PayPalApiError("PAYPAL_REQUEST_REJECTED", "Double: unknown capture.", 404, { paypal_status: 404 });
      return this.captureFor(this.order(c.orderId), captureId);
    });
  }

  async refundCapture(input: Parameters<PayPalGateway["refundCapture"]>[0]): Promise<GatewayRefund> {
    return this.run("refundCapture", input, () => {
      const key = `ref:${input.requestId}`;
      let refundId = this.byRequestId.get(key);
      if (!refundId) {
        refundId = this.nextId("REFUND");
        this.byRequestId.set(key, refundId);
        this.refunds.set(refundId, {
          refundId,
          status: this.config.refundStatus,
          amount: this.config.refundAmount ?? input.amount,
          currency: input.currency,
          captureId: input.captureId,
        });
      }
      return { refundId, status: this.refunds.get(refundId)!.status };
    });
  }

  async getRefund(refundId: string): Promise<GatewayRefundState> {
    return this.run("getRefund", { refundId }, () => {
      const r = this.refunds.get(refundId);
      if (!r) throw new PayPalApiError("PAYPAL_REQUEST_REJECTED", "Double: unknown refund.", 404, { paypal_status: 404 });
      return { ...r, status: this.config.refundStatus };
    });
  }

  async createPayout(input: { senderBatchId: string; emailSubject: string; items: PayoutItemInput[] }): Promise<GatewayPayout> {
    return this.run("createPayout", { senderBatchId: input.senderBatchId, itemCount: input.items.length }, () => ({
      batchId: this.nextId("BATCH"),
      batchStatus: "PENDING",
      items: input.items.map((i) => ({ senderItemId: i.senderItemId, itemId: this.nextId("ITEM"), status: "PENDING", reason: null })),
    }));
  }

  async getPayout(batchId: string): Promise<GatewayPayout> {
    return this.run("getPayout", { batchId }, () => ({ batchId, batchStatus: "SUCCESS", items: [] }));
  }

  async verifyWebhook(input: WebhookVerifyInput): Promise<boolean> {
    return this.run("verifyWebhook", { headerNames: Object.keys(input.headers) }, () => true);
  }
}
