"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "@/lib/nav";
import { sql } from "@/lib/db";
import { requireRole, createSession } from "@/lib/session";
import { fmtDay, todayIso, addDays } from "@/lib/util";
import { bookWorker, recomputeTickets } from "@/lib/booking";
import { sendAlertsSoon } from "@/lib/alerts";
import { isUuid, isDay, num, isLatLng } from "@/lib/validate";
import { pinFor } from "@/lib/place";

export async function setAvailability(day: string, status: "free" | "busy") {
  const u = await requireRole("worker");
  if (!isDay(day) || !["free", "busy"].includes(status)) return;
  await sql`INSERT INTO availability (worker_id, day, status) VALUES (${u.id}, ${day}, ${status})
            ON CONFLICT (worker_id, day) DO UPDATE SET status = EXCLUDED.status`;
  revalidatePath("/worker");
}

/** Recurring pattern: mark weekdays (0=Sun..6=Sat) free for the next N weeks. */
export async function setPattern(form: FormData) {
  const u = await requireRole("worker");
  const dows = form.getAll("dow").map(Number);
  const weeks = 8;
  const rows: { worker_id: string; day: string; status: string }[] = [];
  const start = todayIso();                     // site-local today, not UTC
  for (let i = 0; i < weeks * 7; i++) {
    const day = addDays(start, i);
    const dow = new Date(day + "T00:00:00Z").getUTCDay();
    rows.push({ worker_id: u.id, day, status: dows.includes(dow) ? "free" : "busy" });
  }
  await sql`INSERT INTO availability ${sql(rows, "worker_id", "day", "status")} ON CONFLICT (worker_id, day) DO UPDATE SET status = EXCLUDED.status`;
  revalidatePath("/worker");
}

export async function takeShift(shiftId: string) {
  const u = await requireRole("worker");
  if (!isUuid(shiftId)) return { error: "This shift is gone." };
  // Cheap gates first (tickets, blocks) — the booking itself is a locked transaction.
  const [g] = await sql`
    SELECT ARRAY(SELECT t FROM unnest(s.tickets_required) t WHERE NOT (t = ANY(w.tickets))) AS missing,
      EXISTS (SELECT 1 FROM blocks bl WHERE bl.boss_id = s.boss_id AND bl.worker_id = w.user_id) AS blocked,
      s.boss_id
    FROM shifts s, workers w WHERE s.id = ${shiftId} AND w.user_id = ${u.id}`;
  if (!g) return { error: "This shift is gone." };
  if (g.missing.length) return { error: `You need: ${g.missing.join(", ")}` };
  if (g.blocked) return { error: "Not available to you." };

  const r = await bookWorker({ shiftId, workerId: u.id, workerName: u.name!, via: "match",
    notify: { userId: g.boss_id, kind: "booking", body: (day) => `${u.name} took your ${day} shift.` } });
  if (!r.ok) return { error: r.error };
  redirect("/worker/shift");
}

export async function cancelBooking(bookingId: string) {
  const u = await requireRole("worker");
  if (!isUuid(bookingId)) redirect("/worker");
  const [b] = await sql`
    WITH b AS (
      UPDATE bookings SET status = 'cancelled' WHERE id = ${bookingId} AND worker_id = ${u.id} AND status = 'accepted' RETURNING shift_id
    ), o AS (UPDATE shifts SET status = 'open' WHERE id IN (SELECT shift_id FROM b) AND status = 'filled')
    INSERT INTO notifications (user_id, shift_id, kind, body)
    SELECT s.boss_id, b.shift_id, 'cancelled', ${u.name} || ' pulled out of ' || to_char(s.day, 'Dy DD Mon') || '. Matching is running again.'
    FROM b JOIN shifts s ON s.id = b.shift_id RETURNING shift_id`;
  if (b) {
    sendAlertsSoon();
    const { runMatchingRound } = await import("@/lib/matching");
    await runMatchingRound(b.shift_id);
  }
  redirect("/worker");
}

