"use server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { sql } from "@/lib/db";
import { createSession, destroySession, getUser, signedInPath, FRAME_COOKIES, SESSION_COOKIE } from "@/lib/session";
import { revalidatePath } from "@/lib/nav";
import { normalisePhone, sendSms } from "@/lib/sms";
import { isLatLng, isUuid } from "@/lib/validate";
import { pinFor } from "@/lib/place";
import { OTP, hashCode, inviteCode, newCode, phoneAllowed } from "@/lib/otp";
import { clientIp, hit, refund } from "@/lib/ratelimit";
import { verifyOtp } from "@/lib/otpVerify";
import { PUSH_COOKIE } from "@/lib/alerts";
import { devShowOtpOn } from "@/lib/flags";
import { BETA_REFUSAL, betaInviteOnly, mayRequestCode } from "@/lib/beta";
import { PRIVACY_VERSION } from "@/lib/privacy";
import { addMonths, trialEndFrom } from "@/lib/subscription";
import { offerPasskeyNextScreen } from "@/lib/passkeys";

/** `refused: "invite_only"` marks the closed-beta refusal, so the mobile API can answer 403 instead of 429. */
export type AuthState = { step: "phone" | "code"; phone?: string; error?: string; devCode?: string; refused?: "invite_only" };

export async function requestCode(_prev: AuthState, form: FormData, opts?: { ip?: string | null }): Promise<AuthState> {
  const phone = normalisePhone(String(form.get("phone") || ""));
  if (!phone || !phoneAllowed(phone)) return { step: "phone", error: "Enter an Australian mobile, e.g. 0412 345 678" };
  // A code costs money to send. Limits per connection and across the app first, then per number.
  // Budgets are counted atomically (a burst can't slip past them) and handed back on every path that
  // doesn't end in a text — so a refusal costs the person nothing.
  const ip = process.env.VITEST && opts && "ip" in opts ? opts.ip : await clientIp();   // opts is for tests; the real address always wins
  const charged: [string, number][] = [];
  const spend = async (key: string, limit: number, windowSeconds: number) => {
    const ok = await hit(key, limit, windowSeconds);
    if (ok) charged.push([key, windowSeconds]);
    else await refund(key, windowSeconds);                  // the one that refused paid for nothing either
    return ok;
  };
  const handBack = () => Promise.all(charged.map(([k, w]) => refund(k, w)));
  if (ip && !(await spend(`otp-send:ip:${ip}`, OTP.sendsPerIpPerHour, 3600)))
    return { step: "phone", error: "Too many codes from this connection. Try again in an hour." };

  // Closed beta (lib/beta.ts): a number that is neither invited nor an account gets one sentence and nothing
  // else — no text, no code row, nothing from the app-wide or per-number budgets. The connection's charge above
  // is deliberately NOT handed back: otherwise the gate would answer "is this number invited?" for free.
  if (betaInviteOnly()) {
    let listed: boolean;
    try {
      listed = await mayRequestCode(phone);
    } catch (e) {
      await handBack();                                     // a database hiccup mustn't leave the caller charged
      throw e;
    }
    if (!listed) return { step: "phone", error: BETA_REFUSAL, refused: "invite_only" };
  }

  // Check the app-wide ceiling BEFORE touching this number's row: a refusal here must not rotate the code
  // they're holding or spend their 5-an-hour budget. The counter itself only moves when a code really goes out.
  if (!(await spend("otp-send:all", OTP.sendsPerHourAll(), 3600))) {
    console.error("login codes paused — OTP_SENDS_PER_HOUR reached");
    await handBack();
    return { step: "phone", error: "We're sending a lot of codes right now. Try again in a few minutes." };
  }

  try {
    // One statement decides and records the send, so ten taps at once still send one code.
    // Wrong guesses carry over to the new code until the hour is up — asking again doesn't buy more guesses.
    const code = newCode();
    const fresh = sql`(o.window_start IS NULL OR o.window_start < now() - interval '1 hour')`;
    const [sent] = await sql`
      INSERT INTO otp_codes AS o (phone, code, expires_at, attempts, last_sent_at, sends, window_start)
      VALUES (${phone}, ${hashCode(phone, code)}, now() + make_interval(mins => ${OTP.ttlMinutes}), 0, now(), 1, now())
      ON CONFLICT (phone) DO UPDATE SET
        code = EXCLUDED.code, expires_at = EXCLUDED.expires_at, last_sent_at = now(),
        sends        = CASE WHEN ${fresh} THEN 1     ELSE o.sends + 1 END,
        attempts     = CASE WHEN ${fresh} THEN 0     ELSE o.attempts END,
        window_start = CASE WHEN ${fresh} THEN now() ELSE o.window_start END
      WHERE (o.last_sent_at IS NULL OR o.last_sent_at < now() - make_interval(secs => ${OTP.resendSeconds}))
        AND (${fresh} OR (o.sends < ${OTP.sendsPerHour} AND o.attempts < ${OTP.wrongPerHour}))
      RETURNING o.sends`;
    if (!sent) {
      await handBack();
      const [o] = await sql`SELECT last_sent_at > now() - make_interval(secs => ${OTP.resendSeconds}) AS recent, attempts FROM otp_codes WHERE phone = ${phone}`;
      return { step: "phone", error: o?.recent ? "We just sent one. Give it a minute, then try again."
        : o?.attempts >= OTP.wrongPerHour ? "Too many wrong codes for this number. Try again in an hour."
        : "Too many codes for this number. Try again in an hour." };
    }
    const { sent: texted, stub } = await sendSms(phone, `OnSite code: ${code}`);
    const devCode = !texted && devShowOtpOn() ? code : undefined;
    if (!texted && !stub && !devCode) {
      // The provider refused it and nothing is showing the code on screen: say so instead of sending them to a
      // "type the code we texted you" screen for a text that never left, and hand the budgets back.
      await handBack();
      return { step: "phone", error: "We couldn't send a code right now. Try again shortly." };
    }
    return { step: "code", phone, devCode };
  } catch (e) {
    await handBack();                                       // a database hiccup mustn't leave the caller charged
    throw e;
  }

}

