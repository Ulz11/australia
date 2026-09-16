/**
 * Trying again when the White Card register couldn't answer.
 *
 * A save whose check was due but gave no answer — the register or its token service down, a timeout,
 * a 4xx/5xx, throttled with 429/503, or the app's daily budget spent — is queued by saveLicence
 * (actions/worker.ts): `recheck_at` ≈ now + RECHECK_FIRST_MIN, `check_attempts` = 0. Only
 * checkLicence's explicit `retryable` does that; nothing here reads the wording of a note. Every
 * other save takes the card off the queue, so HRW licences, other states and real answers never
 * join it, and nor does anything the demo seed writes.
 *
 * The 20-minute cron (app/api/cron/expand) calls recheckLicences(), which takes at most
 * RECHECK_BATCH due cards a run and asks again, one at a time:
 *
 *  - A real answer → written exactly as saveLicence writes one (status, checked_at, checked_via,
 *    check_note, expires_on; holder_name stays what the worker typed), the card leaves the queue,
 *    workers.tickets is recomputed by the same recomputeTickets saveLicence uses, and the worker
 *    gets one 'licence_check' alert (push only — never a text).
 *  - Tried and failed → one attempt spent, and the next try waits (RECHECK_BACKOFF_MIN):
 *
 *        save ─5 min─▶ try 1 ─15 min─▶ try 2 ─1 h─▶ try 3 ─3 h─▶ try 4 ─6 h─▶ try 5 ─12 h─▶ try 6 ─24 h─▶ try 7
 *
 *    If try 7 fails too (≈ 46 h after the save) the card leaves the queue as 'unchecked' with the
 *    by-hand note, and shows up in the control room's "cards to check by hand".
 *  - Budget refused → nothing was asked, so no attempt is spent: the card waits until the day's
 *    budget window closes (at least CAP_WAIT_MIN), and the rest of the batch waits with it
 *    without knocking on the ceiling again.
 *  - Paused → a register call somewhere in the app failed in the last REGISTER_PAUSE_MIN minutes
 *    (lib/licenceCheck.ts), so nothing was asked and no attempt is spent: the card waits until the
 *    pause lifts, and so does the rest of the batch. A failure inside this run starts that pause, so
 *    the cards after it in the batch are deferred rather than each spending an attempt on a dead register.
 *
 * Races. A claim moves `recheck_at` LEASE_MIN ahead inside the same statement that picks the rows
 * (FOR UPDATE SKIP LOCKED, as deliverAlerts does), so two runs never take the same card and a run
 * that dies mid-way doesn't hot-loop — its cards come due again after the lease. The worker may
 * edit or remove the card while its check is out: every write-back is a compare-and-set on the
 * row as claimed (same id, kind, number, issued_state, holder_name, expires_on, and still queued).
 * Anything else means the answer is about a card that no longer exists, and it is dropped silently.
 *
 * Privacy: nothing here logs a card number, a name, or anything the register said, and the cron
 * summary is counts only.
 */
import { sql } from "@/lib/db";
import { checkLicence, checksResumeAt, gaveUpNote, registerPausedUntil } from "@/lib/licenceCheck";
import { recomputeTickets } from "@/lib/booking";
import type { CheckResult, LicenceKind } from "@/lib/verify";

/** A save that couldn't check is first tried again after this long. */
export const RECHECK_FIRST_MIN = 5;
/** Wait after the 1st, 2nd … 6th failed re-check. A 7th failure hands the card to a person. */
export const RECHECK_BACKOFF_MIN = [15, 60, 180, 360, 720, 1440] as const;
/** Cards asked about per cron run. Each can be a live call against a 2,500-a-month quota. */
export const RECHECK_BATCH = 5;
/** How far a claim pushes `recheck_at`, so a run that dies doesn't take the same cards on the next run. */
export const RECHECK_LEASE_MIN = 10;
/** Shortest wait for a card the daily budget turned away, even if the window is about to roll over. */
export const CAP_WAIT_MIN = 15;

/** Minutes to wait after `attempts` failed re-checks, or null when that was the last one. */
export function nextRecheckMin(attempts: number): number | null {
  return attempts >= 1 && attempts <= RECHECK_BACKOFF_MIN.length ? RECHECK_BACKOFF_MIN[attempts - 1] : null;
}

/** The only body a verified re-check sends. Everything else sends checkLicence's own sentence. */
export const VERIFIED_ALERT = "Your White Card checked out with SafeWork NSW.";

export type RecheckSummary = {
  claimed: number; verified: number; not_found: number; expired: number; mismatch: number;
  retrying: number; gave_up: number; cap_deferred: number; paused: number;
};

type Claimed = {
  id: string; worker_id: string; kind: LicenceKind; number: string; issued_state: string;
  holder_name: string | null; expires_on: string | null; check_attempts: number;
};

