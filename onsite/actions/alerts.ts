"use server";
import { cookies } from "next/headers";
import { sql } from "@/lib/db";
import { getUser } from "@/lib/session";
import { endpointOk, sendAlertsSoon, PUSH_COOKIE } from "@/lib/alerts";
import { hit } from "@/lib/ratelimit";

type Incoming = { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
const b64url = (v: unknown, bytes: number) => typeof v === "string" && /^[A-Za-z0-9_-]+={0,2}$/.test(v) && Buffer.from(v, "base64url").length === bytes;

/** This phone wants alerts. A device follows whoever last signed in on it. */
export async function savePushSubscription(sub: Incoming, userAgent?: string): Promise<{ ok: boolean; error?: string }> {
  const u = await getUser();
  if (!u?.role) return { ok: false, error: "Sign in first." };
  const endpoint = String(sub?.endpoint ?? "");
  if (!endpointOk(endpoint) || !b64url(sub?.keys?.p256dh, 65) || !b64url(sub?.keys?.auth, 16))
    return { ok: false, error: "This browser's alert service isn't supported." };
  await sql`
    INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent)
    VALUES (${endpoint}, ${u.id}, ${sub.keys!.p256dh as string}, ${sub.keys!.auth as string}, ${String(userAgent ?? "").slice(0, 200) || null})
    ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
      user_agent = EXCLUDED.user_agent, failures = 0`;
  // Five phones per person is plenty; keep the newest.
  await sql`DELETE FROM push_subscriptions WHERE user_id = ${u.id} AND endpoint NOT IN (
              SELECT endpoint FROM push_subscriptions WHERE user_id = ${u.id} ORDER BY created_at DESC LIMIT 5)`;
  (await cookies()).set(PUSH_COOKIE, endpoint, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 24 * 365, path: "/" });
  return { ok: true };
}

export async function removePushSubscription(endpoint: string) {
  const u = await getUser();
  if (!u) return;
  await sql`DELETE FROM push_subscriptions WHERE endpoint = ${String(endpoint)} AND user_id = ${u.id}`;
  (await cookies()).delete(PUSH_COOKIE);
}

/** "Send me a test" — so people see what an alert looks like before a real one matters. */
export async function sendTestAlert(): Promise<{ ok: boolean; error?: string }> {
  const u = await getUser();
  if (!u?.role) return { ok: false, error: "Sign in first." };
  if (!(await hit(`alert-test:${u.id}`, 5, 3600))) return { ok: false, error: "That's enough tests for now." };
  await sql`INSERT INTO notifications (user_id, kind, body, read_at)
            VALUES (${u.id}, 'test', ${u.role === "worker" ? "This is how a shift near you will show up." : "This is how it'll show when a worker takes or finishes a shift."}, now())`;
  sendAlertsSoon();
  return { ok: true };
}
