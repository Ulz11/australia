import type { Fragment } from "postgres";
import { sql } from "./db";

/**
 * The clock to use when there is no site on the row — a worker who hasn't been given a job yet, a screen
 * that isn't about one. Anywhere a query can reach projects.tz (migration 020) it uses that instead, because
 * a Perth job rolls over its day three hours after a Sydney one.
 */
export const APP_TZ = process.env.APP_TZ || "Australia/Sydney";

/** A site's zone: the joined column, written sql`p.tz`, or a plain zone name where no site is in the query. */
export type SiteTz = string | Fragment;

/**
 * Today, on the site's clock, for use inside a statement: `WHERE s.day >= ${siteToday(sql`p.tz`)}`.
 *
 * Not CURRENT_DATE, and not anything else that reads the session's TimeZone. lib/db.ts asks for that zone as
 * a connection startup parameter and Neon's pooler — the endpoint DATABASE_URL points at — quietly drops it,
 * so the session really runs in GMT: current_setting('TimeZone') says so, and pg_settings calls it a default
 * nobody set. CURRENT_DATE was therefore yesterday from midnight until 10am in Sydney, which is how
 * clockIn's "s.day = CURRENT_DATE" came to refuse every 06:30 start for the first ten hours of the day.
 * Naming the zone in the statement is the only version that survives the pooler, so please don't shorten it
 * back to CURRENT_DATE — it will look fine every afternoon and be wrong every morning.
 */
export const siteToday = (tz: SiteTz = APP_TZ) => sql`(now() AT TIME ZONE ${tz})::date`;

/**
 * The real instant a bare day + time lands on at a site:
 * `${siteMoment(sql`s.day + s.start_time`, sql`p.tz`)} > now()`.
 *
 * `s.day + s.start_time` is a timestamp with no zone in it, so comparing it to now() lets Postgres read it in
 * the session zone — GMT, per siteToday — and a 6:30am Sydney start then looks ten hours later than it is.
 * That is how "starts soon" came to turn orange the evening before and say nothing at 3:30am, when it was
 * true, and how the matching cron kept widening shifts that had already begun.
 */
export const siteMoment = (local: Fragment, tz: SiteTz = APP_TZ) => sql`((${local}) AT TIME ZONE ${tz})`;