export async function authAction(prev: AuthState, form: FormData): Promise<AuthState> {
  if (String(form.get("step")) === "phone") return requestCode(prev, form);
  return verifyCode(prev, form);
}

export async function verifyCode(prev: AuthState, form: FormData, opts?: { ip?: string | null }): Promise<AuthState> {
  const phone = prev.phone || String(form.get("phone") || "");
  const code = String(form.get("code") || "").trim();
  const invite = String(form.get("invite") || "");
  const ip = process.env.VITEST && opts && "ip" in opts ? opts.ip : await clientIp();   // tests only, as above
  const r = await verifyOtp(phone, code, ip ?? null);
  if (!r.ok) return r.step === "phone" ? { step: "phone", error: r.error } : { ...prev, error: r.error };
  await createSession(r.userId, { via: "code" });
  await offerPasskeyNextScreen();                           // "Sign in with Face ID next time?" on the next boss or worker screen
  redirect(signedInPath(r, invite));                        // actions/passkeys.ts signs in through the same two lines
}

export async function logout() {
  // Alerts follow the person, not the phone: a shared handset must stop buzzing for whoever just left.
  const u = await getUser();
  const jar = await cookies();
  const endpoint = jar.get(PUSH_COOKIE)?.value;
  if (u && endpoint) await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint} AND user_id = ${u.id}`;
  jar.delete(PUSH_COOKIE);
  // The control room's per-frame cookies are sessions too, wherever they came from.
  for (const [name, path] of [[FRAME_COOKIES.boss, "/boss"], [FRAME_COOKIES.worker, "/worker"]]) jar.delete({ name, path });
  await destroySession();
  redirect("/login");
}

/**
 * Me → "Where you're signed in" → Sign out. Only ever one of the caller's own sessions; ending the one they
 * are holding sends them to the login screen, because it just stopped working.
 */
export async function signOutSession(id: string) {
  const u = await getUser();
  if (!u || !isUuid(id)) return;
  await sql`UPDATE sessions SET revoked_at = now() WHERE id = ${id} AND user_id = ${u.id} AND revoked_at IS NULL`;
  if (id === u.sid) {
    (await cookies()).delete(SESSION_COOKIE);
    redirect("/login");
  }
  revalidatePath("/boss/me/settings");
  revalidatePath("/worker/me/settings");
}

/** The one tap for a lost or lent phone: every other sign-in ends, this one stays. */
export async function signOutOtherSessions() {
  const u = await getUser();
  if (!u) return;
  await sql`UPDATE sessions SET revoked_at = now()
            WHERE user_id = ${u.id} AND revoked_at IS NULL AND id IS DISTINCT FROM ${isUuid(u.sid) ? u.sid : null}::uuid`;
  revalidatePath("/boss/me/settings");
  revalidatePath("/worker/me/settings");
}

export async function completeOnboarding(form: FormData) {
  const u = await getUser();
  if (!u) redirect("/login");
  if (u.role && u.name) redirect("/");          // already set up — no switching sides
  const role = String(form.get("role"));
  const name = String(form.get("name") || "").trim();
  if (!name || !["boss", "worker"].includes(role)) return;
  // Consent is checked here, not only by the checkbox's `required`: a form posted without it sets nothing up.
  if (form.get("privacy") !== "yes") {
    const invite = String(form.get("invite") || "").trim();
    redirect(`/onboarding?err=privacy${invite ? `&invite=${encodeURIComponent(invite)}` : ""}`);
  }
  await sql`UPDATE users SET name = ${name}, role = ${role}, privacy_accepted_at = now(), privacy_version = ${PRIVACY_VERSION} WHERE id = ${u.id}`;
  if (role === "boss") {
    const company = String(form.get("company") || name).trim();
    const abn = String(form.get("abn") || "").replace(/\s/g, "") || null;
    const trialEnd = trialEndFrom(new Date());
    // The free trial starts the moment the account becomes a boss, and the subscription starts by
    // itself when it runs out — both said plainly under the Boss choice on this screen.
    await sql`INSERT INTO bosses (user_id, company, abn, trial_ends_at, subscription_status, period_started_at, period_ends_at)
              VALUES (${u.id}, ${company}, ${abn}, ${trialEnd}, 'trialing', ${trialEnd}, ${addMonths(trialEnd, 1)})
              ON CONFLICT (user_id) DO UPDATE SET company = EXCLUDED.company, abn = EXCLUDED.abn`;
    await createSession(u.id);
    await offerPasskeyNextScreen();
    redirect("/boss");
  } else {
    const [lng, lat] = pinFor(Number(form.get("lng")), Number(form.get("lat")), "suburb");   // a home is kept to ~1 km, whatever the form sent
    const label = String(form.get("home_label") || "");
    const invite = String(form.get("invite") || "").trim().toUpperCase();
    const inviter = invite ? (await sql`SELECT user_id FROM workers WHERE invite_code = ${invite}`)[0]?.user_id ?? null : null;
    const hasPin = isLatLng(lat, lng);
    // invite codes are short, so a clash is possible — try a few
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = inviteCode();
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
    await offerPasskeyNextScreen();
    redirect("/worker");
  }
}
