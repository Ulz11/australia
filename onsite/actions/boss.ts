"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "@/lib/nav";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { clampRate, normaliseTickets, payForShift, checkOffer } from "@/lib/rules";
import { runMatchingRound } from "@/lib/matching";
import { fmtDay, todayIso } from "@/lib/util";
import { bookWorker } from "@/lib/booking";
import { isUuid, isDay, isTime, num, isLatLng } from "@/lib/validate";
import { sendAlertsSoon } from "@/lib/alerts";
import { hit, refund, SHIFT_POSTS_PER_HOUR } from "@/lib/ratelimit";
import { hasLines, readPostLines, type PostLine } from "@/lib/posts";
import { randomUUID } from "node:crypto";

export async function createProject(form: FormData) {
  const u = await requireRole("boss");
  const name = String(form.get("name") || "").trim();
  const lat = Number(form.get("lat")), lng = Number(form.get("lng"));
  const address = String(form.get("home_label") || "").slice(0, 200);
  if (!name || name.length > 80 || !isLatLng(lat, lng)) return;
  const [p] = await sql`INSERT INTO projects (boss_id, name, address, location)
    VALUES (${u.id}, ${name}, ${address}, ST_SetSRID(ST_MakePoint(${lng}, ${lat}),4326)::geography) RETURNING id`;
  redirect(`/boss/shifts/new?project=${p.id}`);
}

