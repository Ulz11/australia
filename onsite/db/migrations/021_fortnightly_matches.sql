-- 021: one price. $2 per introduction, invoiced every 14 days. The subscription is gone.
--
-- db/migrate.ts re-runs every file on every deploy, so everything here is additive and idempotent, and
-- nothing is dropped. The subscription columns (bosses.subscription_status, trial_ends_at,
-- subscription_cancelled_at) and the old partial indexes from 010 stay exactly where they are: an open
-- invoice raised under the subscription is still opened, printed and paid, and lib/invoicing.ts simply
-- stops selecting those columns. Removing them is a separate, irreversible step for a deploy where
-- nothing left writes them — doing it here would mean a billing rollback could not roll back.
--
-- subscription_status keeps its NOT NULL DEFAULT 'trialing' from 010, so a boss INSERT that no longer
-- mentions it still succeeds; the value is then read by nothing. closeBillingPeriods no longer filters
-- on it, so a boss sitting at 'lapsed' or 'cancelling' is billed for their introductions like everyone
-- else, which is now the only correct answer.

------------------------------------------------------------------ the fortnight, anchored per boss
-- Every boss's period becomes exactly 14 days, on a grid that starts at their own signup day.
--
-- The anchor matters as much as the length. A 14-day cycle counted from one shared date would land
-- every boss in the same 20-minute cron run, and closeBillingPeriods takes 500 bosses at a time — the
-- 501st would wait 20 minutes for their invoice, the 5001st over three hours. Anchored to signup, the
-- book stays spread across all 14 days the way monthly anniversaries spread it across 28.
--
-- Idempotent by guard, not by luck: the WHERE only matches a boss whose period is not already 14 days
-- long, so the second deploy touches no rows. Without that guard, re-running this weeks later would
-- walk an open period forward and skip a fortnight's close. (Nobody would be under-billed either way —
-- matchLines has no lower bound and picks up every unbilled introduction — but a boss would stop
-- seeing an invoice on the day they expect one.)
--
-- now() is compared to timestamptz here, instant against instant, so the session's time zone cannot
-- change the answer. This is not a bare date comparison; see lib/siteClock.ts for the ones that are.
--
-- '336 hours' and never '14 days'. Added to a timestamptz, `interval '14 days'` is CALENDAR arithmetic:
-- it keeps the wall clock and lets the offset move, so a fortnight from 22 Sep 17:35 +10 ends 6 Oct
-- 17:35 +11 — thirteen days and twenty-three hours of real time, because Sydney's DST starts on the 4th.
-- That is the same trap lib/subscription.ts's addDays() avoids by doing getTime() + n * DAY_MS, and the
-- two have to agree or the migration and the runtime drift apart by an hour twice a year.
--
-- It also broke this statement's own guard: `period_ends_at - period_started_at <> interval '14 days'`
-- was TRUE for every row it had just written, so the next db/migrate.ts run — which re-applies every
-- file — would have walked every boss's period forward another fortnight and skipped that close. The
-- guard now compares real seconds, which is the thing that is actually meant to be fourteen days.
UPDATE bosses b
SET period_started_at = cell.start_at,
    period_ends_at    = cell.start_at + interval '336 hours'
FROM users u
CROSS JOIN LATERAL (
  SELECT COALESCE(u.created_at, now())
         + (GREATEST(0, floor(extract(epoch FROM now() - COALESCE(u.created_at, now())) / 86400 / 14))
            * interval '336 hours') AS start_at
) cell
WHERE u.id = b.user_id
  AND (b.period_started_at IS NULL
    OR b.period_ends_at IS NULL
    OR extract(epoch FROM (b.period_ends_at - b.period_started_at)) <> 14 * 86400);

-- The cron's query is now "every boss whose fortnight has ended", with no status predicate. 010's
-- bosses_period_idx is partial on subscription_status IN ('active','cancelling') and cannot serve it,
-- and CREATE INDEX IF NOT EXISTS under that name would silently keep the partial one. So this is a new
-- name beside it: a boss who lapsed under the old model is billable again and has to be found.
CREATE INDEX IF NOT EXISTS bosses_period_due_idx ON bosses(period_ends_at);

------------------------------------------------------------------ lines
-- invoice_lines_kind_ck from 010 already allows 'match', which is the only kind written from now on,
-- and 'subscription', which historical lines still carry. Nothing to change: tightening it would
-- invalidate a record of money that was actually charged.
