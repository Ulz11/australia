"use server";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { createSession, destroySession, getUser } from "@/lib/session";
import { normalisePhone, sendSms } from "@/lib/sms";
import { isLatLng } from "@/lib/validate";

export type AuthState = { step: "phone" | "code"; phone?: string; error?: string; devCode?: string };

export async function requestCode(_prev: AuthState, form: FormData): Promise<AuthState> {
  const phone = normalisePhone(String(form.get("phone") || ""));
  if (!phone) return { step: "phone", error: "Enter an Australian mobile, e.g. 0412 345 678" };
  // Throttle: a code costs money to send. One a minute, five an hour, per number.
  const [prev] = await sql`SELECT last_sent_at, sends, window_start FROM otp_codes WHERE phone = ${phone}`;
  if (prev?.last_sent_at && Date.now() - new Date(prev.last_sent_at).getTime() < 60_000)
    return { step: "phone", error: "We just sent one. Give it a minute, then try again." };
  const windowOpen = prev?.window_start && Date.now() - new Date(prev.window_start).getTime() < 3_600_000;
  if (windowOpen && prev.sends >= 5)
    return { step: "phone", error: "Too many codes for this number. Try again in an hour." };
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await sql`INSERT INTO otp_codes (phone, code, expires_at, attempts, last_sent_at, sends, window_start)
            VALUES (${phone}, ${code}, now() + interval '10 minutes', 0, now(), 1, now())
            ON CONFLICT (phone) DO UPDATE SET code = EXCLUDED.code, expires_at = EXCLUDED.expires_at, attempts = 0,
              last_sent_at = now(),
              sends = CASE WHEN ${!!windowOpen} THEN otp_codes.sends + 1 ELSE 1 END,
              window_start = CASE WHEN ${!!windowOpen} THEN otp_codes.window_start ELSE now() END`;
  const { sent } = await sendSms(phone, `OnSite code: ${code}`);
  return { step: "code", phone, devCode: !sent && process.env.DEV_SHOW_OTP === "1" ? code : undefined };
}

export async function authAction(prev: AuthState, form: FormData): Promise<AuthState> {
  if (String(form.get("step")) === "phone") return requestCode(prev, form);
  return verifyCode(prev, form);
}

export async function verifyCode(prev: AuthState, form: FormData): Promise<AuthState> {
  const phone = prev.phone || String(form.get("phone") || "");
  const code = String(form.get("code") || "").trim();
  const invite = String(form.get("invite") || "");
  const [row] = await sql`SELECT code, expires_at, attempts FROM otp_codes WHERE phone = ${phone}`;
  if (!row || row.attempts >= 5 || new Date(row.expires_at) < new Date()) return { step: "phone", error: "Code expired. Try again." };
  if (row.code !== code) {
    await sql`UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ${phone}`;
    return { ...prev, error: "Wrong code" };
  }
  await sql`DELETE FROM otp_codes WHERE phone = ${phone}`;
  const [user] = await sql`INSERT INTO users (phone) VALUES (${phone}) ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING id, role, name`;
  await createSession(user.id);
  if (!user.role || !user.name) redirect(invite ? `/onboarding?invite=${encodeURIComponent(invite)}` : "/onboarding");
  redirect(user.role === "boss" ? "/boss" : "/worker");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}

export async function completeOnboarding(form: FormData) {
  const u = await getUser();
  if (!u) redirect("/login");
  if (u.role && u.name) redirect("/");          // already set up — no switching sides
  const role = String(form.get("role"));
  const name = String(form.get("name") || "").trim();
  if (!name || !["boss", "worker"].includes(role)) return;
  await sql`UPDATE users SET name = ${name}, role = ${role} WHERE id = ${u.id}`;
  if (role === "boss") {
    const company = String(form.get("company") || name).trim();
    const abn = String(form.get("abn") || "").replace(/\s/g, "") || null;
    await sql`INSERT INTO bosses (user_id, company, abn) VALUES (${u.id}, ${company}, ${abn}) ON CONFLICT (user_id) DO UPDATE SET company = EXCLUDED.company, abn = EXCLUDED.abn`;
    await createSession(u.id);
    redirect("/boss");
  } else {
    const lat = Number(form.get("lat")), lng = Number(form.get("lng"));
    const label = String(form.get("home_label") || "");
    const invite = String(form.get("invite") || "").trim().toUpperCase();
    const inviter = invite ? (await sql`SELECT user_id FROM workers WHERE invite_code = ${invite}`)[0]?.user_id ?? null : null;
    const hasPin = isLatLng(lat, lng);
    // invite codes are short, so a clash is possible — try a few
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      try {
        await sql`INSERT INTO workers (user_id, home, home_label, invite_code, invited_by, tickets)
                  VALUES (${u.id}, ${hasPin ? sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}),4326)::geography` : null}, ${label}, ${code}, ${inviter}, '{WC}')
                  ON CONFLICT (user_id) DO UPDATE SET home = EXCLUDED.home, home_label = EXCLUDED.home_label`;
        break;
      } catch (e: unknown) {
        if (attempt === 4 || !String((e as Error).message).includes("invite_code")) throw e;
      }
    }
    await createSession(u.id);
    redirect("/worker");
  }
}
