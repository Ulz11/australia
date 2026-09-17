import { sql } from "./db";
import { sendAlertsSoon } from "./alerts";
import { fmtDay, fmtTime } from "./util";
import { pickBatch, urgencyOf, NEW_WORKER_PRIOR, ROUND_MINUTES, URGENT_HOURS, type Candidate } from "./rules";

/**
 * The five gates, cheapest first, all in one query:
 *  1. distance  – worker home within their own radius of the site
 *  2. free      – worker_free(): their own answer for that day, or their usual week (migration 017)
 *  3. tickets   – shift's required tickets ⊆ worker's tickets
 *  4. not blocked either way
 *  5. not already booked / notified for this shift
 *
 * Ranked: reliability (a worker with no history gets a mid-pack prior, not the
 * bottom), worked for this boss before, distance. The caller takes the batch with
 * pickBatch(), which keeps one seat for someone new.
 */
export async function findCandidates(shiftId: string, limit: number): Promise<Candidate[]> {
  return sql<Candidate[]>`
    WITH s AS (
      SELECT sh.*, p.location FROM shifts sh JOIN projects p ON p.id = sh.project_id
      WHERE sh.id = ${shiftId} AND NOT p.archived
    )
    SELECT w.user_id,
           COALESCE(st.past_shifts, 0)::int AS past_shifts,
           ST_Distance(w.home, s.location)::int AS dist_m,
           CASE WHEN st.past_shifts > 0 THEN ROUND(100.0 * st.showed / st.past_shifts)::int ELSE NULL END AS score,
           EXISTS (SELECT 1 FROM crew c WHERE c.boss_id = s.boss_id AND c.worker_id = w.user_id) AS worked_before
    FROM s
    JOIN workers w ON w.home IS NOT NULL
      AND ST_DWithin(w.home, s.location, w.radius_km * 1000)                                -- 1
    LEFT JOIN worker_stats st ON st.worker_id = w.user_id
    WHERE worker_free(w.user_id, s.day)                                                      -- 2
      AND s.tickets_required <@ w.tickets                                                    -- 3
      AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE bl.boss_id = s.boss_id AND bl.worker_id = w.user_id) -- 4
      AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.shift_id = s.id AND b.worker_id = w.user_id)      -- 5
      AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.shift_id = s.id AND n.user_id = w.user_id AND n.kind = 'shift_match')
      AND w.user_id <> s.boss_id
    ORDER BY COALESCE(
               CASE WHEN st.past_shifts > 0 THEN 100.0 * st.showed / st.past_shifts END, ${NEW_WORKER_PRIOR}
             ) DESC,
             worked_before DESC, dist_m ASC
    LIMIT ${limit}`;
}

/** Run one notification round for a shift. Returns how many were notified. */
export async function runMatchingRound(shiftId: string): Promise<{ notified: number; remaining: number; urgent: boolean }> {
  const [sh] = await sql`
    SELECT s.*, s.day::text AS day, s.start_time::text AS start_time, p.name AS site, p.address,
           (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled'))::int AS taken
    FROM shifts s JOIN projects p ON p.id = s.project_id
    WHERE s.id = ${shiftId} AND s.status = 'open' AND NOT p.archived`;
  if (!sh) return { notified: 0, remaining: 0, urgent: false };
  const remaining = sh.spots - sh.taken;
  if (remaining <= 0) return { notified: 0, remaining: 0, urgent: false };
  const u = urgencyOf({ day: sh.day, start_time: sh.start_time });

  // Direct booking ("Book again") skips the pool entirely.
  if (sh.direct_worker_id) {
    const body = `${sh.site}: ${fmtDay(sh.day)} ${fmtTime(sh.start_time)}, ${Number(sh.hours)}h, $${Number(sh.rate).toFixed(2)}/h. Booked directly for you.`;
    await sql`INSERT INTO notifications (user_id, shift_id, kind, body) VALUES (${sh.direct_worker_id}, ${shiftId}, 'shift_match', ${body}) ON CONFLICT DO NOTHING`;
    sendAlertsSoon();
    await sql`UPDATE shifts SET notify_round = notify_round + 1, last_notified_at = now() WHERE id = ${shiftId}`;
    return { notified: 1, remaining, urgent: u.urgent };
  }

  const n = remaining * u.batchMultiplier;
  // Fetch a window past the batch so pickBatch can find someone new to seat.
  const pool = await findCandidates(shiftId, n * 4 + 10);
  const batch = pickBatch(pool, n);
  if (batch.length === 0) {
    await sql`UPDATE shifts SET last_notified_at = now() WHERE id = ${shiftId}`;
    return { notified: 0, remaining, urgent: u.urgent };
  }
  const body = `${u.urgent ? "Starts soon — " : ""}${sh.role} at ${sh.site} · ${fmtDay(sh.day)} ${fmtTime(sh.start_time)} · ${Number(sh.hours)}h · $${Number(sh.rate).toFixed(2)}/h`;
  await sql`INSERT INTO notifications ${sql(
    batch.map((c) => ({ user_id: c.user_id, shift_id: shiftId, kind: "shift_match", body })),
    "user_id", "shift_id", "kind", "body"
  )} ON CONFLICT DO NOTHING`;
  sendAlertsSoon();
  await sql`UPDATE shifts SET notify_round = notify_round + 1, last_notified_at = now() WHERE id = ${shiftId}`;
  return { notified: batch.length, remaining, urgent: u.urgent };
}

/**
 * Called by cron: widen the net on shifts still open. Normal shifts get a new round
 * every 20 minutes; a shift starting within three hours gets one every 5.
 */
export async function expandStaleShifts() {
  const stale = await sql<{ id: string }[]>`
    SELECT s.id FROM shifts s JOIN projects p ON p.id = s.project_id
    WHERE s.status = 'open' AND NOT p.archived AND s.direct_worker_id IS NULL
      AND (s.day + s.start_time) > now()
      AND s.spots > (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled'))
      AND (s.last_notified_at IS NULL OR s.last_notified_at < now() - (
            CASE WHEN (s.day + s.start_time) - now() <= (${URGENT_HOURS} || ' hours')::interval
                 THEN interval '5 minutes' ELSE (${ROUND_MINUTES} || ' minutes')::interval END))`;
  const out: Record<string, number> = {};
  for (const s of stale) out[s.id] = (await runMatchingRound(s.id)).notified;
  return out;
}
