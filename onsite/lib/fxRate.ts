import { sql } from "./db";
import { audMntRate } from "./subscription";
import { todayIso } from "./util";

/**
 * Tögrög per 1 Australian dollar, for the QPay amount on an invoice. Never tögrög per US dollar: at the Bank of
 * Mongolia's rate for 17 Sept 2026 that was ₮3,595.66, against ₮2,559.03 for A$1 — the US figure would overcharge
 * by about 40%. Every source below is read by the AUD key and nothing else.
 *
 * Where the rate comes from, in order:
 *   1. AUD_MNT_RATE, when AUD_MNT_RATE_OVERRIDE=1 — a person has decided the rate, and nothing is fetched.
 *   2. The Bank of Mongolia's official daily rate: the JSON its own currency-rates page loads
 *      (POST https://www.mongolbank.mn/en/currency-rates/data, "Closing rate on" RATE_DATE; the bank notes the
 *      rate is valid for the next day for accounting). Not a published API — if it changes shape it is simply a
 *      failed source. The page also runs reCAPTCHA v3 for its own use; the data call doesn't need it, and if it
 *      ever does, this source fails and the next one is used. Nothing here tries to get past it.
 *   3. ExchangeRate-API's open endpoint (https://open.er-api.com/v6/latest/AUD): updated once a day, no key,
 *      rate-limited if asked too often; commercial use allowed with attribution, which the invoice page shows.
 *   4. AUD_MNT_RATE without the override — a manual last resort.
 * Nothing works → null, and the invoice says the rate is briefly unavailable (FX_UNAVAILABLE).
 *
 * A fetched rate is kept in Postgres (fx_rates, migration 012) and reused for 6 hours, so serverless instances
 * don't each ask again. Every fetch gives up after 8 s. A rate outside a plausible band is a source error: it is
 * logged (the numbers only) and the next source is tried. Nothing here throws.
 */

type Env = Record<string, string | undefined>;

export type FxSource = "mongolbank" | "fallback" | "env";
export type FxQuote = { rate: number; source: FxSource; asOf: string };
type Fetched = { rate: number; asOf: string };

export const FX_PAIR = "AUD/MNT";
/** How long a fetched rate is used before asking again. */
export const FX_FRESH = "6 hours";
/** A cached rate older than this isn't shown even as an estimate. */
const FX_SHOWN = "7 days";
export const FX_TIMEOUT_MS = 8_000;
/**
 * Tögrög per A$1 that could be real. It was ₮2,559 on 17 Sept 2026; outside this band a source is wrong, not the
 * market. It can't tell AUD from USD (₮3,596 that day) — reading the AUD key is what does that.
 */
export const AUD_MNT_MIN = 1_000;
export const AUD_MNT_MAX = 5_000;
export const plausibleAudMnt = (rate: number) => Number.isFinite(rate) && rate >= AUD_MNT_MIN && rate <= AUD_MNT_MAX;

export const MONGOLBANK_RATES_URL = "https://www.mongolbank.mn/en/currency-rates/data";
export const FALLBACK_RATES_URL = "https://open.er-api.com/v6/latest/AUD";

const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Mongolbank's answer: { success: true, data: [{ RATE_DATE: "2026-09-17", AUD: "2,559.03", USD: "3,595.66", … }] }. The latest day's AUD. */
export function parseMongolbank(body: unknown): Fetched | null {
  const b = obj(body);
  if (b?.success !== true || !Array.isArray(b.data)) return null;
  const rows = b.data.map(obj).filter((r): r is Record<string, unknown> => !!r && isDay(r.RATE_DATE));
  const latest = rows.sort((x, y) => String(y.RATE_DATE).localeCompare(String(x.RATE_DATE)))[0];
  const aud = typeof latest?.AUD === "string" ? latest.AUD.replace(/,/g, "").trim() : null;
  if (!aud || !/^\d+(\.\d+)?$/.test(aud)) return null;
  return { rate: Number(aud), asOf: String(latest.RATE_DATE) };
}

/**
 * ExchangeRate-API's answer: { result: "success", base_code: "AUD", time_last_update_unix, rates: { MNT: 2570.295114 } }.
 * Kept to two decimals, as the Bank of Mongolia publishes it; the day is the UTC day of its last update.
 */
export function parseFallback(body: unknown): Fetched | null {
  const b = obj(body), rates = obj(b?.rates);
  if (b?.result !== "success" || b.base_code !== "AUD" || typeof rates?.MNT !== "number") return null;
  const updated = Number(b.time_last_update_unix);
  if (!Number.isFinite(updated) || updated <= 0) return null;
  return { rate: Math.round(rates.MNT * 100) / 100, asOf: new Date(updated * 1000).toISOString().slice(0, 10) };
}

async function getJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(FX_TIMEOUT_MS) });
  if (!res.ok) throw Object.assign(new Error("not ok"), { name: `HTTP ${res.status}` });
  return res.json();
}