export async function clockIn(bookingId: string, lat: number | null, lng: number | null) {
  const u = await requireRole("worker");
  if (!isUuid(bookingId)) return { ok: false };
  const hasPos = lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng);
  const [b] = await sql`
    UPDATE bookings b SET status = 'clocked_in', clock_in_at = now(),
      clock_in_dist_m = ${hasPos ? sql`ST_Distance(p.location, ST_SetSRID(ST_MakePoint(${lng}, ${lat}),4326)::geography)::int` : null}
    FROM shifts s JOIN projects p ON p.id = s.project_id
    WHERE b.id = ${bookingId} AND b.worker_id = ${u.id} AND s.id = b.shift_id AND b.status = 'accepted'
      AND s.day = CURRENT_DATE                       -- clock in on the day, not a week early
    RETURNING b.id`;
  revalidatePath("/worker/shift");
  return { ok: !!b, error: b ? undefined : "You can only clock in on the day of the shift." };
}

export async function clockOut(bookingId: string) {
  const u = await requireRole("worker");
  if (!isUuid(bookingId)) return { ok: false };
  // hours = time since clock-in, rounded to the nearest half hour, at least 0.5 — computed in SQL so it's one round trip
  const [b] = await sql`
    WITH u AS (
      UPDATE bookings SET status = 'clocked_out', clock_out_at = now(),
        hours_worked = GREATEST(0.5, ROUND(EXTRACT(EPOCH FROM (now() - clock_in_at)) / 1800) / 2)
      WHERE id = ${bookingId} AND worker_id = ${u.id} AND status = 'clocked_in'
      RETURNING shift_id, hours_worked
    )
    INSERT INTO notifications (user_id, shift_id, kind, body)
    SELECT s.boss_id, u.shift_id, 'approve', ${u.name} || ' clocked out: ' || u.hours_worked || 'h on ' || to_char(s.day, 'Dy DD Mon') || '. Approve hours.'
    FROM u JOIN shifts s ON s.id = u.shift_id RETURNING shift_id`;
  if (b) sendAlertsSoon();
  revalidatePath("/worker/shift");
  return { ok: !!b };
}

export async function disagree(bookingId: string) {
  const u = await requireRole("worker");
  if (!isUuid(bookingId)) return;
  await sql`
    WITH b AS (UPDATE bookings SET disputed_at = now() WHERE id = ${bookingId} AND worker_id = ${u.id} AND status IN ('approved','paid') RETURNING shift_id)
    INSERT INTO notifications (user_id, shift_id, kind, body)
    SELECT s.boss_id, b.shift_id, 'dispute', ${u.name} || ' disagrees with the approved hours for ' || to_char(s.day, 'Dy DD Mon') || '. Give them a call.'
    FROM b JOIN shifts s ON s.id = b.shift_id`;
  sendAlertsSoon();
  revalidatePath("/worker/me");
}

