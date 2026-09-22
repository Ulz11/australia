/**
 * QPay — merchant API v2 (developer.qpay.mn).
 *
 * How a payment goes:
 *  1. We get a token with Basic auth (username:password) and keep it until it's nearly out.
 *  2. We raise an invoice → QPay hands back a QR, a short link and one deeplink per bank app.
 *  3. The payer pays in their bank app. QPay calls our callback_url.
 *  4. The callback is only a nudge: we ask QPay itself (/payment/check) whether the invoice
 *     is paid. A callback never marks anything paid on its own word.
 *
 * Amounts are whole tögrög (MNT). This module does no currency conversion — ever.
 * Pure HTTP: no database here, so it tests without one. Storage lives in lib/billing.ts.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const QPAY_BASE_DEFAULT = "https://merchant.qpay.mn/v2";

export type QpayInvoice = {
  invoice_id: string;
  qr_text: string;
  qr_image: string;                         // base64 PNG
  qPay_shortUrl: string;
  urls: { name: string; description: string; logo: string; link: string }[];
};

/**
 * What a payer needs, kept from the moment the invoice is raised: GET /invoice/{id} doesn't hand the QR or the
 * bank links back again (checked Sept 2026), so lib/billing.ts stores this while the invoice can be paid.
 */
export type QpayQr = {
  qr_image: string;                         // base64 PNG
  short_url: string | null;
  urls: { name: string; logo: string | null; link: string }[];
};

/**
 * The QR, short link and bank-app links out of QPay's answer, fit to put on a page. The links go straight into
 * an href, so only a real app scheme or https survives (never javascript:, data: and the like), and logos and
 * the short link must be https.
 */