/** The write-back guard: the row is still the card we asked about, and still waiting for this answer. */
const unchanged = (r: Claimed) => sql`
  id = ${r.id} AND recheck_at IS NOT NULL
  AND kind = ${r.kind} AND number IS NOT DISTINCT FROM ${r.number}::text
  AND issued_state IS NOT DISTINCT FROM ${r.issued_state}::text
  AND holder_name IS NOT DISTINCT FROM ${r.holder_name}::text
  AND expires_on IS NOT DISTINCT FROM ${r.expires_on}::date`;

export async function recheckLicences(limit = RECHECK_BATCH): Promise<RecheckSummary> {
  const out: RecheckSummary = { claimed: 0, verified: 0, not_found: 0, expired: 0, mismatch: 0, retrying: 0, gave_up: 0, cap_deferred: 0, paused: 0 };
  const rows = await sql<Claimed[]>`
    WITH due AS MATERIALIZED (
      SELECT id FROM licences
      WHERE recheck_at <= now()
      ORDER BY recheck_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE licences l SET recheck_at = now() + make_interval(mins => ${RECHECK_LEASE_MIN})
    FROM due WHERE l.id = due.id
    RETURNING l.id, l.worker_id, l.kind, l.number, l.issued_state, l.holder_name, l.expires_on::text AS expires_on, l.check_attempts`;
  out.claimed = rows.length;

  // One refusal — the day's budget, or a pause — is the whole app's answer for the rest of this run.
  let stopped: "cap_refused" | "paused" | null = null;
  let resume: Date | null | undefined;
  for (const r of rows) {
    try {
      const result: CheckResult | null = stopped ? null : await checkLicence({
        kind: r.kind, number: r.number, issued_state: r.issued_state, holder_name: r.holder_name ?? "", expires_on: r.expires_on,
      });
      const refusal: "cap_refused" | "paused" | null = stopped ?? (result?.retryable === "cap_refused" || result?.retryable === "paused" ? result.retryable : null);

      if (refusal === "cap_refused") {
        // Nothing was asked, so nothing is spent: same attempt count, back when the budget is.
        stopped = refusal;
        if (resume === undefined) resume = await checksResumeAt();
        const moved = await sql`
          UPDATE licences SET recheck_at = GREATEST(now() + make_interval(mins => ${CAP_WAIT_MIN}), ${resume}::timestamptz)
          WHERE ${unchanged(r)}`;
        if (moved.count) out.cap_deferred++;
        continue;
      }
      if (refusal === "paused") {
        // Nothing was asked here either: same attempt count, back the moment the pause lifts (or next run, if it just did).
        stopped = refusal;
        if (resume === undefined) resume = await registerPausedUntil();
        const moved = await sql`
          UPDATE licences SET recheck_at = GREATEST(now(), ${resume}::timestamptz)
          WHERE ${unchanged(r)}`;
        if (moved.count) out.paused++;
        continue;
      }
      if (!result) continue;                           // unreachable: `stopped` is always one of the two above

      if (result.retryable === "failed") {
        const attempts = r.check_attempts + 1;
        const wait = nextRecheckMin(attempts);
        const moved = await sql`
          UPDATE licences SET status = 'unchecked', checked_at = NULL, checked_via = ${result.via}, check_attempts = ${attempts},
            check_note = ${wait == null ? gaveUpNote(r.issued_state) : result.note},
            recheck_at = ${wait == null ? null : sql`now() + make_interval(mins => ${wait})`}
          WHERE ${unchanged(r)}`;
        if (moved.count) out[wait == null ? "gave_up" : "retrying"]++;
        continue;
      }

      const status = result.status;
      if (status !== "verified" && status !== "not_found" && status !== "expired" && status !== "mismatch") {
        // An answer that still needs a person (say, a register row with no card type): the note says
        // so, and the queue has nothing more to try.
        const moved = await sql`
          UPDATE licences SET status = 'unchecked', checked_at = NULL, checked_via = ${result.via}, check_note = ${result.note},
            recheck_at = NULL, check_attempts = 0
          WHERE ${unchanged(r)}`;
        if (moved.count) out.gave_up++;
        continue;
      }

      // A real answer. Same columns, same values as saveLicence would write; the alert only goes if the write did.
      const body = status === "verified" ? VERIFIED_ALERT : result.note;
      const applied = await sql`
        WITH l AS (
          UPDATE licences SET status = ${status}, checked_at = now(), checked_via = ${result.via}, check_note = ${result.note},
            expires_on = ${result.expires_on ?? r.expires_on}::date, recheck_at = NULL, check_attempts = 0
          WHERE ${unchanged(r)}
          RETURNING worker_id
        )
        INSERT INTO notifications (user_id, kind, body) SELECT worker_id, 'licence_check', ${body} FROM l
        RETURNING user_id`;
      if (!applied.length) continue;                   // edited or removed while we asked: not this card's answer any more
      await recomputeTickets(r.worker_id);
      out[status]++;
    } catch (e) {
      // The lease brings the card back in RECHECK_LEASE_MIN. Log the kind of failure only — never the card.
      console.error("licence re-check failed", (e as { code?: string })?.code ?? (e as Error)?.name ?? "error");
    }
  }
  return out;
}
