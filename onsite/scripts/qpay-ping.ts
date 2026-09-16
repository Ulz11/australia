/**
 * npm run qpay:ping — proves the QPay credentials in .env work, without moving any money.
 * Logs in, refreshes the token, prints what came back (tokens masked). Creates no invoice.
 * Each run asks QPay for a new token — fine by hand, don't put it in a loop.
 */
import path from "node:path";
import { QPAY_BASE_DEFAULT } from "../lib/qpay";

try { process.loadEnvFile(path.resolve(__dirname, "../.env")); } catch { /* env may already be in the shell */ }

const base = (process.env.QPAY_BASE_URL || QPAY_BASE_DEFAULT).replace(/\/+$/, "");
const user = process.env.QPAY_USERNAME, pass = process.env.QPAY_PASSWORD, code = process.env.QPAY_INVOICE_CODE;
const mask = (s?: string) => (s ? `${s.slice(0, 6)}… (${s.length} chars)` : "—");
const when = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : Date.now() + n * 1000;
  return `${v} → ${n > 1e9 ? "timestamp" : "duration"}, ${new Date(ms).toISOString()}`;
};

async function main() {
  console.log(`QPay ping → ${base}`);
  console.log(`  username      ${user ?? "MISSING"}`);
  console.log(`  password      ${pass ? "set" : "MISSING"}`);
  console.log(`  invoice code  ${code ?? "MISSING"}`);
  if (!user || !pass) process.exit(2);

  const t0 = Date.now();
  const res = await fetch(`${base}/auth/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"), Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.text();
  console.log(`\n1. POST /auth/token   HTTP ${res.status}  ${Date.now() - t0} ms`);
  if (!res.ok) { console.log(`   ${body.slice(0, 300)}`); process.exit(1); }
  const j = JSON.parse(body);
  console.log(`   token_type          ${j.token_type}`);
  console.log(`   access_token        ${mask(j.access_token)}`);
  console.log(`   expires_in          ${when(j.expires_in)}`);
  console.log(`   refresh_token       ${mask(j.refresh_token)}`);
  console.log(`   refresh_expires_in  ${when(j.refresh_expires_in)}`);
  console.log(`   fields              ${Object.keys(j).join(", ")}`);

  const t1 = Date.now();
  const ref = await fetch(`${base}/auth/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${j.refresh_token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const rj = await ref.json().catch(() => ({}));
  console.log(`\n2. POST /auth/refresh HTTP ${ref.status}  ${Date.now() - t1} ms  new access_token ${mask(rj.access_token)}`);

  console.log(ref.ok ? "\nOK — QPay accepted these credentials." : "\nLogin works, refresh did not.");
  process.exit(ref.ok ? 0 : 1);
}
main().catch((e) => { console.error("ping failed:", e?.message ?? e); process.exit(1); });
