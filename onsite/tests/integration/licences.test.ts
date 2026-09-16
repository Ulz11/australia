/**
 * Saving a card, under someone who is not saving cards.
 *
 * The form is the one door to a live government register: signed in, one worker, no CAPTCHA.
 * Without a cap it walks card numbers. Two caps guard it — ten saves an hour per worker, and the
 * whole app's WHITECARD_CHECKS_PER_DAY calls at the register — and both are counted in the same
 * `rate_limits` table. Runs the real action against a real DB (needs DATABASE_URL), on its own
 * +614000096xx fixture workers, and cleans up after itself. The register is always stubbed: no
 * test in this repo may spend a real call against a 2,500-a-month quota.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { saveLicence } from "@/actions/worker";
import { sql } from "@/lib/db";
import { LICENCE_SAVES_PER_HOUR } from "@/lib/ratelimit";
import { resetWhitecardToken, whitecardChecksPerDay } from "@/lib/whitecard";

const PHONE = "+61400009601";
const MATE_PHONE = "+61400009602";
const NAME = "Test Fixture";
/** The app-wide daily budget for register calls. This file owns it; everything else stays off it. */
const CHECKS = "whitecard:all";
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
/** A VIC card: saved and queued for a human, so the cap can be spent without asking NSW anything. */
const save = (number: string, over: Record<string, string> = {}) =>
  saveLicence(fd({ kind: "WC", number, issued_state: "VIC", holder_name: NAME, ...over }));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
/** The register, stubbed: a token, then whatever the test says. Nothing leaves this machine. */
const stubRegister = (verify: () => Response = () => json(200, [])) => {
  const spy = vi.fn(async (url: string | URL) =>
    String(url).includes("/accesstoken")
      ? json(200, { access_token: "T1", token_type: "BearerToken", expires_in: "1799" })
      : verify());
  vi.stubGlobal("fetch", spy);
  return spy;
};
/** Keys in place, so a NSW White Card is one the app would really go and check. */
const nswKeys = () => {
  vi.stubEnv("WHITE_CARD_API_KEY", "test-key");
  vi.stubEnv("WHITE_CARD_API_SECRET", "test-secret");
  vi.stubEnv("WHITE_CARD_AUTH_HEADER", "");
  vi.stubEnv("WHITE_CARD_BASE_URL", "https://whitecard.test.invalid");
};