export async function archiveProject(id: string) {
  const u = await requireRole("boss");
  if (!isUuid(id)) redirect("/boss");
  const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM shifts WHERE project_id = ${id} AND boss_id = ${u.id}
                            AND status IN ('open','filled') AND day >= CURRENT_DATE`;
  if (n > 0) redirect(`/boss/projects/${id}?err=${n}`);   // cancel or finish them first
  await sql`UPDATE projects SET archived = true WHERE id = ${id} AND boss_id = ${u.id}`;
  redirect("/boss");
}

export async function createShift(form: FormData) {
  const u = await requireRole("boss");
  const project_id = String(form.get("project_id"));
  const back = (msg: string) => redirect(`/boss/shifts/new?project=${encodeURIComponent(project_id)}&err=${encodeURIComponent(msg)}`);
  if (!isUuid(project_id)) return redirect("/boss");
  const [p] = await sql`SELECT id FROM projects WHERE id = ${project_id} AND boss_id = ${u.id} AND NOT archived`;
  if (!p) return redirect("/boss");
  const day = String(form.get("day"));
  if (!isDay(day) || day < todayIso()) return back("Pick today or a day coming up.");
  const start_time = String(form.get("start_time") || "06:30");
  if (!isTime(start_time)) return back("That start time doesn't look right.");
  const hours = num(form.get("hours"), 1, 14, 8);
  const spots = Math.round(num(form.get("spots"), 1, 20, 1));
  const role = String(form.get("role") || "General labourer").trim().slice(0, 40) || "General labourer";
  const tickets = normaliseTickets(form.getAll("tickets"));
  const rate = clampRate(form.get("rate"));
  const note = String(form.get("note") || "").trim().slice(0, 120) || null;
  const directRaw = String(form.get("direct_worker_id") || "");
  const direct = isUuid(directRaw) ? directRaw : null;
  // Overtime agreed here, before anyone takes the shift — that's the whole point.
  const ot_mode = ["award", "flat", "custom"].includes(String(form.get("ot_mode"))) ? String(form.get("ot_mode")) : "award";
  const ot_after = num(form.get("ot_after_hours"), 1, 14, 8);
  const ot_mult = ot_mode === "custom" ? num(form.get("ot_multiplier"), 1, 3, 1.5) : null;
  const allow_offers = String(form.get("allow_offers") ?? "1") !== "0";
  // Who's needed. Booking one of your crew is one person, one role, one rate, as it always was. Otherwise the form
  // sends one line per kind of worker ("2 × Carpenter, 1 × Forklift driver"); each line becomes its own shift.
  let lines: PostLine[] = [{ role, spots: direct ? 1 : spots, rate, tickets }];
  if (!direct && hasLines(form)) {
    const read = readPostLines(form);
    if (!read.ok) return back(read.error);
    lines = read.lines;
  }
  // Only a post that would really go ahead spends a slot, one per line — every shift can buzz and text workers.
  const key = `shift-post:${u.id}`;
  if (!(await hit(key, SHIFT_POSTS_PER_HOUR, 3600, lines.length))) {
    await refund(key, 3600, lines.length);   // refused, so it didn't happen: a smaller post may still fit
    return back("You've hit the limit for posting shifts this hour. Try again a bit later.");
  }
  // Every line in one statement, sharing one post_id. created_at steps a microsecond per line so the boss screens
  // list the lines in the order they were written.
  let ids: string[];
  try {
    const rows = await sql<{ id: string; n: number }[]>`
      INSERT INTO shifts (post_id, project_id, boss_id, day, start_time, hours, spots, role, tickets_required, rate, note, direct_worker_id,
        ot_mode, ot_after_hours, ot_multiplier, allow_offers, created_at)
      SELECT ${randomUUID()}::uuid, ${project_id}::uuid, ${u.id}::uuid, ${day}::date, ${start_time}::time, ${hours}::numeric, l.spots, l.role,
        string_to_array(l.tickets, ','), l.rate, ${note}::text, ${direct}::uuid,
        ${ot_mode}::text, ${ot_after}::numeric, ${ot_mult}::numeric, ${allow_offers}::boolean, now() + (l.n - 1) * interval '1 microsecond'
      FROM unnest(${lines.map((l) => l.role)}::text[], ${lines.map((l) => l.spots)}::int[], ${lines.map((l) => l.rate)}::numeric[],
                  ${lines.map((l) => l.tickets.join(","))}::text[]) WITH ORDINALITY AS l(role, spots, rate, tickets, n)
      RETURNING id, (EXTRACT(MICROSECONDS FROM created_at - now()) + 1)::int AS n`;
    ids = rows.sort((a, b) => a.n - b.n).map((r) => r.id);
  } catch (e) {
    await refund(key, 3600, lines.length);   // nothing was posted
    throw e;
  }
  await Promise.all(ids.map((id) => runMatchingRound(id)));
  redirect(`/boss/shifts/${ids[0]}`);
}

export async function cancelShift(id: string) {
  const u = await requireRole("boss");
  if (!isUuid(id)) redirect("/boss");
  // Cancel the shift, take every booked worker off it, close any open offers, tell them all.
  await sql`
    WITH s AS (
      UPDATE shifts SET status = 'cancelled' WHERE id = ${id} AND boss_id = ${u.id} AND status IN ('open','filled') RETURNING id, day
    ), b AS (
      UPDATE bookings SET status = 'removed' WHERE shift_id IN (SELECT id FROM s) AND status IN ('accepted','clocked_in') RETURNING worker_id, shift_id
    ), o AS (
      UPDATE offers SET status = 'expired', responded_at = now() WHERE shift_id IN (SELECT id FROM s) AND status = 'pending' RETURNING worker_id, shift_id
    )
    INSERT INTO notifications (user_id, shift_id, kind, body)
    SELECT worker_id, shift_id, 'cancelled', ${u.name} || ' cancelled the ' || to_char((SELECT day FROM s), 'Dy DD Mon') || ' shift.' FROM b
    UNION ALL
    SELECT worker_id, shift_id, 'cancelled', 'The shift you asked about was cancelled.' FROM o`;
  sendAlertsSoon();
  redirect("/boss");
}

/**
 * "Cancel the whole job": every line of this shift's post that still needs workers, in one statement, with the same
 * side effects as cancelShift for each. A line that's already full stays booked — cancelling it (and telling the
 * people on it) is a decision about those people, made on its own page. Only ever the caller's own shifts.
 */
export async function cancelPost(shiftId: string) {
  const u = await requireRole("boss");
  if (!isUuid(shiftId)) redirect("/boss");
  await sql`
    WITH me AS (
      SELECT id, post_id FROM shifts WHERE id = ${shiftId} AND boss_id = ${u.id}
    ), s AS (
      UPDATE shifts SET status = 'cancelled'
      WHERE boss_id = ${u.id} AND status = 'open'
        AND (id = (SELECT id FROM me) OR post_id = (SELECT post_id FROM me))
      RETURNING id, day
    ), b AS (
      UPDATE bookings SET status = 'removed' WHERE shift_id IN (SELECT id FROM s) AND status IN ('accepted','clocked_in') RETURNING worker_id, shift_id
    ), o AS (
      UPDATE offers SET status = 'expired', responded_at = now() WHERE shift_id IN (SELECT id FROM s) AND status = 'pending' RETURNING worker_id, shift_id
    )
    INSERT INTO notifications (user_id, shift_id, kind, body)
    SELECT b.worker_id, b.shift_id, 'cancelled', ${u.name} || ' cancelled the ' || to_char(s.day, 'Dy DD Mon') || ' shift.' FROM b JOIN s ON s.id = b.shift_id
    UNION ALL
    SELECT worker_id, shift_id, 'cancelled', 'The shift you asked about was cancelled.' FROM o`;
  sendAlertsSoon();
  redirect("/boss");
}

/** Boss can notify the next batch manually instead of waiting for the 20-minute cron. */
export async function widenSearch(shiftId: string) {
  const u = await requireRole("boss");
  if (!isUuid(shiftId)) return;
  const [s] = await sql`SELECT id FROM shifts WHERE id = ${shiftId} AND boss_id = ${u.id}`;
  if (s && await hit(`widen:${u.id}`, SHIFT_POSTS_PER_HOUR * 2, 3600)) await runMatchingRound(shiftId);
  revalidatePath(`/boss/shifts/${shiftId}`);
}

export async function removeBooking(bookingId: string) {
  const u = await requireRole("boss");
  if (!isUuid(bookingId)) return;
  const [b] = await sql`
    WITH b AS (
      UPDATE bookings b SET status = 'removed' FROM shifts s
      WHERE b.id = ${bookingId} AND s.id = b.shift_id AND s.boss_id = ${u.id} AND b.status = 'accepted' RETURNING b.shift_id, b.worker_id
    ), o AS (UPDATE shifts SET status = 'open' WHERE id IN (SELECT shift_id FROM b) AND status = 'filled'),
    n AS (INSERT INTO notifications (user_id, shift_id, kind, body) SELECT worker_id, shift_id, 'removed', 'The boss took you off this shift. Call them if you want to talk it through.' FROM b)
    SELECT shift_id FROM b`;
  if (b) { sendAlertsSoon(); revalidatePath(`/boss/shifts/${b.shift_id}`); }
}

export async function approveHours(form: FormData) {
  const u = await requireRole("boss");
  const bookingId = String(form.get("booking_id"));
  if (!isUuid(bookingId)) return;
  const hours = num(form.get("hours"), 0, 16, NaN);
  if (Number.isNaN(hours)) return;
  const reason = String(form.get("pay_reason") || "").trim().slice(0, 120) || null;
  // Approve + auto-add to crew in one statement; the dollar figure needs the shift's terms, so it's a second.
  const [b] = await sql`
    WITH b AS (
      UPDATE bookings b SET hours_approved = ${hours}, status = 'approved', approved_at = now(),
        pay_reason = ${reason},
        clock_out_at = COALESCE(b.clock_out_at, now()), hours_worked = COALESCE(b.hours_worked, ${hours})
      FROM shifts s WHERE b.id = ${bookingId} AND s.id = b.shift_id AND s.boss_id = ${u.id}
        AND b.status IN ('accepted','clocked_in','clocked_out')
      RETURNING b.worker_id, b.shift_id, b.hours_worked, COALESCE(b.agreed_rate, s.rate) AS rate, s.day::text AS day,
                s.ot_mode, s.ot_after_hours, s.ot_multiplier
    ), c AS (
      INSERT INTO crew (boss_id, worker_id, type, rate) SELECT ${u.id}, worker_id, 'casual', rate FROM b ON CONFLICT DO NOTHING
    )
    SELECT * FROM b`;
  if (!b) return;
  // Same maths as the Pay screen — overtime terms agreed on the shift, Award as the floor.
  const pay = payForShift(hours, Number(b.rate), { ot_mode: b.ot_mode, ot_after_hours: b.ot_after_hours, ot_multiplier: b.ot_multiplier });
  const edited = Number(b.hours_worked) !== hours;
  await sql`INSERT INTO notifications (user_id, shift_id, kind, body) VALUES (${b.worker_id}, ${b.shift_id}, 'hours_approved',
    ${`${fmtDay(b.day)}: ${hours}h approved${edited ? ` (you recorded ${Number(b.hours_worked)}h)` : ""}${reason ? ` — ${reason}` : ""}. $${pay.gross.toFixed(2)} owed by ${u.name}.`})`;
  sendAlertsSoon();
  revalidatePath(`/boss/shifts/${b.shift_id}`);
}

export async function markPaid(bookingId: string, paid: boolean) {
  const u = await requireRole("boss");
  if (!isUuid(bookingId)) return;
  await sql`
    WITH b AS (
      UPDATE bookings b SET status = ${paid ? "paid" : "approved"}, paid_at = ${paid ? sql`now()` : null}
      FROM shifts s WHERE b.id = ${bookingId} AND s.id = b.shift_id AND s.boss_id = ${u.id} AND b.status IN ('approved','paid')
      RETURNING b.worker_id, b.shift_id, s.day
    )
    INSERT INTO notifications (user_id, shift_id, kind, body)
    SELECT worker_id, shift_id, 'paid', ${u.name} || ' marked ' || to_char(day, 'Dy DD Mon') || ' as paid.' FROM b WHERE ${paid}`;
  if (paid) sendAlertsSoon();
  revalidatePath("/boss/pay");
}

export async function markPaidMany(bookingIds: string[], paid: boolean) {
  const u = await requireRole("boss");
  bookingIds = (bookingIds ?? []).filter(isUuid).slice(0, 200);
  if (!bookingIds.length) return;
  await sql`
    WITH b AS (
      UPDATE bookings b SET status = ${paid ? "paid" : "approved"}, paid_at = ${paid ? sql`now()` : null}
      FROM shifts s WHERE b.id = ANY(${bookingIds}) AND s.id = b.shift_id AND s.boss_id = ${u.id} AND b.status IN ('approved','paid')
      RETURNING b.worker_id, b.shift_id, s.day
    )
    INSERT INTO notifications (user_id, shift_id, kind, body)
    SELECT worker_id, shift_id, 'paid', ${u.name} || ' marked ' || to_char(day, 'Dy DD Mon') || ' as paid.' FROM b WHERE ${paid}`;
  if (paid) sendAlertsSoon();
  revalidatePath("/boss/pay");
}

export async function setPayMode(mode: "award" | "flat") {
  const u = await requireRole("boss");
  await sql`UPDATE bosses SET pay_mode = ${mode} WHERE user_id = ${u.id}`;
  revalidatePath("/boss/pay");
}

export async function updateCrew(form: FormData) {
  const u = await requireRole("boss");
  const worker_id = String(form.get("worker_id"));
  if (!isUuid(worker_id)) return;
  const type = String(form.get("type")) === "fulltime" ? "fulltime" : "casual";
  const rate = clampRate(form.get("rate"));
  await sql`INSERT INTO crew (boss_id, worker_id, type, rate) VALUES (${u.id}, ${worker_id}, ${type}, ${rate})
    ON CONFLICT (boss_id, worker_id) DO UPDATE SET type = EXCLUDED.type, rate = EXCLUDED.rate`;
  revalidatePath(`/boss/workers/${worker_id}`);
}

export async function addCrewByPhone(form: FormData) {
  const u = await requireRole("boss");
  const { normalisePhone } = await import("@/lib/sms");
  const phone = normalisePhone(String(form.get("phone") || ""));
  if (!phone) return;
  const [w] = await sql`SELECT w.user_id FROM workers w JOIN users us ON us.id = w.user_id WHERE us.phone = ${phone}`;
  if (!w) redirect(`/boss/workers?notfound=1`);
  await sql`INSERT INTO crew (boss_id, worker_id, rate) VALUES (${u.id}, ${w.user_id}, ${clampRate(0)}) ON CONFLICT DO NOTHING`;
  redirect(`/boss/workers/${w.user_id}`);
}

export async function removeFromCrew(workerId: string) {
  const u = await requireRole("boss");
  if (!isUuid(workerId)) redirect("/boss/workers");
  await sql`DELETE FROM crew WHERE boss_id = ${u.id} AND worker_id = ${workerId}`;
  redirect("/boss/workers");
}

export async function blockWorker(workerId: string) {
  const u = await requireRole("boss");
  if (!isUuid(workerId)) redirect("/boss/workers");
  await sql`
    WITH bl AS (INSERT INTO blocks (boss_id, worker_id, by_role) VALUES (${u.id}, ${workerId}, 'boss') ON CONFLICT DO NOTHING),
    c AS (DELETE FROM crew WHERE boss_id = ${u.id} AND worker_id = ${workerId}),
    -- off every shift of mine that hasn't happened yet
    b AS (
      UPDATE bookings b SET status = 'removed' FROM shifts s
      WHERE b.worker_id = ${workerId} AND s.id = b.shift_id AND s.boss_id = ${u.id} AND s.day >= CURRENT_DATE AND b.status IN ('accepted','clocked_in')
      RETURNING b.shift_id
    ),
    o AS (UPDATE shifts SET status = 'open' WHERE id IN (SELECT shift_id FROM b) AND status = 'filled'),
    x AS (UPDATE offers o SET status = 'declined', responded_at = now() FROM shifts s
          WHERE o.worker_id = ${workerId} AND s.id = o.shift_id AND s.boss_id = ${u.id} AND o.status = 'pending')
    INSERT INTO notifications (user_id, shift_id, kind, body)
    SELECT ${workerId}, shift_id, 'removed', 'The boss took you off this shift.' FROM b`;
  sendAlertsSoon();
  redirect("/boss/workers");
}

/** "Same again tomorrow": clone a shift to the next day for the same worker, no form. */
export async function sameAgainTomorrow(bookingId: string) {
  const u = await requireRole("boss");
  if (!isUuid(bookingId)) return;
  const [b] = await sql`
    SELECT b.worker_id, s.project_id, s.role, s.tickets_required, s.note, s.ot_mode, s.ot_after_hours, s.ot_multiplier, s.allow_offers,
           COALESCE(b.agreed_rate, s.rate) AS rate, COALESCE(b.agreed_hours, s.hours) AS hours, COALESCE(b.agreed_start, s.start_time) AS start_time,
           GREATEST(s.day + 1, CURRENT_DATE) AS day
    FROM bookings b JOIN shifts s ON s.id = b.shift_id JOIN projects p ON p.id = s.project_id
    WHERE b.id = ${bookingId} AND s.boss_id = ${u.id} AND NOT p.archived`;
  if (!b) return;
  if (!(await hit(`shift-post:${u.id}`, SHIFT_POSTS_PER_HOUR, 3600))) return;   // a clone can buzz and text too
  const [ns] = await sql`INSERT INTO shifts (project_id, boss_id, day, start_time, hours, spots, role, tickets_required, rate, note, direct_worker_id,
      ot_mode, ot_after_hours, ot_multiplier, allow_offers)
    VALUES (${b.project_id}, ${u.id}, ${b.day}, ${b.start_time}, ${b.hours}, 1, ${b.role}, ${b.tickets_required}, ${b.rate}, ${b.note}, ${b.worker_id},
      ${b.ot_mode}, ${b.ot_after_hours}, ${b.ot_multiplier}, ${b.allow_offers}) RETURNING id`;
  await runMatchingRound(ns.id);
  redirect(`/boss/shifts/${ns.id}`);
}

export async function logCall(toUser: string, bookingId?: string) {
  const u = await requireRole("boss");
  if (!isUuid(toUser) || (bookingId && !isUuid(bookingId))) return;
  await sql`INSERT INTO calls (from_user, to_user, booking_id) VALUES (${u.id}, ${toUser}, ${bookingId ?? null})`;
}


// ────────────────────────── offers, site crew cap, weather, overtime on posting

/** How many people this site should have in total — own crew plus casuals. */
export async function setCrewTarget(form: FormData) {
  const u = await requireRole("boss");
  const id = String(form.get("project_id"));
  if (!isUuid(id)) return;
  const raw = String(form.get("crew_target") || "").trim();
  const target = raw === "" ? null : Math.round(num(raw, 0, 500, NaN));
  if (target !== null && Number.isNaN(target)) return;
  await sql`UPDATE projects SET crew_target = ${target} WHERE id = ${id} AND boss_id = ${u.id}`;
  revalidatePath(`/boss/projects/${id}`);
}

/** Accept a worker's deal request — books them on the terms they asked for. */
export async function acceptOffer(offerId: string) {
  const u = await requireRole("boss");
  if (!isUuid(offerId)) return { error: "That request is no longer open." };
  const [o] = await sql`
    SELECT o.shift_id, o.worker_id, o.rate, o.hours, o.start_time::text AS start_time, us.name AS worker_name
    FROM offers o JOIN shifts s ON s.id = o.shift_id JOIN users us ON us.id = o.worker_id
    WHERE o.id = ${offerId} AND s.boss_id = ${u.id} AND o.from_role = 'worker' AND o.status = 'pending'`;
  if (!o) return { error: "That request is no longer open." };
  const r = await bookWorker({ shiftId: o.shift_id, workerId: o.worker_id, workerName: o.worker_name,
    agreed: { rate: o.rate == null ? null : Number(o.rate), hours: o.hours == null ? null : Number(o.hours), start_time: o.start_time ? o.start_time.slice(0, 5) : null },
    notify: { userId: o.worker_id, kind: "offer_accepted", body: (day, site) => `${u.name} agreed to your terms for ${day} at ${site}. You're booked.` } });
  if (!r.ok) return { error: r.error };
  await sql`UPDATE offers SET status = 'accepted', responded_at = now() WHERE id = ${offerId}`;
  revalidatePath(`/boss/offers`);
  return { ok: true };
}

