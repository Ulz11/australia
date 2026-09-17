import { sql } from "@/lib/db";
import { verifyOtp } from "@/lib/otpVerify";
import { signSession, tokenExpiresAt } from "@/lib/session";
import { clientIp } from "@/lib/ratelimit";
import { normalisePhone } from "@/lib/sms";
import { body, fail, json, preflight } from "@/lib/apiJson";

/**
 * Trade a code for a bearer token. The web form redirects at this point; a phone needs
 * the token handed back instead, so this returns it along with where to send the worker.
 */
export async function POST(req: Request) {
  const b = await body<{ phone?: string; code?: string; invite?: string }>(req);
  const phone = normalisePhone(String(b?.phone ?? ""));
  const code = String(b?.code ?? "").trim();
  if (!phone || !code) return fail(req, 400, "Wrong code");

  const r = await verifyOtp(phone, code, await clientIp());
  if (!r.ok) return fail(req, r.step === "phone" ? 410 : 401, r.error);

  const token = await signSession(r.userId, { via: "mobile", label: "The OnSite app" });
  if (!token) return fail(req, 500, "Something went wrong. Try again.");

  // The invite is only meaningful for someone who hasn't finished onboarding yet.
  const invite = String(b?.invite ?? "").trim().toUpperCase();
  const [u] = await sql`SELECT id, phone, name, role, lang FROM users WHERE id = ${r.userId}`;
  const next = !r.role || !r.name ? "onboarding" : r.role === "boss" ? "boss" : "worker";

  return json(req, {
    token,
    expires_at: tokenExpiresAt(token).toISOString(),                  // a year; renew at POST /api/v1/auth/refresh
    user: { id: u.id, phone: u.phone, name: u.name, role: u.role, lang: u.lang },
    next,
    invite: next === "onboarding" && invite ? invite : null,
  });
}

export const OPTIONS = preflight;
