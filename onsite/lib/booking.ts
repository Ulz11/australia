import { sql } from "./db";
import type { TransactionSql } from "postgres";
import { fmtDay } from "./util";
import { sendAlertsSoon } from "./alerts";

/**
 * The one way a worker gets onto a shift. Used by "Take it", by a boss accepting
 * a worker's offer, and by a worker accepting a boss's counter.
 *
 * Runs in a transaction that locks the shift row, so two people tapping the last
 * spot in the same second can't both get it. Refuses anyone the boss has removed.
 */
export type BookArgs = {
  shiftId: string;
  workerId: string;
  workerName: string;
  agreed?: { rate: number | null; hours: number | null; start_time: string | null };
  /** who to tell and what to say; null = no notification */
  notify: { userId: string; kind: string; body: (day: string, site: string) => string } | null;
};
export type BookResult = { ok: true; day: string; site: string } | { ok: false; error: string };

export async function bookWorker(a: BookArgs): Promise<BookResult> {
  const result = await (sql.begin(async (tx) => {
    // Lock the shift for the length of this transaction.
    const [s] = await tx`
      SELECT s.id, s.status, s.day::text AS day, s.spots, s.boss_id, s.direct_worker_id, p.name AS site,
        (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled'))::int AS taken,
        (SELECT b.status FROM bookings b WHERE b.shift_id = s.id AND b.worker_id = ${a.workerId}) AS mine
      FROM shifts s JOIN projects p ON p.id = s.project_id
      WHERE s.id = ${a.shiftId} FOR UPDATE OF s`;
    if (!s || s.status !== "open") return { ok: false, error: "This shift is gone." };
    if (s.day < (await today(tx))) return { ok: false, error: "That day has passed." };
    if (s.direct_worker_id && s.direct_worker_id !== a.workerId) return { ok: false, error: "This one was booked for someone else." };
    if (s.mine === "removed") return { ok: false, error: "The boss took you off this shift." };
    if (s.mine && !["cancelled"].includes(s.mine)) return { ok: false, error: "You're already on this shift." };
    if (s.taken >= s.spots) return { ok: false, error: "Just filled. Sorry." };
    const [clash] = await tx`
      SELECT 1 FROM bookings b JOIN shifts x ON x.id = b.shift_id
      WHERE b.worker_id = ${a.workerId} AND x.day = ${s.day} AND x.id <> ${a.shiftId} AND b.status IN ('accepted','clocked_in') LIMIT 1`;
    if (clash) return { ok: false, error: "You already have a shift that day." };

    const ag = a.agreed ?? { rate: null, hours: null, start_time: null };
    await tx`
      INSERT INTO bookings (shift_id, worker_id, agreed_rate, agreed_hours, agreed_start)
      VALUES (${a.shiftId}, ${a.workerId}, ${ag.rate}, ${ag.hours}, ${ag.start_time})
      ON CONFLICT (shift_id, worker_id) DO UPDATE SET status = 'accepted', created_at = now(),
        agreed_rate = EXCLUDED.agreed_rate, agreed_hours = EXCLUDED.agreed_hours, agreed_start = EXCLUDED.agreed_start,
        clock_in_at = NULL, clock_out_at = NULL, hours_worked = NULL, hours_approved = NULL`;
    await tx`INSERT INTO availability (worker_id, day, status) VALUES (${a.workerId}, ${s.day}, 'free')
             ON CONFLICT (worker_id, day) DO UPDATE SET status = 'free'`;
    if (s.taken + 1 >= s.spots) await tx`UPDATE shifts SET status = 'filled' WHERE id = ${a.shiftId}`;
    await tx`UPDATE notifications SET read_at = now() WHERE user_id = ${a.workerId} AND shift_id = ${a.shiftId} AND read_at IS NULL`;
    if (a.notify)
      await tx`INSERT INTO notifications (user_id, shift_id, kind, body)
               VALUES (${a.notify.userId}, ${a.shiftId}, ${a.notify.kind}, ${a.notify.body(fmtDay(s.day), s.site)})`;
    return { ok: true, day: s.day, site: s.site };
  }) as Promise<BookResult>);
  if (result.ok && a.notify) sendAlertsSoon();
  return result;
}

async function today(tx: TransactionSql): Promise<string> {
  const [r] = await tx`SELECT CURRENT_DATE::text AS d`;
  return r.d;
}

/**
 * Which cards count for matching. The rule:
 *  - every card the worker has entered that is not expired / not found / wrong name, and
 *  - the White Card is assumed unless they entered one and it failed.
 * Keeps workers.tickets (what the matcher reads) in step with the licences table.
 */
export async function recomputeTickets(workerId: string, tx: TransactionSql | typeof sql = sql) {
  await tx`
    UPDATE workers w SET tickets = ARRAY(
      SELECT DISTINCT k FROM (
        SELECT l.kind AS k FROM licences l
        WHERE l.worker_id = w.user_id
          AND l.status NOT IN ('expired','not_found','mismatch')
          AND (l.expires_on IS NULL OR l.expires_on >= CURRENT_DATE)
        UNION
        SELECT 'WC' WHERE NOT EXISTS (SELECT 1 FROM licences l WHERE l.worker_id = w.user_id AND l.kind = 'WC')
      ) t ORDER BY k
    ) WHERE w.user_id = ${workerId}`;
}
