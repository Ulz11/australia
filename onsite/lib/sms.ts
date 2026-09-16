/**
 * Sends one SMS through ClickSend or Twilio, or — with no provider — logs it in development.
 *
 * The contract every caller relies on (login codes in actions/auth.ts, shift offers in lib/alerts.ts):
 *  - `{ sent: true }` only when the provider accepted this message for delivery.
 *  - `{ sent: false, stub: true }` means there was no provider to try (development only) — nothing to retry.
 *  - `{ sent: false }` is a failure worth retrying, and callers hand back any budget they charged for it.
 *  - Never throws, never waits more than 8 s, and never writes the number or the message to a log
 *    (the message can be a login code). The development stub is the one exception, on purpose.
 *  - In production with no usable provider it refuses, and says so in the log — except on a deployment declared a
 *    demo (DEMO_SITE=1, lib/flags.ts), where having no texts is the plan and a log line per sign-in is only noise.
 *
 * Which provider: SMS_PROVIDER (`clicksend` | `twilio`) when set; otherwise whichever one has credentials,
 * ClickSend first (Australian gateway, the one the beta uses).
 */
import { demoSite } from "./flags";

export type SmsResult = { sent: boolean; stub?: boolean };
export type SmsProvider = "clicksend" | "twilio";

const TIMEOUT_MS = 8_000;
export const CLICKSEND_SEND_URL = "https://rest.clicksend.com/v3/sms/send";

const clicksendReady = () => !!(process.env.CLICKSEND_USERNAME && process.env.CLICKSEND_API_KEY);
const twilioReady = () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);

/** The provider a text would go through right now, or null with the reason (variable names only, never values). */
export function smsProvider(): { provider: SmsProvider; why?: undefined } | { provider: null; why: string } {
  const want = (process.env.SMS_PROVIDER ?? "").trim().toLowerCase();
  if (want === "clicksend")
    return clicksendReady() ? { provider: "clicksend" } : { provider: null, why: "SMS_PROVIDER=clicksend but CLICKSEND_USERNAME / CLICKSEND_API_KEY aren't set" };
  if (want === "twilio")
    return twilioReady() ? { provider: "twilio" } : { provider: null, why: "SMS_PROVIDER=twilio but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM aren't set" };
  if (want) return { provider: null, why: "SMS_PROVIDER must be clicksend or twilio" };
  if (clicksendReady()) return { provider: "clicksend" };
  if (twilioReady()) return { provider: "twilio" };
  return { provider: null, why: "set CLICKSEND_USERNAME and CLICKSEND_API_KEY" };
}

export async function sendSms(to: string, body: string): Promise<SmsResult> {
  const p = smsProvider();
  if (!p.provider) {
    if (process.env.NODE_ENV === "production") {
      if (!demoSite()) console.error(`[sms] no provider configured — nothing sent (${p.why})`);   // never log the message: it can be a login code
      return { sent: false };                                                   // a failure, so alerts retry instead of vanishing
    }
    console.log(`[sms:stub] to=${to} :: ${body}`);
    return { sent: false, stub: true };
  }
  try {
    return p.provider === "clicksend" ? await viaClickSend(to, body) : await viaTwilio(to, body);
  } catch (e) {
    // A network blip or the 8 s timeout is "not sent", never a crash for the caller. The error's name only:
    // a message could one day quote the request.
    console.error(`[sms] ${p.provider} unreachable`, (e as Error)?.name ?? "error");
    return { sent: false };
  }
}

/** Only a provider's own enum-like word is safe to log; anything else could echo what we sent. */
const code = (v: unknown) => (typeof v === "string" && /^[A-Z0-9_]{1,40}$/.test(v) ? v : "unrecognised");

/**
 * ClickSend REST v3 — POST /v3/sms/send, HTTP Basic with username:api_key.
 * Body: { messages: [{ source, to, body, from? }] }. Leaving `from` out sends from ClickSend's shared number.
 * Reply: { http_code, response_code, response_msg, data: { queued_count, blocked_count, messages: [{ status, … }] } }.
 * The top-level code "doesn't reflect the status of each message", so a text only counts as sent on HTTP 200
 * AND the message's own status === "SUCCESS". Anything else — INSUFFICIENT_CREDIT, INVALID_RECIPIENT, a blocked
 * sender — is sent: false, so budgets are handed back and alerts retry.
 */
async function viaClickSend(to: string, body: string): Promise<SmsResult> {
  const user = process.env.CLICKSEND_USERNAME!, key = process.env.CLICKSEND_API_KEY!;
  const from = process.env.CLICKSEND_FROM?.trim();
  const res = await fetch(CLICKSEND_SEND_URL, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${user}:${key}`).toString("base64"),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ messages: [{ source: "onsite", to, body, ...(from ? { from } : {}) }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const reply = (await res.json().catch(() => null)) as
    | { response_code?: unknown; data?: { messages?: { status?: unknown }[] } }
    | null;
  if (res.status !== 200) {
    console.error("[sms] clicksend error", res.status, code(reply?.response_code));
    return { sent: false };
  }
  const status = reply?.data?.messages?.[0]?.status;
  if (status !== "SUCCESS") {
    console.error("[sms] clicksend refused the message", code(status ?? reply?.response_code));
    return { sent: false };
  }
  return { sent: true };
}

async function viaTwilio(to: string, body: string): Promise<SmsResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID!, tok = process.env.TWILIO_AUTH_TOKEN!, from = process.env.TWILIO_FROM!;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${tok}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // Twilio's error text can quote the number ("The 'To' number +614… is not valid"): log its numeric code only.
    const j = (await res.json().catch(() => null)) as { code?: unknown } | null;
    console.error("[sms] twilio error", res.status, typeof j?.code === "number" ? j.code : "");
  }
  return { sent: res.ok };
}

/** Normalise an Australian mobile to E.164. Accepts 04xx, 614xx, +614xx. Falls back to raw +. */
export function normalisePhone(raw: string): string | null {
  const d = raw.replace(/[^\d+]/g, "");
  if (/^04\d{8}$/.test(d)) return "+61" + d.slice(1);
  if (/^614\d{8}$/.test(d)) return "+" + d;
  if (/^\+614\d{8}$/.test(d)) return d;
  if (/^\+\d{8,15}$/.test(d)) return d; // other countries, for testing
  return null;
}
