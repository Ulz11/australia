/**
 * npm run whitecard:ping — proves the Service NSW White Card credentials in .env work.
 *
 * The portal hands out a key, a secret and a ready-made Basic header, and ours disagree —
 * only the API can say which is right. We try the pasted header first, then base64(key:secret)
 * if that comes back 401, and print which one was accepted. Three calls at most, and they come
 * out of the app's own quota: the free tier is 2,500 calls a month and there is no sandbox, so
 * never put this in a loop. Uncapped on purpose — it's run by hand, a few calls at a time, and
 * the app's daily ceiling (WHITECARD_CHECKS_PER_DAY) leaves headroom for it.
 * Reads only; nothing is written anywhere.
 *
 * Secrets are masked and the register's address fields are never printed.
 */
import path from "node:path";
import { WHITECARD_BASE_DEFAULT, expiryToMs } from "../lib/whitecard";

try { process.loadEnvFile(path.resolve(__dirname, "../.env")); } catch { /* env may already be in the shell */ }

const base = (process.env.WHITE_CARD_BASE_URL || WHITECARD_BASE_DEFAULT).replace(/\/+$/, "");
const key = process.env.WHITE_CARD_API_KEY;
const secret = process.env.WHITE_CARD_API_SECRET;
const header = process.env.WHITE_CARD_AUTH_HEADER?.trim();
const SAMPLE = "CIC1765241";                                  // the swagger's own sample number