export async function updateMe(form: FormData) {
  const u = await requireRole("worker");
  const radius = num(form.get("radius_km"), 5, 100, 25);
  const visa = String(form.get("visa_type") || "").slice(0, 40) || null;
  const [lng, lat] = pinFor(Number(form.get("lng")), Number(form.get("lat")), "suburb");   // a home is kept to ~1 km, whatever the form sent
  const label = String(form.get("home_label") || "").slice(0, 200);
  const hasPin = isLatLng(lat, lng);
  // Cards live in the licences table now — this form must never touch workers.tickets.
  await Promise.all([sql`UPDATE workers SET radius_km = ${radius}, visa_type = ${visa},
     home = ${hasPin ? sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}),4326)::geography` : sql`home`}, home_label = ${hasPin ? label : sql`home_label`}
     WHERE user_id = ${u.id}`,
    sql`UPDATE users SET name = ${String(form.get("name") || u.name).trim().slice(0, 80) || u.name} WHERE id = ${u.id}`]);
  await createSession(u.id); // name lives in the cookie
  revalidatePath("/worker/me");
}

export async function markRead() {
  const u = await requireRole("worker");
  await sql`UPDATE notifications SET read_at = now() WHERE user_id = ${u.id} AND read_at IS NULL`;
}

export async function workerLogCall(toUser: string, bookingId?: string) {
  const u = await requireRole("worker");
  if (!isUuid(toUser) || (bookingId && !isUuid(bookingId))) return;
  await sql`INSERT INTO calls (from_user, to_user, booking_id) VALUES (${u.id}, ${toUser}, ${bookingId ?? null})`;
}

// ───────────────────────────────────────────────── profile, licences, offers
import { checkOffer } from "@/lib/rules";
import { type LicenceKind } from "@/lib/verify";
import { checkLicence } from "@/lib/licenceCheck";
import { RECHECK_FIRST_MIN } from "@/lib/licenceRecheck";
import { hit, LICENCE_SAVES_PER_HOUR } from "@/lib/ratelimit";

import { PHOTO_MAX_BYTES, TRADES, LANGUAGES } from "@/lib/profile";

/** The proper profile: photo, experience, trades, languages, a line about yourself. */
export async function saveProfile(form: FormData) {
  const u = await requireRole("worker");
  const photo = String(form.get("photo") || "");
  const years = num(form.get("years_exp"), 0, 60, 0);
  const trades = form.getAll("trades").map(String).filter((t) => TRADES.includes(t)).slice(0, 8);
  const languages = form.getAll("languages").map(String).filter((l) => LANGUAGES.includes(l)).slice(0, 6);
  const about = String(form.get("about") || "").trim().slice(0, 400);
  const keepPhoto = photo === "" || !photo.startsWith("data:image/");
  if (photo && photo.length > PHOTO_MAX_BYTES) return { error: "That photo is too big — take a new one." };
  const name = String(form.get("name") || "").trim().slice(0, 80) || u.name!;

  await Promise.all([
    sql`UPDATE workers SET photo = ${keepPhoto ? sql`photo` : photo},
        years_exp = ${years}, trades = ${trades}, languages = ${languages}, about = ${about}
      WHERE user_id = ${u.id}`,
    sql`UPDATE users SET name = ${name} WHERE id = ${u.id}`,
  ]);
  if (name !== u.name) await createSession(u.id);   // name lives in the cookie
  revalidatePath("/worker/me");
  return { ok: true };
}

export async function removePhoto() {
  const u = await requireRole("worker");
  await sql`UPDATE workers SET photo = NULL WHERE user_id = ${u.id}`;
  revalidatePath("/worker/me");
}

/**
 * Save a card and check it against the register where that's possible.
 * workers.tickets stays in step so the matching query keeps working.
 */
export async function saveLicence(form: FormData) {
  const u = await requireRole("worker");
  const kind = String(form.get("kind")) as LicenceKind;
  if (!["WC", "LF", "WP", "DG", "SB"].includes(kind)) return { error: "Unknown card type." };
  const number = String(form.get("number") || "").trim().slice(0, 40);
  const issued_state = String(form.get("issued_state") || "NSW");
  const expRaw = String(form.get("expires_on") || "");
  const expires_on = isDay(expRaw) ? expRaw : null;
  if (!["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"].includes(issued_state)) return { error: "Pick the state on the card." };
  const holder_name = String(form.get("holder_name") || u.name || "").trim().slice(0, 100);
  if (!number) return { error: "Type the number printed on the card." };

  // Cards change about twice a year, not twice a minute. The cap is really about the register:
  // without it one signed-in account can walk card numbers all day, and every walk is a live lookup.
  // It is spent only once the form is otherwise good, so a typo doesn't cost a worker their allowance.
  if (!(await hit(`licence-save:${u.id}`, LICENCE_SAVES_PER_HOUR, 3600)))
    return { error: "Too many card changes for now — try again in an hour." };

  const result = await checkLicence({ kind, number, issued_state, holder_name, expires_on });
  // The re-check queue: only a check that was due and gave no answer goes on it (checkLicence says so
  // explicitly). Any other save — a real answer, or a card no register can check — takes the card off
  // it, and every save starts the attempt count again.
  await sql`
    WITH l AS (
      INSERT INTO licences (worker_id, kind, number, issued_state, expires_on, holder_name, status, checked_at, checked_via, check_note, recheck_at, check_attempts)
      VALUES (${u.id}, ${kind}, ${number}, ${issued_state}, ${result.expires_on ?? expires_on}, ${holder_name},
              ${result.status}, ${result.status === "unchecked" ? null : sql`now()`}, ${result.via}, ${result.note},
              ${result.retryable ? sql`now() + make_interval(mins => ${RECHECK_FIRST_MIN})` : null}, 0)
      ON CONFLICT (worker_id, kind) DO UPDATE SET
        number = EXCLUDED.number, issued_state = EXCLUDED.issued_state, expires_on = EXCLUDED.expires_on,
        holder_name = EXCLUDED.holder_name, status = EXCLUDED.status, checked_at = EXCLUDED.checked_at,
        checked_via = EXCLUDED.checked_via, check_note = EXCLUDED.check_note,
        recheck_at = EXCLUDED.recheck_at, check_attempts = EXCLUDED.check_attempts
      RETURNING worker_id
    ) SELECT worker_id FROM l`;
  await recomputeTickets(u.id);
  revalidatePath("/worker/me");
  return { ok: true, status: result.status, note: result.note };
}

export async function removeLicence(kind: string) {
  const u = await requireRole("worker");
  if (!["WC", "LF", "WP", "DG", "SB"].includes(kind)) return;
  await sql`DELETE FROM licences WHERE worker_id = ${u.id} AND kind = ${kind}`;
  await recomputeTickets(u.id);
  revalidatePath("/worker/me");
}

/** A deal request: ask for a different rate, hours or start, with a note. */
export async function makeOffer(form: FormData) {
  const u = await requireRole("worker");
  const shiftId = String(form.get("shift_id"));
  if (!isUuid(shiftId)) return { error: "This shift is gone." };
  const [s] = await sql`
    SELECT s.rate, s.hours, s.start_time::text, s.allow_offers, s.spots, s.status, p.name AS site, s.day, s.boss_id,
      (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled'))::int AS taken,
      (SELECT b.status FROM bookings b WHERE b.shift_id = s.id AND b.worker_id = ${u.id}) AS mine,
      (s.day < CURRENT_DATE) AS past
    FROM shifts s JOIN projects p ON p.id = s.project_id WHERE s.id = ${shiftId}`;
  if (!s || s.past) return { error: "This shift is gone." };
  if (s.mine && s.mine !== "cancelled") return { error: s.mine === "removed" ? "The boss took you off this shift." : "You're already on this shift." };

  const check = checkOffer(s as never, {
    rate: form.get("rate") ? Number(form.get("rate")) : null,
    hours: form.get("hours") ? Number(form.get("hours")) : null,
    start_time: String(form.get("start_time") || "") || null,
    message: String(form.get("message") || ""),
  });
  if (!check.ok) return { error: check.error };

  const summary = check.changes.length ? check.changes.join(", ") : "a question";
  await sql`
    WITH o AS (
      INSERT INTO offers (shift_id, worker_id, from_role, rate, hours, start_time, message)
      VALUES (${shiftId}, ${u.id}, 'worker', ${check.clean.rate}, ${check.clean.hours}, ${check.clean.start_time}, ${check.clean.message})
      ON CONFLICT (shift_id, worker_id) WHERE status = 'pending' DO UPDATE SET
        rate = EXCLUDED.rate, hours = EXCLUDED.hours, start_time = EXCLUDED.start_time,
        message = EXCLUDED.message, created_at = now()
      RETURNING id
    )
    INSERT INTO notifications (user_id, shift_id, kind, body)
    SELECT ${s.boss_id}, ${shiftId}, 'offer', ${`${u.name} wants to talk about ${fmtDay(s.day)} at ${s.site}: ${summary}`} FROM o`;
  sendAlertsSoon();
  revalidatePath("/worker/offers");
  return { ok: true };
}

export async function withdrawOffer(offerId: string) {
  const u = await requireRole("worker");
  if (!isUuid(offerId)) return;
  await sql`UPDATE offers SET status = 'withdrawn', responded_at = now() WHERE id = ${offerId} AND worker_id = ${u.id} AND status = 'pending'`;
  revalidatePath("/worker/offers");
}

/** Worker accepts the boss's counter — books them on the countered terms. */
export async function acceptCounter(offerId: string) {
  const u = await requireRole("worker");
  if (!isUuid(offerId)) return { error: "That offer is no longer open." };
  const [o] = await sql`
    SELECT o.shift_id, o.rate, o.hours, o.start_time::text AS start_time, s.boss_id
    FROM offers o JOIN shifts s ON s.id = o.shift_id
    WHERE o.id = ${offerId} AND o.worker_id = ${u.id} AND o.from_role = 'boss' AND o.status = 'pending'`;
  if (!o) return { error: "That offer is no longer open." };
  const r = await bookWorker({ shiftId: o.shift_id, workerId: u.id, workerName: u.name!, via: "offer",
    agreed: { rate: o.rate == null ? null : Number(o.rate), hours: o.hours == null ? null : Number(o.hours), start_time: o.start_time ? o.start_time.slice(0, 5) : null },
    notify: { userId: o.boss_id, kind: "booking", body: (day, site) => `${u.name} accepted your offer for ${day} at ${site}.` } });
  if (!r.ok) return { error: r.error };
  await sql`UPDATE offers SET status = 'accepted', responded_at = now() WHERE id = ${offerId}`;
  redirect("/worker/shift");
}
