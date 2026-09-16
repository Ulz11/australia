import postgres from "postgres";

declare global {
  var __sql: ReturnType<typeof postgres> | undefined;
  var __warmed: boolean | undefined;
}

type Env = Record<string, string | undefined>;

/** Vercel sets VERCEL=1 at build time and at runtime. Anywhere else this is a long-lived server. */
const onVercel = (env: Env = process.env) => env.VERCEL === "1";

/**
 * How long connections live, by where the process runs.
 *
 * A long-lived server (`next start`, `next dev`) keeps its two connections for good: a fresh TLS
 * handshake to Neon costs ~2 s, so they never idle-close and are warmed at boot.
 *
 * Vercel's Fluid compute is different: an instance with no requests is suspended, and a socket left
 * open across a suspension is one Neon may already have dropped. So there, idle connections close
 * after 15 s and every connection is replaced within 5 min. (@vercel/functions' attachDatabasePool
 * would keep the instance alive until the pool is idle, but it only understands pools with a
 * 'release' event — pg, mysql2, mariadb — and throws "Unsupported database pool type" for postgres.js.)
 */
export function poolOptions(env: Env = process.env) {
  const vercel = onVercel(env);
  return {
    idle_timeout: vercel ? 15 : 0,             // seconds; 0 = never idle-close
    max_lifetime: vercel ? 60 * 5 : 60 * 30,   // seconds
    // No named prepared statements through Neon's pooler. PgBouncer keeps prepared plans on its server
    // connections keyed by query text, so after a migration adds a column, a `SELECT s.*` planned before it
    // fails with "cached plan must not change result type" — and postgres.js's one retry lands on the same
    // stale plan. Unnamed statements are re-planned every time: a little planning cost, no stale plans.
    prepare: !vercel,
  };
}

/**
 * One pool for the whole process. Rules that keep taps fast:
 *  - on a long-lived server, connections never idle-close (see poolOptions for Vercel)
 *  - independent queries on a page are issued together (Promise.all) → they pipeline into one round trip
 *  - an action is one statement where possible (CTEs), never a chain of awaits
 */
export const sql =
  global.__sql ??
  postgres(process.env.DATABASE_URL!, {
    ssl: "require",
    max: 2,                   // queries pipeline on a connection; few connections = statements get prepared once, fast
    ...poolOptions(),
    connect_timeout: 10,
    transform: { undefined: null },
    types: { date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x } },
    connection: { TimeZone: process.env.APP_TZ || "Australia/Sydney" },
  });

if (process.env.NODE_ENV !== "production") global.__sql = sql;

// Warm two connections at boot so the first tap doesn't pay for the handshake — on a long-lived server only.
// On Vercel it would be wasted (the instance may be suspended before anyone taps) and it would run during
// the build too, so it's skipped there entirely: nothing at import time can throw or hold the process open.
if (!onVercel() && !global.__warmed) {
  global.__warmed = true;
  Promise.all([sql`select 1`, sql`select 1`]).catch(() => {});
}
