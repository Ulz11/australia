/**
 * The White Card re-check queue, against a real DB (needs DATABASE_URL, and a seeded DB for the last test).
 *
 * Runs the real saveLicence, recheckLicences and cron route on its own +614000095xx fixture workers,
 * and cleans up after itself. The register is always stubbed (fake host, stubbed fetch): no test here
 * may spend a real call against the 2,500-a-month quota.
 *
 * Sharing the database with files running in parallel:
 *  - the app's daily register budget (`whitecard:all`) is counted exactly by tests/integration/licences.test.ts,
 *    so in this file that one key is an in-memory counter — every other key (the per-worker save cap) is real;
 *  - the cron route's matching and alert delivery are stubbed, so calling the route here can neither
 *    widen another file's shifts nor claim another file's notifications.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import postgres from "postgres";

const budget = vi.hoisted(() => ({ room: true, asked: 0, resumeAt: null as Date | null }));
vi.mock("@/lib/ratelimit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ratelimit")>();
  const DAY_BUDGET = "whitecard:all";
  return {
    ...real,
    hit: (key: string, limit: number, win: number) => (key === DAY_BUDGET ? Promise.resolve((budget.asked++, budget.room)) : real.hit(key, limit, win)),
    refund: (key: string, win: number) => (key === DAY_BUDGET ? Promise.resolve() : real.refund(key, win)),
    windowEndsAt: (key: string, win: number) => (key === DAY_BUDGET ? Promise.resolve(budget.resumeAt) : real.windowEndsAt(key, win)),
  };
});
const cronHooks = vi.hoisted(() => ({ onDeliver: null as null | (() => Promise<void>) }));
vi.mock("@/lib/matching", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/matching")>()),
  expandStaleShifts: async () => ({ expanded: 0 }),
}));
vi.mock("@/lib/alerts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/alerts")>()),
  deliverAlerts: async () => { await cronHooks.onDeliver?.(); return { claimed: 0, push: 0, sms: 0, expired: 0, gone: 0 }; },
}));

import { saveLicence, removeLicence } from "@/actions/worker";
import { sql } from "@/lib/db";
import { recomputeTickets } from "@/lib/booking";
import { resetWhitecardToken } from "@/lib/whitecard";
import {
  recheckLicences, RECHECK_BACKOFF_MIN, RECHECK_FIRST_MIN, RECHECK_LEASE_MIN, CAP_WAIT_MIN, VERIFIED_ALERT,
} from "@/lib/licenceRecheck";
import { GET as cron } from "@/app/api/cron/expand/route";

const PHONES = ["+61400009521", "+61400009522", "+61400009523"];   // 95xx: 96xx is licences.test, 97xx–98xx otp.test, 99xx alerts/bugs
const NAME = "Test Recheck Fixture";
const NUMBERS = ["CIC0000721", "CIC0000722", "CIC0000723"];
const REGISTER_NAME = "FIXTURE, Test Recheck";      // how the register spells our worker: a match, but never stored or sent
const STRANGER = "Somebody Else";
const NOTHING = { claimed: 0, verified: 0, not_found: 0, expired: 0, mismatch: 0, retrying: 0, gave_up: 0, cap_deferred: 0 };

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const down = () => json(503, { message: "Your API quota or rate limit has been exceeded" });
const card = (licenceNumber: string, over: Record<string, unknown> = {}) => ({
  licenceID: "1", licenceNumber, status: "Current", licenceType: "General Construction Induction Training Card", licenceName: null,
  licensee: REGISTER_NAME, startDate: "01/07/2023", expiryDate: "30/06/2028", refusedDate: "N/A",
  address: "12 Nowhere Lane", suburb: "MARRICKVILLE", postcode: "2204", ...over,
});

/** Every card number the stubbed register was asked about, in order. */
const asked: string[] = [];
const stubRegister = (verify: (number: string) => Response | Promise<Response>) => {
  const spy = vi.fn(async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname.includes("/accesstoken")) return json(200, { access_token: "T1", token_type: "BearerToken", expires_in: "1799" });
    const n = u.searchParams.get("licenceNumber") ?? "";
    asked.push(n);
    return verify(n);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
};
const nswKeys = () => {
  vi.stubEnv("WHITE_CARD_API_KEY", "test-key");
  vi.stubEnv("WHITE_CARD_API_SECRET", "test-secret");
  vi.stubEnv("WHITE_CARD_AUTH_HEADER", "");
  vi.stubEnv("WHITE_CARD_BASE_URL", "https://whitecard.test.invalid");
};

