/**
 * Service NSW — "Holders of White Cards and Traffic Control Work Cards Register"
 * (api.onegov.nsw.gov.au, OAS 2.0 spec 32).
 *
 * Two calls, in this order:
 *  1. GET /oauth/client_credential/accesstoken — Basic auth, hands back a bearer token.
 *  2. GET /wcregister/v1/verify?licenceNumber=… — Bearer token *and* the apikey header.
 *     200 is always an array. An empty array means "checked, no such card".
 *
 * The register also has /browse and /details. We never call them: searching by name hands
 * back other people's cards, and verify-by-number answers the only question we have.
 *
 * Privacy: the register returns a home address with every record. It is dropped here, at the
 * parser, and never carried further. Nothing in this file logs — not bodies, not URLs (they
 * carry card numbers), not names.
 *
 * Pure HTTP: no database, so it tests without one. The mapping to a licence status lives in
 * lib/licenceCheck.ts — which is also the only module that may import this one at runtime,
 * because this one reads credentials. Nothing a client component imports may reach it.
 */

export const WHITECARD_BASE_DEFAULT = "https://api.onegov.nsw.gov.au";

/**
 * Calls the whole app may make at the register in a day.
 *
 * API NSW's free tier (api.nsw.gov.au/Product/Index/32) is **2,500 calls a month**, and publishes
 * no per-day or per-second figure. There is no sandbox either: every key hits production, so this
 * budget covers the test keys as well. 70 a day is ≈2,100 a month, which leaves headroom for
 * re-checks and the odd `npm run whitecard:ping`.
 *
 * A cost ceiling, not a lock — the number lives here beside the register it protects, the counting
 * happens in lib/licenceCheck.ts right before the call, and a check we refuse to make reads as
 * "couldn't check", never "not on the register". Override with WHITECARD_CHECKS_PER_DAY.
 */
export const whitecardChecksPerDay = () => Number(process.env.WHITECARD_CHECKS_PER_DAY) || 70;

/** Deliberately minimal: everything the register sends that we don't need is dropped at parse. */
export type WhiteCardRecord = {
  licenceNumber: string | null;
  status: string | null;            // Current | Expired | Refused | Suspended | …
  licenceType: string | null;       // live: "General Construction Induction Training Card" | "Traffic Control Work Card"
  licenceName: string | null;
  licensee: string | null;
  startDate: string | null;         // YYYY-MM-DD
  expiryDate: string | null;
  refusedDate: string | null;
};

type TokenState = { access: string; until: number };

declare global {
  var __whitecardToken: TokenState | undefined;
  var __whitecardTokenInflight: Promise<string> | undefined;
}

const TIMEOUT = 8_000;
const RENEW = 60_000;             // renew a minute early — a token that dies mid-call costs a retry

const cfg = () => ({
  base: (process.env.WHITE_CARD_BASE_URL || WHITECARD_BASE_DEFAULT).replace(/\/+$/, ""),
  key: process.env.WHITE_CARD_API_KEY,
  secret: process.env.WHITE_CARD_API_SECRET,
  header: process.env.WHITE_CARD_AUTH_HEADER,
});

/** True when we can both authenticate and identify ourselves on the verify call. */
export function whitecardConfigured(): boolean {
  const c = cfg();
  return !!(c.key && (c.header || c.secret));
}

/** Forget the cached token (tests, or after the API says 401). */
export function resetWhitecardToken() {
  global.__whitecardToken = undefined;
  global.__whitecardTokenInflight = undefined;
}

/**
 * The portal shows a ready-made `Basic …` header beside the key and secret. Where it's set we
 * send it as pasted — it is what the portal itself claims will work — and only derive one from
 * key:secret when it isn't.
 */
export function whitecardBasicAuth(): string {
  const c = cfg();
  const pasted = c.header?.trim();
  if (pasted) return /^basic\s/i.test(pasted) ? pasted : `Basic ${pasted}`;
  return "Basic " + Buffer.from(`${c.key}:${c.secret}`).toString("base64");
}

/**
 * `expires_in` comes back as a string and the spec never says what unit it's in (`issued_at`
 * beside it is milliseconds). Anything big enough to be silly as seconds is read as ms.
 */