export function payLinks(inv: Pick<QpayInvoice, "qr_image" | "qPay_shortUrl" | "urls">): QpayQr {
  const https = (s: unknown) => (typeof s === "string" && /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : null);
  const appLink = (s: unknown) => {
    if (typeof s !== "string" || s.length > 2000 || /[\s"'<>]/.test(s)) return null;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1]?.toLowerCase();
    return scheme && !["javascript", "data", "vbscript", "file", "blob", "about", "http"].includes(scheme) ? s : null;
  };
  const urls = (Array.isArray(inv.urls) ? inv.urls : []).flatMap((u) => {
    const link = appLink(u?.link), name = typeof u?.name === "string" ? u.name.trim().slice(0, 60) : "";
    return link && name ? [{ name, logo: https(u.logo), link }] : [];
  });
  const png = typeof inv.qr_image === "string" && /^[A-Za-z0-9+/=\s]+$/.test(inv.qr_image) ? inv.qr_image.replace(/\s/g, "") : "";
  return { qr_image: png, short_url: https(inv.qPay_shortUrl), urls };
}

export type QpayPaymentRow = {
  payment_id: string;
  payment_status: string;                   // 'PAID' | 'NEW' | 'FAILED' | 'REFUNDED'
  payment_amount: string | number;
  payment_currency?: string;
  payment_date?: string;
  payment_wallet?: string;
};

export type PaymentCheck = { paid: boolean; paidAmount: number; count: number; rows: QpayPaymentRow[] };

type TokenState = { access: string; accessUntil: number; refresh: string | null; refreshUntil: number };

declare global {
  var __qpayToken: TokenState | undefined;
  var __qpayTokenInflight: Promise<string> | undefined;
}

const cfg = () => ({
  base: (process.env.QPAY_BASE_URL || QPAY_BASE_DEFAULT).replace(/\/+$/, ""),
  username: process.env.QPAY_USERNAME,
  password: process.env.QPAY_PASSWORD,
  invoiceCode: process.env.QPAY_INVOICE_CODE,
});

/** True when every credential QPay needs is present. */
export function qpayConfigured(): boolean {
  const c = cfg();
  return !!(c.username && c.password && c.invoiceCode);
}

/** Forget the cached token (tests, or after QPay says 401). */
export function resetQpayToken() {
  global.__qpayToken = undefined;
  global.__qpayTokenInflight = undefined;
}

/**
 * QPay's expiry fields have been seen both as a unix timestamp and as seconds-from-now.
 * Anything that looks like an epoch is treated as one; small numbers are a duration.
 */
export function expiryToMs(v: unknown, now = Date.now()): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return now + 5 * 60_000;   // unknown → assume 5 min, refresh early rather than late
  if (n > 1e12) return n;                                        // epoch ms
  if (n > 1e9) return n * 1000;                                  // epoch s
  return now + n * 1000;                                         // duration s
}

// QPay (checked Sept 2026) gives both tokens the same 24 h expiry, so /auth/refresh only works while the access
// token is still alive. Renew inside the last 5 minutes — refresh still succeeds then — and never cut it finer than 30 s.
const RENEW = 5 * 60_000;
const SKEW = 30_000;

async function authCall(path: string, authorization: string): Promise<TokenState> {
  const res = await fetch(`${cfg().base}${path}`, {
    method: "POST",
    headers: { Authorization: authorization, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new QpayError(`QPay ${path} failed`, res.status, await safeText(res));
  const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: unknown; refresh_expires_in?: unknown };
  if (!j.access_token) throw new QpayError(`QPay ${path} returned no access_token`, res.status, JSON.stringify(j).slice(0, 200));
  return {
    access: j.access_token,
    accessUntil: expiryToMs(j.expires_in),
    refresh: j.refresh_token ?? null,
    refreshUntil: j.refresh_token ? expiryToMs(j.refresh_expires_in) : 0,
  };
}

/** A valid access token: cached → refreshed → fresh login, in that order. Concurrent callers share one request. */
export async function getQpayToken(): Promise<string> {
  const now = Date.now();
  const t = global.__qpayToken;
  if (t && t.accessUntil - RENEW > now) return t.access;
  if (global.__qpayTokenInflight) return global.__qpayTokenInflight;

  const c = cfg();
  if (!c.username || !c.password) throw new QpayError("QPay credentials not set (QPAY_USERNAME / QPAY_PASSWORD)", 0, "");

  const mine: { p?: Promise<string> } = {};
  mine.p = (async () => {
    try {
      let next: TokenState | null = null;
      if (t?.refresh && t.refreshUntil - SKEW > now) {
        next = await authCall("/auth/refresh", `Bearer ${t.refresh}`).catch(() => null);  // a dead refresh token just means log in again
        if (next && next.accessUntil <= t.accessUntil) next = null;                       // refresh didn't buy time — log in rather than refresh on every call
      }
      next ??= await authCall("/auth/token", "Basic " + Buffer.from(`${c.username}:${c.password}`).toString("base64"));
      global.__qpayToken = next;
      return next.access;
    } finally {
      if (global.__qpayTokenInflight === mine.p) global.__qpayTokenInflight = undefined;   // only clear our own
    }
  })();
  global.__qpayTokenInflight = mine.p;
  return mine.p;
}

/** Authenticated JSON call. One retry with a fresh login if QPay says the token is no good. */
async function qpay<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, retried = false): Promise<T> {
  const token = await getQpayToken();
  const res = await fetch(`${cfg().base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 && !retried) {
    // Drop only the token that failed. If ten calls hit 401 together, the first clears it and
    // the rest find a login already in flight (or already done) — one login, not ten.
    if (global.__qpayToken?.access === token) global.__qpayToken = undefined;
    return qpay<T>(method, path, body, true);
  }
  if (!res.ok) throw new QpayError(`QPay ${method} ${path} failed`, res.status, await safeText(res));
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Raise an invoice. `senderInvoiceNo` is ours and must be unique forever — QPay rejects repeats.
 * `amount` is whole MNT.
 */
export async function createQpayInvoice(p: {
  senderInvoiceNo: string;
  amount: number;
  description: string;
  callbackUrl: string;
  receiverCode?: string;
}): Promise<QpayInvoice> {
  const c = cfg();
  if (!c.invoiceCode) throw new QpayError("QPAY_INVOICE_CODE not set", 0, "");
  if (!Number.isInteger(p.amount) || p.amount <= 0) throw new QpayError(`Invoice amount must be a positive whole number of MNT, got ${p.amount}`, 0, "");
  if (!/^[\w-]{1,45}$/.test(p.senderInvoiceNo)) throw new QpayError("senderInvoiceNo must be 1–45 letters, digits, _ or -", 0, "");
  return qpay<QpayInvoice>("POST", "/invoice", {
    invoice_code: c.invoiceCode,
    sender_invoice_no: p.senderInvoiceNo,
    invoice_receiver_code: p.receiverCode ?? "terminal",
    invoice_description: p.description.slice(0, 255),
    amount: p.amount,
    callback_url: p.callbackUrl,
  });
}

export const cancelQpayInvoice = (invoiceId: string) => qpay<Record<string, unknown>>("DELETE", `/invoice/${encodeURIComponent(invoiceId)}`);

/** Ask QPay whether an invoice is paid. The only source of truth for "paid". */
export async function checkQpayPayment(invoiceId: string): Promise<PaymentCheck> {
  const j = await qpay<{ count?: number; paid_amount?: number | string; rows?: QpayPaymentRow[] }>("POST", "/payment/check", {
    object_type: "INVOICE",
    object_id: invoiceId,
    offset: { page_number: 1, page_limit: 100 },
  });
  const rows = Array.isArray(j.rows) ? j.rows : [];
  const paidRows = rows.filter((r) => String(r.payment_status).toUpperCase() === "PAID" && (!r.payment_currency || r.payment_currency.toUpperCase() === "MNT"));
  // Sum our own filtered rows. QPay's top-level paid_amount counts every row, whatever the currency.
  const paidAmount = paidRows.reduce((s, r) => s + (Number(r.payment_amount) || 0), 0);
  return { paid: paidRows.length > 0, paidAmount, count: Number(j.count ?? rows.length) || 0, rows: paidRows };
}

/**
 * Callback URLs carry an HMAC of our invoice number, so only the holder of the exact URL we gave QPay
 * can nudge a payment check. Everything else is turned away before the database or QPay hears of it.
 */
export function callbackSecret(): string {
  const s = process.env.QPAY_CALLBACK_SECRET || process.env.SESSION_SECRET;
  if (!s) throw new QpayError("QPAY_CALLBACK_SECRET (or SESSION_SECRET) must be set to sign QPay callbacks", 0, "");
  return s;
}
export function callbackSig(senderInvoiceNo: string, secret = callbackSecret()): string {
  return createHmac("sha256", secret).update(`qpay-callback:${senderInvoiceNo}`).digest("hex").slice(0, 32);
}
export function callbackSigOk(senderInvoiceNo: string, sig: string, secret = callbackSecret()): boolean {
  const want = Buffer.from(callbackSig(senderInvoiceNo, secret));
  const got = Buffer.from(String(sig));
  return got.length === want.length && timingSafeEqual(got, want);
}

export class QpayError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(status ? `${message} (${status}): ${body.slice(0, 200)}` : message);
    this.name = "QpayError";
  }
}

/**
 * QPay refused to cancel an invoice because it isn't there to cancel — never existed, or already cancelled.
 * For a cancel that is the outcome we wanted. A refusal for any other reason (paid, network, 5xx) is not.
 */
export function qpayGone(e: unknown): boolean {
  if (!(e instanceof QpayError)) return false;
  if (e.status === 404) return true;
  return e.status >= 400 && e.status < 500 && /NOT[_ ]?FOUND|ALREADY[_ ]?CANCEL|CANCELL?ED/i.test(e.body);
}

async function safeText(res: Response) {
  try { return await res.text(); } catch { return ""; }
}