export async function declineOffer(form: FormData) {
  const u = await requireRole("boss");
  const offerId = String(form.get("offer_id"));
  if (!isUuid(offerId)) return;
  const why = String(form.get("why") || "").trim().slice(0, 200);
  await sql`
    WITH o AS (
      UPDATE offers o SET status = 'declined', responded_at = now()
      FROM shifts s WHERE o.id = ${offerId} AND s.id = o.shift_id AND s.boss_id = ${u.id} AND o.status = 'pending'
      RETURNING o.worker_id, o.shift_id, s.day
    )
    INSERT INTO notifications (user_id, shift_id, kind, body)
    SELECT worker_id, shift_id, 'offer_declined',
      ${`${u.name} said no to your request for `} || to_char(day, 'Dy DD Mon') || ${why ? `. "${why}"` : ". The shift is still there at the posted rate."} FROM o`;
  sendAlertsSoon();
  revalidatePath("/boss/offers");
}

/** Counter once: "not $45, but I'll do $40." Worker accepts or walks. */
export async function counterOffer(form: FormData) {
  const u = await requireRole("boss");
  const offerId = String(form.get("offer_id"));
  if (!isUuid(offerId)) return { error: "That request is no longer open." };
  const [orig] = await sql`
    SELECT o.id, o.worker_id, o.shift_id, s.rate, s.hours, s.start_time::text, s.allow_offers, s.spots, s.status, s.day, p.name AS site,
      (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = o.shift_id AND b.status NOT IN ('removed','cancelled'))::int AS taken
    FROM offers o JOIN shifts s ON s.id = o.shift_id JOIN projects p ON p.id = s.project_id
    WHERE o.id = ${offerId} AND s.boss_id = ${u.id} AND o.status = 'pending'`;
  if (!orig) return { error: "That request is no longer open." };

  const check = checkOffer(orig as never, {
    rate: form.get("rate") ? Number(form.get("rate")) : null,
    hours: form.get("hours") ? Number(form.get("hours")) : null,
    start_time: String(form.get("start_time") || "") || null,
    message: String(form.get("message") || ""),
  });
  if (!check.ok) return { error: check.error };

  await sql.begin(async (tx) => {
    await tx`UPDATE offers SET status = 'countered', responded_at = now() WHERE id = ${offerId}`;
    await tx`INSERT INTO offers (shift_id, worker_id, from_role, rate, hours, start_time, message, parent_id)
             VALUES (${orig.shift_id}, ${orig.worker_id}, 'boss', ${check.clean.rate}, ${check.clean.hours}, ${check.clean.start_time}, ${check.clean.message}, ${offerId})`;
    await tx`INSERT INTO notifications (user_id, shift_id, kind, body) VALUES (${orig.worker_id}, ${orig.shift_id}, 'counter',
             ${`${u.name} came back with a different offer for ${fmtDay(orig.day)} at ${orig.site}: ${check.changes.join(", ") || "see the note"}`})`;
  });
  sendAlertsSoon();
  revalidatePath("/boss/offers");
  return { ok: true };
}

