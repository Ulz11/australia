import { sql } from "./db";

/**
 * What a boss may see about a worker. Columns are listed by hand on purpose:
 * visa type and card numbers never leave the database for a boss, so they can't
 * end up in a page, a React payload or a log. The phone number is fine — bosses call.
 */
export async function workerForBoss(bossId: string, workerId: string) {
  const [w] = await sql`
    SELECT us.id, us.name, us.phone, w.tickets, w.home_label, w.photo, w.years_exp, w.trades, w.languages, w.about,
           c.type, c.rate, c.since,
           CASE WHEN st.past_shifts > 0 THEN ROUND(100.0 * st.showed / st.past_shifts) END AS score, st.completed, st.cancels
    FROM users us JOIN workers w ON w.user_id = us.id
    LEFT JOIN crew c ON c.worker_id = us.id AND c.boss_id = ${bossId}
    LEFT JOIN worker_stats st ON st.worker_id = us.id
    WHERE us.id = ${workerId}`;
  return w ?? null;
}

/** Card type, state, expiry and check status. Never the number, never the register's note (it can quote a name). */
export function licencesForBoss(workerId: string) {
  return sql<{ kind: string; issued_state: string | null; expires_on: string | null; status: string; checked_at: string | null }[]>`
    SELECT kind, issued_state, expires_on::text, status, checked_at::text
    FROM licences WHERE worker_id = ${workerId} ORDER BY kind`;
}