const ask: Record<Exclude<FxSource, "env">, () => Promise<Fetched | null>> = {
  mongolbank: async () => {
    const today = new Date(), weekAgo = new Date(today.getTime() - 7 * 86_400_000);   // what its own page sends; the answer is the latest day
    return parseMongolbank(await getJson(MONGOLBANK_RATES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ startDate: weekAgo.toISOString().slice(0, 10), endDate: today.toISOString().slice(0, 10) }),
    }));
  },
  fallback: async () => parseFallback(await getJson(FALLBACK_RATES_URL, { headers: { Accept: "application/json" } })),
};

/** One source, fetched, checked and cached. Null — never a throw — when it can't give a rate worth using. */
async function fetchRate(source: Exclude<FxSource, "env">): Promise<FxQuote | null> {
  let got: Fetched | null;
  try {
    got = await ask[source]();
  } catch (e) {
    console.error("fx: no answer from", source, (e as Error)?.name ?? "error");
    return null;
  }
  if (!got) {
    console.error("fx: no AUD rate in the answer from", source);
    return null;
  }
  if (!plausibleAudMnt(got.rate)) {
    console.error("fx: rate out of range from", source, got.rate, [AUD_MNT_MIN, AUD_MNT_MAX]);
    return null;
  }
  await sql`
    INSERT INTO fx_rates (pair, rate, source, as_of, fetched_at) VALUES (${FX_PAIR}, ${got.rate}, ${source}, ${got.asOf}, now())
    ON CONFLICT (pair, as_of, source) DO UPDATE SET rate = EXCLUDED.rate, fetched_at = EXCLUDED.fetched_at`
    .catch((e) => console.error("fx: couldn't cache the rate", e?.code ?? e?.name ?? "error"));
  return { rate: got.rate, source, asOf: got.asOf };
}

type Cached = FxQuote & { fresh: boolean };

/** Cached rates from the last week: fresh ones first, the Bank of Mongolia's before the fallback's, latest day first. */
async function cachedRates(): Promise<Cached[]> {
  try {
    const rows = await sql<{ rate: string; source: "mongolbank" | "fallback"; as_of: string; fresh: boolean }[]>`
      SELECT rate::text AS rate, source, as_of, fetched_at > now() - ${FX_FRESH}::interval AS fresh
      FROM fx_rates
      WHERE pair = ${FX_PAIR} AND source IN ('mongolbank', 'fallback') AND fetched_at > now() - ${FX_SHOWN}::interval
      ORDER BY fresh DESC, (source = 'mongolbank') DESC, as_of DESC, fetched_at DESC
      LIMIT 10`;
    return rows.map((r) => ({ rate: Number(r.rate), source: r.source, asOf: r.as_of, fresh: r.fresh })).filter((r) => plausibleAudMnt(r.rate));
  } catch (e) {
    console.error("fx: couldn't read cached rates", (e as { code?: string })?.code ?? (e as Error)?.name ?? "error");
    return [];
  }
}

const quote = (c: Cached): FxQuote => ({ rate: c.rate, source: c.source, asOf: c.asOf });

/** AUD_MNT_RATE as a quote dated today (Sydney), or null when it is unset, not a number, or not plausible. */
function envRate(env: Env): FxQuote | null {
  const raw = audMntRate(env);
  if (raw === null) return null;
  if (!plausibleAudMnt(Number(raw))) {
    console.error("fx: AUD_MNT_RATE out of range", Number(raw), [AUD_MNT_MIN, AUD_MNT_MAX]);
    return null;
  }
  return { rate: Number(raw), source: "env", asOf: todayIso() };
}

export type AudToMntOptions = {
  /** Never fetch: for rendering a page. A stale cached rate (up to a week) still serves as an estimate. */
  cachedOnly?: boolean;
  /** The cron's warm-up: a fresh fallback rate doesn't stop it asking the Bank of Mongolia again. */
  preferOfficial?: boolean;
  env?: Env;
};

/** Tögrög per A$1, and where it came from. See the top of this file for the order. Never throws. */
export async function audToMnt(opts: AudToMntOptions = {}): Promise<FxQuote | null> {
  const env = opts.env ?? process.env;
  try {
    const manual = envRate(env);
    if (manual && env.AUD_MNT_RATE_OVERRIDE === "1") return manual;

    const cache = await cachedRates();
    const official = cache.find((c) => c.fresh && c.source === "mongolbank");
    const fallback = cache.find((c) => c.fresh && c.source === "fallback");
    if (official) return quote(official);
    if (fallback && !opts.preferOfficial) return quote(fallback);
    if (opts.cachedOnly) return cache[0] ? quote(cache[0]) : manual;

    return (await fetchRate("mongolbank")) ?? (fallback ? quote(fallback) : null) ?? (await fetchRate("fallback")) ?? manual;
  } catch (e) {
    console.error("fx: rate lookup failed", (e as Error)?.name ?? "error");
    return null;
  }
}

/** For the cron: make sure a fresh official rate is cached, fetching only when there isn't one from the last 6 hours. */
export const warmAudToMnt = (env?: Env) => audToMnt({ preferOfficial: true, env });