export function expiryToMs(v: unknown, now = Date.now()): number {
  const n = Number(String(v ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return now + 30 * 60_000;   // unknown → assume half an hour and renew early
  return now + (n > 1e7 ? n : n * 1000);
}

/** Registers print numbers in different cases, sometimes with stray spaces. */
export function sameNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();
}

/** Dates arrive as DD/MM/YYYY here and ISO there. Anything we can't read becomes null, not today. */
export function isoDay(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

async function fetchToken(): Promise<TokenState> {
  const res = await fetch(`${cfg().base}/oauth/client_credential/accesstoken?grant_type=client_credentials`, {
    headers: { Authorization: whitecardBasicAuth(), Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new WhiteCardError("token request refused", res.status);
  const j = (await res.json()) as { access_token?: string; expires_in?: unknown };
  if (!j.access_token) throw new WhiteCardError("token response carried no access_token", res.status);
  return { access: j.access_token, until: expiryToMs(j.expires_in) };
}

/** A live bearer token. Concurrent callers share one request rather than each buying their own. */
export async function whitecardToken(): Promise<string> {
  const now = Date.now();
  const t = global.__whitecardToken;
  if (t && t.until - RENEW > now) return t.access;
  if (global.__whitecardTokenInflight) return global.__whitecardTokenInflight;
  if (!whitecardConfigured()) throw new WhiteCardError("White Card credentials not set (WHITE_CARD_API_KEY plus secret or auth header)", 0);

  const mine: { p?: Promise<string> } = {};
  mine.p = (async () => {
    try {
      const next = await fetchToken();
      global.__whitecardToken = next;
      return next.access;
    } catch (e) {
      // We renew a minute early, so a login that fails during that minute still has a live token
      // in hand. Use it rather than turning a blip at the token endpoint into "couldn't check"
      // for every worker. A token the API has actually rejected is deleted by the 401 path, so
      // this can never resurrect one.
      const held = global.__whitecardToken;
      if (held && held.until > Date.now()) return held.access;
      throw e;
    } finally {
      if (global.__whitecardTokenInflight === mine.p) global.__whitecardTokenInflight = undefined;   // only clear our own
    }
  })();
  global.__whitecardTokenInflight = mine.p;
  return mine.p;
}

/**
 * Ask the register about one card number.
 *  - `null`  we could not check (no credentials, network, timeout, 5xx, unreadable body, 401 twice)
 *  - `[]`    we did check and the register has nothing
 * The difference is the whole point: "couldn't check" must never become "not on the register".
 */
export async function verifyWhiteCard(number: string): Promise<WhiteCardRecord[] | null> {
  if (!whitecardConfigured()) return null;
  const n = number.trim();
  if (!n) return null;
  return call(n, false);
}

async function call(number: string, retried: boolean): Promise<WhiteCardRecord[] | null> {
  let token: string;
  try {
    token = await whitecardToken();
  } catch {
    return null;
  }
  try {
    const url = new URL(`${cfg().base}/wcregister/v1/verify`);
    url.searchParams.set("licenceNumber", number);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, apikey: cfg().key!, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (res.status === 401 && !retried) {
      // Drop only the token that failed, so ten calls hitting 401 together cause one login, not ten.
      if (global.__whitecardToken?.access === token) global.__whitecardToken = undefined;
      return call(number, true);
    }
    // Every other status is "couldn't check", 400 included. A 400 means the register refused to
    // look — at a number it doesn't like the shape of, or at a request we got wrong. Neither is
    // the register saying the card doesn't exist, and "not on the register" is a red badge a boss
    // sees: we don't put that on a worker on the strength of an error we can't read.
    //
    // 429 and 503 are the same answer for a different reason: we're throttled. The product page
    // documents no status for a spent quota, and the sibling NSW gateway answers one with a 503
    // ("Your API quota or rate limit has been exceeded"), so both are read as "couldn't check" —
    // never as "absent", and never retried here, because a retry is one more call against the quota
    // that just ran out. (lib/licenceRecheck.ts asks again later, on a backoff, within the day's budget.)
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return null;                        // a shape we don't understand is "couldn't check"
    return body.filter((r): r is Record<string, unknown> => !!r && typeof r === "object").map(toRecord);
  } catch {
    return null;
  }
}

/** The boundary. Whatever else the register sent — address, suburb, postcode — stops here. */
function toRecord(r: Record<string, unknown>): WhiteCardRecord {
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    licenceNumber: s(r.licenceNumber),
    status: s(r.status),
    licenceType: s(r.licenceType),
    licenceName: s(r.licenceName),
    licensee: s(r.licensee),
    startDate: isoDay(r.startDate),
    expiryDate: isoDay(r.expiryDate),
    refusedDate: isoDay(r.refusedDate),
  };
}

export class WhiteCardError extends Error {
  constructor(message: string, readonly status: number) {
    super(status ? `White Card register: ${message} (${status})` : `White Card register: ${message}`);
    this.name = "WhiteCardError";
  }
}