describe.skipIf(!process.env.DATABASE_URL)("saving a card", () => {
  const saved = { user: process.env.TEST_USER_ID };
  let worker = "", mate = "";
  const key = () => `licence-save:${worker}`;
  const clean = async () => {
    await sql`DELETE FROM rate_limits WHERE key LIKE 'licence-save:%' OR key = ${CHECKS}`;
    await sql`DELETE FROM users WHERE phone = ANY(${[PHONE, MATE_PHONE]})`;   // licences and workers cascade
  };
  /** Put the day's counter at a known number of calls, so nothing here depends on what ran before. */
  const spent = (hits: number) => sql`
    INSERT INTO rate_limits (key, window_start, hits) VALUES (${CHECKS}, now(), ${hits})
    ON CONFLICT (key) DO UPDATE SET window_start = now(), hits = ${hits}`;
  const hitsToday = async () => (await sql<{ hits: number }[]>`SELECT hits FROM rate_limits WHERE key = ${CHECKS}`)[0]?.hits ?? 0;

  beforeAll(async () => {
    await clean();
    const fixture = async (phone: string, tag: string) => {
      const [u] = await sql<{ id: string }[]>`INSERT INTO users (phone, name, role) VALUES (${phone}, ${NAME}, 'worker') RETURNING id`;
      await sql`INSERT INTO workers (user_id, invite_code) VALUES (${u.id}, ${tag + u.id.slice(0, 6)})`;
      return u.id;
    };
    worker = await fixture(PHONE, "TSTLIC");
    mate = await fixture(MATE_PHONE, "TSTLIM");
    process.env.TEST_USER_ID = worker;                              // requireRole reads this instead of a cookie
  });
  beforeEach(async () => {
    resetWhitecardToken();                                          // a token one test cached must not hide another's login call
    process.env.TEST_USER_ID = worker;
    await sql`DELETE FROM rate_limits WHERE key LIKE 'licence-save:%'`;
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await sql`DELETE FROM rate_limits WHERE key = ${CHECKS}`;       // a shared counter: never leave ours behind
  });
  afterAll(async () => {
    await clean();
    if (saved.user) process.env.TEST_USER_ID = saved.user; else delete process.env.TEST_USER_ID;
    await sql.end();
  });

  it("takes a card, and keeps the worker's own name on it", async () => {
    const r = await save("VIC-1111");
    expect(r).toMatchObject({ ok: true, status: "unchecked" });
    const [row] = await sql`SELECT number, holder_name, status, checked_at FROM licences WHERE worker_id = ${worker} AND kind = 'WC'`;
    expect(row).toMatchObject({ number: "VIC-1111", holder_name: NAME, status: "unchecked" });
    expect(row.checked_at).toBeNull();                              // nothing was checked, so nothing says it was
  });

  it("ten card changes an hour, then a plain sentence — and the eleventh changes nothing", async () => {
    const results = [];
    for (let i = 0; i < LICENCE_SAVES_PER_HOUR; i++) results.push(await save(`VIC-${1000 + i}`));
    expect(results.filter((r) => r?.ok)).toHaveLength(LICENCE_SAVES_PER_HOUR);

    const over = await save("VIC-9999");
    expect(over).toEqual({ error: "Too many card changes for now — try again in an hour." });
    const [row] = await sql`SELECT number FROM licences WHERE worker_id = ${worker} AND kind = 'WC'`;
    expect(row.number).toBe(`VIC-${1000 + LICENCE_SAVES_PER_HOUR - 1}`);        // the refused save didn't land

    // An hour on, the same worker is welcome again.
    await sql`UPDATE rate_limits SET window_start = now() - interval '61 minutes' WHERE key = ${key()}`;
    expect(await save("VIC-2222")).toMatchObject({ ok: true });
  });

  it("a burst can't slip past the cap", async () => {
    const burst = await Promise.all(Array.from({ length: 25 }, (_, i) => save(`VIC-B${i}`)));
    expect(burst.filter((r) => r?.ok)).toHaveLength(LICENCE_SAVES_PER_HOUR);
    const [c] = await sql<{ hits: number }[]>`SELECT hits FROM rate_limits WHERE key = ${key()}`;
    expect(c.hits).toBe(25);                                        // every try counted, only ten were allowed
  });

  it("a refused save never asks the register anything", async () => {
    vi.stubEnv("WHITE_CARD_API_KEY", "test-key");
    vi.stubEnv("WHITE_CARD_API_SECRET", "test-secret");
    vi.stubEnv("WHITE_CARD_AUTH_HEADER", "");
    vi.stubEnv("WHITE_CARD_BASE_URL", "https://whitecard.test.invalid");
    const fetchSpy = vi.fn(async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await sql`INSERT INTO rate_limits (key, window_start, hits) VALUES (${key()}, now(), ${LICENCE_SAVES_PER_HOUR})
                ON CONFLICT (key) DO UPDATE SET window_start = now(), hits = ${LICENCE_SAVES_PER_HOUR}`;
      const r = await save("CIC1765241", { issued_state: "NSW" });  // the one shape that would go to SafeWork NSW
      expect(r).toEqual({ error: "Too many card changes for now — try again in an hour." });
      expect(fetchSpy).not.toHaveBeenCalled();                      // no token call, no verify call
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("at the app's daily ceiling the register is never asked, and the card waits for a human", async () => {
    nswKeys();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = stubRegister();
    await spent(whitecardChecksPerDay());                           // today's budget is gone
    const r = await save("CIC1765241", { issued_state: "NSW" });    // the one shape that would go to SafeWork NSW

    expect(r).toMatchObject({ ok: true, status: "unchecked", note: expect.stringMatching(/by hand/) });
    expect(fetchSpy).not.toHaveBeenCalled();                        // no token call, no verify call
    const [row] = await sql`SELECT status, checked_via, checked_at, check_note FROM licences WHERE worker_id = ${worker} AND kind = 'WC'`;
    expect(row).toMatchObject({ status: "unchecked", checked_via: "manual" });
    expect(row.checked_at).toBeNull();                              // nothing was checked, so nothing says it was
    expect(row.check_note).toMatch(/by hand/);                      // and never "not on the register": that's a red badge
    expect(quiet).toHaveBeenCalled();                               // a spent budget is in the log, not silent
  });

  it("the day's budget belongs to the app, not to each worker", async () => {
    nswKeys();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = stubRegister(() => json(200, []));             // checked, and the register has nothing
    vi.stubEnv("WHITECARD_CHECKS_PER_DAY", "1000000");              // room to spare: this half is about who pays
    await sql`DELETE FROM rate_limits WHERE key = ${CHECKS}`;

    expect(await save("CIC1765241", { issued_state: "NSW" })).toMatchObject({ ok: true, status: "not_found" });
    expect(fetchSpy).toHaveBeenCalled();                            // worker one's call went out
    const byWorkerOne = await hitsToday();
    expect(byWorkerOne).toBeGreaterThanOrEqual(1);

    // A different worker, with a fresh hourly allowance of their own — and the app's budget set to
    // exactly what worker one has already spent. One counter, so there is nothing left for them.
    vi.stubEnv("WHITECARD_CHECKS_PER_DAY", String(byWorkerOne));
    fetchSpy.mockClear();
    process.env.TEST_USER_ID = mate;
    const second = await save("CIC1765242", { issued_state: "NSW" });

    expect(second).toMatchObject({ ok: true, status: "unchecked", note: expect.stringMatching(/by hand/) });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await hitsToday()).toBe(byWorkerOne);                    // the call we refused to make cost the budget nothing
    expect(quiet).toHaveBeenCalled();
  });

  it("WHITECARD_CHECKS_PER_DAY is what decides, not the built-in 70", async () => {
    nswKeys();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = stubRegister(() => json(200, []));
    vi.stubEnv("WHITECARD_CHECKS_PER_DAY", "");
    expect(whitecardChecksPerDay()).toBe(70);                       // nothing set: ≈2,100 a month of the free 2,500
    vi.stubEnv("WHITECARD_CHECKS_PER_DAY", "5");
    expect(whitecardChecksPerDay()).toBe(5);

    await spent(5);                                                 // five calls today: room under 70, none under 5
    expect(await save("CIC1765243", { issued_state: "NSW" })).toMatchObject({ ok: true, status: "unchecked" });
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.stubEnv("WHITECARD_CHECKS_PER_DAY", "1000");                 // the same five calls, a bigger budget
    await spent(5);
    expect(await save("CIC1765244", { issued_state: "NSW" })).toMatchObject({ ok: true, status: "not_found" });
    expect(fetchSpy).toHaveBeenCalled();
    expect(quiet).toHaveBeenCalledTimes(1);                         // logged once, for the one call we refused
  });

  it("a card with no number is refused without spending an attempt", async () => {
    const r = await saveLicence(fd({ kind: "WC", number: "   ", issued_state: "VIC", holder_name: NAME }));
    expect(r).toEqual({ error: "Type the number printed on the card." });
    const [c] = await sql`SELECT hits FROM rate_limits WHERE key = ${key()}`;
    expect(c?.hits ?? 0).toBe(0);
  });
});