const mask = (s?: string | null) => (s ? `${s.slice(0, 6)}… (${s.length} chars)` : "—");
const maskAuth = (v: string) => `${v.split(/\s+/)[0]} ${v.replace(/^\S+\s*/, "").slice(0, 4)}… (${v.length} chars)`;
/** A name only far enough to prove one came back: first name + last initial. */
const maskName = (s?: string | null) => {
  const raw = String(s ?? "").trim();
  if (!raw) return "—";
  const [a, b] = raw.split(",").map((x) => x.trim());
  const parts = (b ? `${b} ${a}` : a).split(/\s+/).filter(Boolean);   // "SMITH, John" is John Smith
  if (!parts.length) return "—";
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0]}.`;
};
/** Belt and braces: nothing we echo back from the API can carry a credential out. */
const redact = (s: string) =>
  [key, secret, header, header?.replace(/^\S+\s*/, "")].filter((v): v is string => !!v && v.length > 3)
    .reduce((acc, v) => acc.split(v).join("«redacted»"), s);
const quota = (res: Response) => {
  const hits = [...res.headers].filter(([k]) => /ratelimit|rate-limit|retry-after|quota|limit/i.test(k));
  return hits.length ? hits.map(([k, v]) => `${k}: ${v}`).join(", ") : "none";
};
const when = (v: unknown) => {
  const n = Number(String(v ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return `${JSON.stringify(v)} → unreadable, assuming 30 min`;
  return `${JSON.stringify(v)} → read as ${n > 1e7 ? "milliseconds" : "seconds"}, expires ${new Date(expiryToMs(v)).toISOString()}`;
};

type TokenJson = { access_token?: string; token_type?: string; expires_in?: unknown; status?: string };

async function tokenCall(label: string, auth: string): Promise<{ status: number; json: TokenJson | null }> {
  const t0 = Date.now();
  const res = await fetch(`${base}/oauth/client_credential/accesstoken?grant_type=client_credentials`, {
    headers: { Authorization: auth, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.text();
  console.log(`   ${label}`);
  console.log(`     HTTP ${res.status}  ${Date.now() - t0} ms   quota headers: ${quota(res)}`);
  if (!res.ok) { console.log(`     refused: ${redact(body).slice(0, 200)}`); return { status: res.status, json: null }; }
  let json: TokenJson;
  try { json = JSON.parse(body) as TokenJson; } catch { console.log(`     body was not JSON`); return { status: res.status, json: null }; }
  console.log(`     token_type          ${json.token_type ?? "—"}`);
  console.log(`     status              ${json.status ?? "—"}`);
  console.log(`     access_token        ${mask(json.access_token)}`);
  console.log(`     expires_in          ${when(json.expires_in)}`);
  console.log(`     fields              ${Object.keys(json).join(", ")}`);
  return { status: res.status, json: json.access_token ? json : null };
}

async function main() {
  console.log(`White Card ping → ${base}`);
  console.log(`  Quota: the API NSW free tier is 2,500 calls a month, and there is no sandbox — this ping spends 2–3 of them.`);
  console.log(`  WHITE_CARD_API_KEY      ${key ? mask(key) : "MISSING"}`);
  console.log(`  WHITE_CARD_API_SECRET   ${secret ? `set (${secret.length} chars)` : "—"}`);
  console.log(`  WHITE_CARD_AUTH_HEADER  ${header ? maskAuth(header) : "—"}`);
  if (!key || (!secret && !header)) { console.log(`\nNothing to try: need WHITE_CARD_API_KEY plus a secret or an auth header.`); process.exit(2); }

  const variants = [
    ...(header ? [{ label: "a) provided WHITE_CARD_AUTH_HEADER", auth: /^basic\s/i.test(header) ? header : `Basic ${header}` }] : []),
    ...(secret ? [{ label: "b) derived Basic base64(key:secret)", auth: "Basic " + Buffer.from(`${key}:${secret}`).toString("base64") }] : []),
  ];

  console.log(`\n1. GET /oauth/client_credential/accesstoken?grant_type=client_credentials`);
  let accepted: string | null = null;
  let token: TokenJson | null = null;
  for (const v of variants) {
    const r = await tokenCall(v.label, v.auth);
    if (r.json) { accepted = v.label; token = r.json; break; }
    if (r.status !== 401) break;                              // only a refusal is worth a second variant
  }
  if (!token?.access_token) { console.log(`\nNeither auth variant got a token. Nothing to verify with.`); process.exit(1); }
  console.log(`   → accepted: ${accepted}`);

  console.log(`\n2. GET /wcregister/v1/verify?licenceNumber=${SAMPLE}`);
  const t1 = Date.now();
  const res = await fetch(`${base}/wcregister/v1/verify?licenceNumber=${encodeURIComponent(SAMPLE)}`, {
    headers: { Authorization: `Bearer ${token.access_token}`, apikey: key, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.text();
  console.log(`   HTTP ${res.status}  ${Date.now() - t1} ms   quota headers: ${quota(res)}`);
  if (!res.ok) { console.log(`   refused: ${redact(body).slice(0, 200)}`); process.exit(1); }

  let rows: unknown;
  try { rows = JSON.parse(body); } catch { console.log(`   body was not JSON`); process.exit(1); }
  if (!Array.isArray(rows)) { console.log(`   expected an array, got ${typeof rows} with keys: ${Object.keys(rows as object).join(", ")}`); process.exit(1); }
  console.log(`   results             ${rows.length}`);
  rows.forEach((r, i) => {
    const rec = r as Record<string, unknown>;
    console.log(`   [${i}] status ${String(rec.status)} · licenceType ${String(rec.licenceType)} · licenceName ${String(rec.licenceName)}`);
    console.log(`       startDate ${String(rec.startDate)} · expiryDate ${String(rec.expiryDate)} · refusedDate ${String(rec.refusedDate)}`);
    console.log(`       licenceNumber ${String(rec.licenceNumber)} · licensee ${maskName(String(rec.licensee ?? ""))}`);
    console.log(`       fields sent by the register: ${Object.keys(rec).join(", ")}`);
  });

  console.log(`\nOK — the register answered. Auth accepted: ${accepted}.`);
  process.exit(0);
}
main().catch((e) => { console.error("ping failed:", redact(String(e?.message ?? e))); process.exit(1); });
