/**
 * The site clock, guarded at the source.
 *
 * lib/db.ts asks Postgres for TimeZone = Australia/Sydney as a connection startup parameter. DATABASE_URL
 * points at Neon's pooler, and PgBouncer drops it: on the live database `current_setting('TimeZone')` answers
 * **GMT** and `pg_settings` calls it a default nobody set. So `CURRENT_DATE` in SQL was the *previous* day for
 * the first ten hours of every Sydney day, and `clockIn`'s `s.day = CURRENT_DATE` refused every clock-in on a
 * morning shift — while the app's own default start is 06:30.
 *
 * The fix was to stop asking the connection what day it is and name the zone in the statement
 * (lib/siteClock.ts, migration 020's `projects.tz`). This test is what stops it coming back. `CURRENT_DATE`
 * reads as the obvious, tidy thing to write; it looks right every afternoon and is wrong every morning, which
 * is precisely the sort of bug that survives review and a day of manual testing.
 *
 * `ALTER DATABASE neondb SET TimeZone` is NOT a fix and must not be treated as one: it was applied on
 * 2026-09-22 and the session still reported GMT, because the pooler holds server connections that predate it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SKIP = new Set(["node_modules", ".next", ".git", "dist", "coverage"]);

const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory()
    ? (SKIP.has(e.name) ? [] : walk(path.join(d, e.name)))
    : /\.(tsx?|sql)$/.test(e.name) ? [path.join(d, e.name)] : []));

/**
 * `db` is in this list, and was not at first — which is exactly how it hid two live instances of the bug
 * this test exists to catch. `worker_stats` in db/schema.sql counted a shift as past on a bare CURRENT_DATE,
 * and that view is what lib/matching.ts ranks people on: for the ten hours a day the pooler's GMT session
 * ran behind Sydney, a worker's turn-up score was computed against the wrong day. The suite was green over
 * it the whole time, because the walk only ever looked at TypeScript.
 */
const FILES = ["app", "actions", "lib", "components", "db"].filter(fs.existsSync).flatMap(walk);

/** lib/siteClock.ts explains the ban and has to quote the word to do it. */
const ALLOWED = new Set([path.normalize("lib/siteClock.ts")]);

/**
 * A line of source with its comments taken out. `CURRENT_DATE` is fine in prose — several files explain the
 * bug — so only what Postgres would actually receive is searched.
 */
const stripComments = (src: string, sql: boolean): string => {
  const out = src
    .replace(/\/\*[\s\S]*?\*\//g, "")        // block comments, including the JSDoc the explanations live in
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");   // line comments, but not the // in a URL
  // `--` runs to end of line in SQL, and only in SQL. Doing it to a .ts file would eat everything after a
  // decrement, so a .sql file gets the real rule and a TypeScript one only gets `--` where it already sits
  // alone on a line — which is how a SQL comment is written inside a template literal.
  return sql ? out.replace(/--[^\n]*/g, "") : out.replace(/^\s*--[^\n]*$/gm, "");
};

describe("nothing asks the connection what day it is", () => {
  it("the walk really found the app", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.some((f) => path.normalize(f) === path.normalize("lib/siteClock.ts"))).toBe(true);
  });

  it("no SQL anywhere uses a bare CURRENT_DATE", () => {
    const offenders = FILES
      .filter((f) => !ALLOWED.has(path.normalize(f)))
      .filter((f) => /\bCURRENT_DATE\b/.test(stripComments(fs.readFileSync(f, "utf8"), f.endsWith(".sql"))))
      .map((f) => `${f} — use siteToday(sql\`p.tz\`) where a site is joined, siteToday() otherwise`);
    expect(offenders).toEqual([]);
  });

  /**
   * The subtler half of the same bug. `s.day + s.start_time` is a timestamp with no zone in it; comparing it
   * to now() lets Postgres read it in the session zone, which is GMT. That is how "starts soon" turned orange
   * the evening before and said nothing at 3:30am, when it was true.
   */
  it("no SQL compares a bare day + start_time against now() without naming a zone", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      if (ALLOWED.has(path.normalize(f))) continue;
      const src = stripComments(fs.readFileSync(f, "utf8"), f.endsWith(".sql"));
      for (const m of src.matchAll(/([\w.]+\.day\s*\+\s*[\w.]*start_time)/g)) {
        const around = src.slice(Math.max(0, m.index - 120), m.index + 200);
        // Either the helper wrapped it, or the statement says AT TIME ZONE itself.
        if (/siteMoment|AT TIME ZONE/.test(around)) continue;
        offenders.push(`${f} — "${m[1]}" is a naive timestamp; wrap it in siteMoment(...)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a migration gave every site its own clock, and a way to tell a guess from an answer", () => {
    const sql = fs.readFileSync(path.join("db", "migrations", "020_site_clock.sql"), "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS tz text/);
    // tz_auto is why re-running the migration cannot overrule a boss who chose their own zone: db/migrate.ts
    // re-applies every file, and the backfill would otherwise reset anyone whose answer matched the default.
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS tz_auto boolean/);
    expect(sql).toMatch(/WHERE tz_auto/);
  });
});