/** Turn haggling off for a shift when you just need bodies at 6am. */
export async function setAllowOffers(shiftId: string, allow: boolean) {
  const u = await requireRole("boss");
  if (!isUuid(shiftId)) return;
  await sql`UPDATE shifts SET allow_offers = ${allow} WHERE id = ${shiftId} AND boss_id = ${u.id}`;
  revalidatePath(`/boss/shifts/${shiftId}`);
}

/**
 * Rain stopped work. Records why, and lets the boss set the hours he'll pay each
 * worker — with a suggestion, not a rule. His call, written down.
 */
export async function markWeather(form: FormData) {
  const u = await requireRole("boss");
  const shiftId = String(form.get("shift_id"));
  if (!isUuid(shiftId)) return;
  const kind = String(form.get("weather_stop") || "rain");
  if (!["rain", "wind", "heat", "storm", "other"].includes(kind)) return;
  const note = String(form.get("weather_note") || "").trim().slice(0, 200);
  const [s] = await sql`
    UPDATE shifts SET weather_stop = ${kind}, weather_note = ${note}, weather_at = now()
    WHERE id = ${shiftId} AND boss_id = ${u.id} RETURNING day, hours`;
  if (!s) return;
  const ws = await sql`
    SELECT b.worker_id FROM bookings b WHERE b.shift_id = ${shiftId} AND b.status NOT IN ('removed','cancelled')`;
  if (ws.length) {
    const body = `Work stopped for ${kind} on ${fmtDay(s.day)}${note ? ` — ${note}` : ""}. The boss is sorting out hours now.`;
    await sql`INSERT INTO notifications ${sql(ws.map((w) => ({ user_id: w.worker_id, shift_id: shiftId, kind: "weather", body })), "user_id", "shift_id", "kind", "body")}`;
    sendAlertsSoon();
  }
  revalidatePath(`/boss/shifts/${shiftId}`);
}

export async function clearWeather(shiftId: string) {
  const u = await requireRole("boss");
  if (!isUuid(shiftId)) return;
  await sql`UPDATE shifts SET weather_stop = NULL, weather_note = NULL, weather_at = NULL WHERE id = ${shiftId} AND boss_id = ${u.id}`;
  revalidatePath(`/boss/shifts/${shiftId}`);
}
