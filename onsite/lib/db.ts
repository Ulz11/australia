import postgres from "postgres";

declare global {
  // eslint-disable-next-line no-var
  var __sql: ReturnType<typeof postgres> | undefined;
}

/**
 * One warm pool for the whole process. Rules that keep taps fast:
 *  - connections never idle-close (a fresh TLS handshake to Neon costs ~2 s)
 *  - independent queries on a page are issued together (Promise.all) → they pipeline into one round trip
 *  - an action is one statement where possible (CTEs), never a chain of awaits
 */
export const sql =
  global.__sql ??
  postgres(process.env.DATABASE_URL!, {
    ssl: "require",
    max: 2,                   // queries pipeline on a connection; few connections = statements get prepared once, fast
    idle_timeout: 0,          // keep warm
    max_lifetime: 60 * 30,
    connect_timeout: 10,
    prepare: true,
    transform: { undefined: null },
    types: { date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x } },
    connection: { TimeZone: process.env.APP_TZ || "Australia/Sydney" },
  });

if (process.env.NODE_ENV !== "production") global.__sql = sql;

// Warm two connections at boot so the first tap doesn't pay for the handshake.
if (!global.__warmed) {
  global.__warmed = true;
  Promise.all([sql`select 1`, sql`select 1`]).catch(() => {});
}
declare global { // eslint-disable-next-line no-var
  var __warmed: boolean | undefined; }