describe.skipIf(!process.env.DATABASE_URL)("re-checking White Cards the register couldn't answer for", () => {
  const savedUser = process.env.TEST_USER_ID;
  const ids: string[] = [];
  let logged: string[] = [];

  /** Save a card as worker `who`, with a fresh hourly allowance so a test can save as often as it needs. */
  const save = async (who: number, over: Record<string, string> = {}) => {
    process.env.TEST_USER_ID = ids[who];
    await sql`DELETE FROM rate_limits WHERE key = ${`licence-save:${ids[who]}`}`;
    return saveLicence(fd({ kind: "WC", number: NUMBERS[who], issued_state: "NSW", holder_name: NAME, ...over }));
  };
  /** A NSW White Card saved while the register is down: exactly how a card joins the queue for real. */
  const saveWhileDown = async (who: number) => {
    stubRegister(down);
    expect(await save(who)).toMatchObject({ ok: true, status: "unchecked" });
    asked.length = 0;
  };
  /** Bring queued cards due now, instead of waiting minutes for them. */
  const due = (...who: number[]) => sql`
    UPDATE licences SET recheck_at = now() - interval '1 second'
    WHERE worker_id = ANY(${(who.length ? who : [0, 1, 2]).map((i) => ids[i])}) AND recheck_at IS NOT NULL`;
  const row = async (who: number) => (await sql`
    SELECT id, number, holder_name, status, checked_at, checked_via, check_note, expires_on::text AS expires_on, check_attempts, recheck_at,
      (EXTRACT(EPOCH FROM (recheck_at - now())) / 60)::float8 AS mins
    FROM licences WHERE worker_id = ${ids[who]} AND kind = 'WC'`)[0];
  const alertsFor = (who: number) => sql<{ body: string }[]>`SELECT body FROM notifications WHERE user_id = ${ids[who]} AND kind = 'licence_check'`;
  const ticketsOf = async (who: number) => (await sql`SELECT tickets FROM workers WHERE user_id = ${ids[who]}`)[0].tickets as string[];

  const clean = async () => {
    await sql`DELETE FROM rate_limits WHERE key IN (SELECT 'licence-save:' || id FROM users WHERE phone = ANY(${PHONES}))`;
    await sql`DELETE FROM users WHERE phone = ANY(${PHONES})`;                       // workers, licences, notifications cascade
  };

  beforeAll(async () => {
    await clean();
    for (const [i, phone] of PHONES.entries()) {
      const [u] = await sql<{ id: string }[]>`INSERT INTO users (phone, name, role) VALUES (${phone}, ${NAME}, 'worker') RETURNING id`;
      await sql`INSERT INTO workers (user_id, invite_code) VALUES (${u.id}, ${`TSTRC${i}` + u.id.slice(0, 6)})`;
      ids.push(u.id);
    }
  });
  beforeEach(async () => {
    resetWhitecardToken();
    nswKeys();
    Object.assign(budget, { room: true, asked: 0, resumeAt: null });
    asked.length = 0;
    cronHooks.onDeliver = null;
    logged = [];
    for (const level of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logged.push(a.map((x) => (x instanceof Error ? x.message : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); });
    await sql`DELETE FROM licences WHERE worker_id = ANY(${ids})`;
    await sql`DELETE FROM notifications WHERE user_id = ANY(${ids})`;
    await sql`UPDATE workers SET tickets = '{}' WHERE user_id = ANY(${ids})`;
  });
  afterEach(() => {
    try {
      // Nothing on this path may write a card number, a name, or what the register said to a log.
      const all = logged.join("\n");
      for (const secret of [...NUMBERS, "CIC0000799", NAME, REGISTER_NAME, STRANGER, "Nowhere Lane"]) expect(all).not.toContain(secret);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });
  afterAll(async () => {
    await clean();
    if (savedUser) process.env.TEST_USER_ID = savedUser; else delete process.env.TEST_USER_ID;
    await sql.end();
  });

  it("only a check that couldn't complete joins the queue, and any other save takes the card off it", async () => {
    // Register down: queued about five minutes out, from zero attempts.
    await saveWhileDown(0);
    let r = await row(0);
    expect(r).toMatchObject({ status: "unchecked", checked_via: "manual", check_attempts: 0, checked_at: null });
    expect(r.check_note).toMatch(/by hand/);
    expect(r.mins).toBeGreaterThan(RECHECK_FIRST_MIN - 0.5);
    expect(r.mins).toBeLessThanOrEqual(RECHECK_FIRST_MIN);

    // The token service failing is the same: we never got an answer.
    await sql`UPDATE licences SET recheck_at = NULL, check_attempts = 4 WHERE worker_id = ${ids[0]}`;
    vi.stubGlobal("fetch", vi.fn(async () => json(500, { error: "token service down" })));
    resetWhitecardToken();
    expect(await save(0)).toMatchObject({ ok: true, status: "unchecked" });
    r = await row(0);
    expect(r.recheck_at).not.toBeNull();
    expect(r.check_attempts).toBe(0);                                             // a save always starts the count again

    // A real answer — even a bad one — clears it.
    await sql`UPDATE licences SET check_attempts = 4 WHERE worker_id = ${ids[0]}`;
    stubRegister(() => json(200, []));
    expect(await save(0)).toMatchObject({ ok: true, status: "not_found" });
    expect(await row(0)).toMatchObject({ status: "not_found", recheck_at: null, check_attempts: 0 });

    // So does saving it as another state's card, which no register of ours can check.
    await saveWhileDown(0);
    expect((await row(0)).recheck_at).not.toBeNull();
    const spy = stubRegister(down);
    expect(await save(0, { issued_state: "VIC", number: "VIC-721" })).toMatchObject({ ok: true, status: "unchecked" });
    expect(await row(0)).toMatchObject({ recheck_at: null, check_attempts: 0 });
    expect(spy).not.toHaveBeenCalled();

    // A high risk work licence isn't on that register: never asked, never queued.
    expect(await save(0, { kind: "LF", number: "LF-721" })).toMatchObject({ ok: true, status: "unchecked" });
    const [lf] = await sql`SELECT recheck_at, check_attempts FROM licences WHERE worker_id = ${ids[0]} AND kind = 'LF'`;
    expect(lf).toEqual({ recheck_at: null, check_attempts: 0 });
    expect(spy).not.toHaveBeenCalled();

    // Without keys there's nothing to retry with.
    vi.stubEnv("WHITE_CARD_API_KEY", "");
    vi.stubEnv("WHITE_CARD_API_SECRET", "");
    expect(await save(1)).toMatchObject({ ok: true, status: "unchecked" });
    expect((await row(1)).recheck_at).toBeNull();
    nswKeys();

    // At the app's daily ceiling nothing is asked — but the card is queued, not forgotten.
    budget.room = false;
    expect(await save(2)).toMatchObject({ ok: true, status: "unchecked" });
    expect(spy).not.toHaveBeenCalled();
    r = await row(2);
    expect(r.check_attempts).toBe(0);
    expect(r.mins).toBeGreaterThan(RECHECK_FIRST_MIN - 0.5);
  });

  it("a re-check that gets through is written like a save, recomputes tickets and tells the worker once", async () => {
    await saveWhileDown(0);
    await sql`UPDATE workers SET tickets = '{}' WHERE user_id = ${ids[0]}`;      // only the re-check can put WC back
    await due(0);
    stubRegister((n) => json(200, [card(n)]));

    expect(await recheckLicences()).toEqual({ ...NOTHING, claimed: 1, verified: 1 });
    expect(asked).toEqual([NUMBERS[0]]);
    const r = await row(0);
    expect(r).toMatchObject({
      status: "verified", checked_via: "safework_nsw", check_note: "Checked against the SafeWork NSW register.",
      expires_on: "2028-06-30", holder_name: NAME, check_attempts: 0, recheck_at: null,
    });
    expect(r.checked_at).not.toBeNull();
    expect(await ticketsOf(0)).toEqual(["WC"]);

    const alerts = await alertsFor(0);
    expect(alerts.map((a) => a.body)).toEqual([VERIFIED_ALERT]);
    expect(alerts[0].body).not.toContain(NUMBERS[0]);
    expect(alerts[0].body).not.toMatch(/fixture/i);

    expect(await recheckLicences()).toEqual(NOTHING);                            // off the queue: nothing more to ask
    expect(await alertsFor(0)).toHaveLength(1);
  });

  it("an answer that isn't good news uses the words a save would show — never the register's name or the number", async () => {
    for (const who of [0, 1, 2]) await saveWhileDown(who);
    expect(await ticketsOf(0)).toEqual(["WC"]);                                   // an unchecked card counts for matching
    await due();
    stubRegister((n) =>
      n === NUMBERS[0] ? json(200, [card(n, { licensee: STRANGER })])
      : n === NUMBERS[1] ? json(200, [])
      : json(200, [card(n, { status: "Expired", expiryDate: "01/08/2024" })]));

    expect(await recheckLicences()).toEqual({ ...NOTHING, claimed: 3, mismatch: 1, not_found: 1, expired: 1 });
    const want = [
      [0, "mismatch", "SafeWork NSW has that number under a different name. Check the number printed on the card."],
      [1, "not_found", "SafeWork NSW has no White Card with that number."],
      [2, "expired", "SafeWork NSW shows this card expired on 2024-08-01."],
    ] as const;
    for (const [who, status, note] of want) {
      const r = await row(who);
      expect(r).toMatchObject({ status, check_note: note, holder_name: NAME, recheck_at: null, checked_via: "safework_nsw" });
      const alerts = await alertsFor(who);
      expect(alerts.map((a) => a.body)).toEqual([note]);
      for (const secret of [NUMBERS[who], STRANGER, "Somebody", REGISTER_NAME]) expect(alerts[0].body).not.toContain(secret);
      expect(await ticketsOf(who)).toEqual([]);                                   // a failed White Card no longer matches shifts
    }
  });

  it("a register that is still down costs an attempt and backs off — and after the last step, a person takes it", async () => {
    await saveWhileDown(0);
    stubRegister(down);
    for (const [i, wait] of RECHECK_BACKOFF_MIN.entries()) {
      await due(0);
      expect(await recheckLicences(), `re-check ${i + 1}`).toEqual({ ...NOTHING, claimed: 1, retrying: 1 });
      const r = await row(0);
      expect(r).toMatchObject({ status: "unchecked", checked_at: null, check_attempts: i + 1 });
      expect(r.mins, `wait after re-check ${i + 1}`).toBeGreaterThan(wait - 1);
      expect(r.mins).toBeLessThanOrEqual(wait);
    }
    expect(RECHECK_BACKOFF_MIN).toEqual([15, 60, 180, 360, 720, 1440]);

    await due(0);
    expect(await recheckLicences()).toEqual({ ...NOTHING, claimed: 1, gave_up: 1 });
    const r = await row(0);
    expect(r).toMatchObject({ status: "unchecked", checked_via: "manual", checked_at: null, recheck_at: null, check_attempts: RECHECK_BACKOFF_MIN.length + 1 });
    expect(r.check_note).toMatch(/by hand/);
    expect(asked).toHaveLength(RECHECK_BACKOFF_MIN.length + 1);                  // one call a try, and no more
    expect(await alertsFor(0)).toHaveLength(0);

    await due(0);                                                                 // off the queue: nothing brings it back
    expect(await recheckLicences()).toEqual(NOTHING);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM licences WHERE worker_id = ${ids[0]} AND status = 'unchecked' AND recheck_at IS NULL`;
    expect(n).toBe(1);                                                            // what the control room counts as "to check by hand"
  });

  it("a budget refusal asks nothing, costs no attempt, and waits for the budget to come back", async () => {
    await saveWhileDown(0);
    await saveWhileDown(1);
    await sql`UPDATE licences SET check_attempts = 2 WHERE worker_id = ANY(${ids.slice(0, 2)})`;
    await due(0, 1);
    Object.assign(budget, { room: false, asked: 0, resumeAt: new Date(Date.now() + 20 * 3_600_000) });
    const spy = stubRegister((n) => json(200, [card(n)]));

    expect(await recheckLicences()).toEqual({ ...NOTHING, claimed: 2, cap_deferred: 2 });
    expect(spy).not.toHaveBeenCalled();                                           // no token call, no verify call
    expect(budget.asked).toBe(1);                                                 // one refusal answers for the whole run
    for (const who of [0, 1]) {
      const r = await row(who);
      expect(r).toMatchObject({ status: "unchecked", check_attempts: 2 });
      expect(r.mins).toBeGreaterThan(20 * 60 - 1);                                // parked until the day's window rolls over
      expect(r.mins).toBeLessThanOrEqual(20 * 60);
    }

    // A window about to roll over (or none at all) still doesn't bring it straight back.
    budget.resumeAt = null;
    await due(0, 1);
    expect(await recheckLicences()).toEqual({ ...NOTHING, claimed: 2, cap_deferred: 2 });
    for (const who of [0, 1]) {
      const r = await row(who);
      expect(r.check_attempts).toBe(2);
      expect(r.mins).toBeGreaterThan(CAP_WAIT_MIN - 1);
      expect(r.mins).toBeLessThanOrEqual(CAP_WAIT_MIN);
    }
    expect(spy).not.toHaveBeenCalled();

    // Budget back, register down: now an attempt is spent, from where the count was.
    budget.room = true;
    stubRegister(down);
    await due(0, 1);
    expect(await recheckLicences()).toEqual({ ...NOTHING, claimed: 2, retrying: 2 });
    for (const who of [0, 1]) expect((await row(who)).check_attempts).toBe(3);
  });

  it("an answer about a card the worker changed or removed while we asked is dropped", async () => {
    const edits: [string, () => Promise<unknown>, (r: Record<string, unknown> | undefined) => void][] = [
      ["a new number", () => save(0, { number: "CIC0000799" }),
        (r) => expect(r).toMatchObject({ number: "CIC0000799", status: "unchecked", check_attempts: 0 })],
      ["a different name on the card", () => save(0, { holder_name: "Test Recheck Fixture Junior" }),
        (r) => expect(r).toMatchObject({ holder_name: "Test Recheck Fixture Junior", status: "unchecked" })],
      ["the card removed", async () => { process.env.TEST_USER_ID = ids[0]; await removeLicence("WC"); },
        (r) => expect(r).toBeUndefined()],
    ];
    for (const [what, edit, then] of edits) {
      await sql`DELETE FROM licences WHERE worker_id = ${ids[0]}`;
      await saveWhileDown(0);
      await due(0);
      let inFlight = false, leased = 0;
      stubRegister(async (n) => {
        if (inFlight) return down();                                              // the edit's own check doesn't get through either
        inFlight = true;
        leased = (await row(0)).mins;
        await edit();
        return json(200, [card(n)]);                                              // good news, for a card that is no longer there
      });

      expect(await recheckLicences(), what).toEqual({ ...NOTHING, claimed: 1 });
      expect(leased, what).toBeGreaterThan(RECHECK_LEASE_MIN - 1);                // claimed cards are out of reach while we ask
      then(await row(0));
      expect(await alertsFor(0), what).toHaveLength(0);
    }

    // The same card saved again, and that save got a real answer first: the queue is empty, so ours is stale too.
    await sql`DELETE FROM licences WHERE worker_id = ${ids[0]}`;
    await saveWhileDown(0);
    await due(0);
    let first = true;
    stubRegister(async (n) => {
      if (!first) return json(200, []);
      first = false;
      expect(await save(0)).toMatchObject({ ok: true, status: "not_found" });
      return json(200, [card(n)]);
    });
    expect(await recheckLicences()).toEqual({ ...NOTHING, claimed: 1 });
    expect(await row(0)).toMatchObject({ status: "not_found", recheck_at: null });
    expect(await alertsFor(0)).toHaveLength(0);
  });

  it("two runs at once never ask about the same card, and a card someone else holds is skipped, not waited on", async () => {
    for (const who of [0, 1, 2]) await saveWhileDown(who);
    await due();

    // Another connection holds one card: the run takes the other two and doesn't block.
    const other = postgres(process.env.DATABASE_URL!, { ssl: "require", max: 1 });
    try {
      stubRegister(() => json(200, []));
      await other.begin(async (tx) => {
        await tx`SELECT id FROM licences WHERE worker_id = ${ids[2]} FOR UPDATE`;
        expect(await recheckLicences()).toEqual({ ...NOTHING, claimed: 2, not_found: 2 });
      });
    } finally {
      await other.end();
    }
    expect(asked.sort()).toEqual([NUMBERS[0], NUMBERS[1]]);
    expect((await row(2)).status).toBe("unchecked");

    // Put all three back on the queue and race two runs, each allowed two cards.
    await saveWhileDown(0);
    await saveWhileDown(1);
    await due();
    await sql`DELETE FROM notifications WHERE user_id = ANY(${ids})`;
    stubRegister(async () => { await new Promise((ok) => setTimeout(ok, 30)); return json(200, []); });
    const [a, b] = await Promise.all([recheckLicences(2), recheckLicences(2)]);

    expect(a.claimed + b.claimed).toBe(3);
    expect(a.not_found + b.not_found).toBe(3);
    expect([...asked].sort()).toEqual([...NUMBERS].sort());                        // each card asked about exactly once
    for (const who of [0, 1, 2]) expect(await alertsFor(who), `worker ${who}`).toHaveLength(1);
  });

  it("the cron route reports counts only, and delivers the result in the same run", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret-for-recheck");
    for (const k of ["QPAY_USERNAME", "QPAY_PASSWORD", "QPAY_INVOICE_CODE"]) vi.stubEnv(k, "");
    await saveWhileDown(0);
    await due(0);
    const { id } = await row(0);
    stubRegister((n) => json(200, [card(n, { licensee: STRANGER })]));
    let atDelivery = -1;
    cronHooks.onDeliver = async () => { atDelivery = (await alertsFor(0)).length; };
    const call = (secret: string) => cron(new Request("http://localhost/api/cron/expand", { headers: { authorization: `Bearer ${secret}` } }));

    expect((await call("not-the-secret-at-all-no")).status).toBe(401);
    expect(asked).toHaveLength(0);                                                // a stranger can't make us spend the quota

    const res = await call("test-cron-secret-for-recheck");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).licences).toEqual({ ...NOTHING, claimed: 1, mismatch: 1 });
    expect(atDelivery).toBe(1);                                                   // the alert existed before delivery ran
    for (const secret of [NUMBERS[0], NAME, STRANGER, ids[0], id]) expect(text).not.toContain(secret);
    expect((await row(0)).status).toBe("mismatch");
  });

  it("seeded demo cards claim no check and aren't queued, and the demo worker still holds his White Card", async () => {
    const demo = await sql`
      SELECT u.phone, l.kind, l.status, l.checked_at, l.checked_via, l.check_note, l.recheck_at
      FROM licences l JOIN users u ON u.id = l.worker_id WHERE u.phone LIKE '+61400000___'`;
    expect(demo.length, "seed the database first: npm run db:seed").toBeGreaterThan(0);
    expect(demo.filter((c) => c.status === "verified")).toEqual([]);
    expect(demo.filter((c) => c.checked_via === "safework_nsw")).toEqual([]);   // no register was asked about a demo number
    expect(demo.filter((c) => c.recheck_at !== null)).toEqual([]);              // and the cron never will be

    const bat = demo.filter((c) => c.phone === "+61400000101");
    expect(bat.map((c) => c.kind).sort()).toEqual(["LF", "WC"]);
    for (const c of bat) expect(c).toMatchObject({ status: "unchecked", checked_at: null, checked_via: null, check_note: null, recheck_at: null });

    const [{ id, tickets }] = await sql`SELECT u.id, w.tickets FROM users u JOIN workers w ON w.user_id = u.id WHERE u.phone = '+61400000101'`;
    expect(tickets).toContain("WC");
    // And what the ticket rule itself derives from those unchecked cards — rolled back, the seed is shared.
    let derived: string[] = [];
    await sql.begin(async (tx) => {
      await recomputeTickets(id, tx);
      derived = (await tx`SELECT tickets FROM workers WHERE user_id = ${id}`)[0].tickets;
      throw new Error("rollback");
    }).catch((e) => { if ((e as Error).message !== "rollback") throw e; });
    expect(derived).toEqual(["LF", "WC"]);
  });
});
