/**
 * Which language a request is in, and what that changes (lib/i18n/server.ts, actions/lang.ts).
 * Against a real DB (needs DATABASE_URL). Own +614000079xx numbers, self-cleaning.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

const jar = vi.hoisted(() => {
  const store = new Map<string, string>();
  const name = (a: string | { name: string }) => (typeof a === "string" ? a : a.name);
  return {
    store,
    get: (n: string) => (store.has(n) ? { value: store.get(n)! } : undefined),
    set: vi.fn((a: string | { name: string; value: string }, v?: string) =>
      (typeof a === "string" ? store.set(a, v!) : store.set(a.name, a.value))),
    delete: vi.fn((a: string | { name: string }) => store.delete(name(a))),
  };
});
const head = vi.hoisted(() => ({ value: new Headers() }));
vi.mock("next/headers", () => ({ cookies: async () => jar, headers: async () => head.value }));

import { sql } from "@/lib/db";
import { LANG_COOKIE } from "@/lib/i18n";
import { setLanguage } from "@/actions/lang";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { remindShifts } from "@/lib/reminders";
import Login from "@/app/login/page";

const PHONES = { worker: "+61400007901", boss: "+61400007902", mate: "+61400007903" };
const ids: Record<string, string> = {};
let project = "";
const DAY = "2026-11-04";
const EVE = new Date("2026-11-03T07:20:00Z");               // 6:20pm Sydney the day before

/** getLang() is cached per React request, and there is no request here — so each case gets a fresh module. */
async function lang() {
  vi.resetModules();
  const mod = await import("@/lib/i18n/server");
  return mod.getLang();
}
async function t() {
  vi.resetModules();
  const mod = await import("@/lib/i18n/server");
  return mod.getT();
}

describe.skipIf(!process.env.DATABASE_URL)("languages", () => {
  const clean = async () => {
    await sql`DELETE FROM projects WHERE name = 'Language fixture site'`;
    await sql`DELETE FROM users WHERE phone = ANY(${Object.values(PHONES)})`;
  };

  beforeEach(async () => {
    await clean();
    jar.store.clear();
    head.value = new Headers();
    for (const [k, phone] of Object.entries(PHONES))
      ids[k] = (await sql`INSERT INTO users (phone, name, role, last_seen_at) VALUES (${phone}, ${`Lang ${k} fixture`}, ${k === "boss" ? "boss" : "worker"}, now()) RETURNING id`)[0].id;
    await sql`INSERT INTO bosses (user_id, company) VALUES (${ids.boss}, 'Language Fixtures')`;
    for (const k of ["worker", "mate"])
      await sql`INSERT INTO workers (user_id, home, home_label, radius_km, tickets, invite_code)
                VALUES (${ids[k]}, ST_SetSRID(ST_MakePoint(151.1400, -33.9000),4326)::geography, 'Dulwich Hill', 25, '{WC}', ${"LG" + k.slice(0, 4).toUpperCase()})`;
    const [p] = await sql`INSERT INTO projects (boss_id, name, address, location)
      VALUES (${ids.boss}, 'Language fixture site', 'Petersham', ST_SetSRID(ST_MakePoint(151.1550, -33.8935),4326)::geography) RETURNING id`;
    project = p.id;
  });
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => { await clean(); await sql.end(); });

  it("a signed-out visitor gets the cookie's language, then what their browser asked for, then English", async () => {
    expect(await lang()).toBe("en");
    head.value = new Headers({ "accept-language": "mn-MN,mn;q=0.9,en;q=0.8" });
    expect(await lang()).toBe("mn");
    jar.store.set(LANG_COOKIE, "ne");
    expect(await lang()).toBe("ne");                        // a choice beats a browser preference
    jar.store.set(LANG_COOKIE, "ar");                       // not a language OnSite has
    expect(await lang()).toBe("mn");
  });

  it("the login screen hands its client components the Mongolian dictionary, so the button is Mongolian", async () => {
    jar.store.set(LANG_COOKIE, "mn");
    const el = await Login({ searchParams: Promise.resolve({}) }) as { props: { lang: string; dict: Record<string, string> } };
    expect(el.props.lang).toBe("mn");
    expect(el.props.dict["Text me a code"]).toBe("Надад код илгээ");
    expect(el.props.dict["Get my code"]).toBe("Кодоо авах");
    expect((await t())("Sign in")).toBe("Нэвтрэх");
  });

  it("picking a language writes the cookie and, when signed in, the account", async () => {
    vi.stubEnv("TEST_USER_ID", ids.worker);
    await setLanguage("mn");
    expect(jar.store.get(LANG_COOKIE)).toBe("mn");
    expect((await sql`SELECT lang FROM users WHERE id = ${ids.worker}`)[0].lang).toBe("mn");
    await setLanguage("klingon");                           // not a language: nothing moves
    expect(jar.store.get(LANG_COOKIE)).toBe("mn");
    expect((await sql`SELECT lang FROM users WHERE id = ${ids.worker}`)[0].lang).toBe("mn");
  });

  it("a signed-in worker's own language follows them to a browser with no cookie", async () => {
    vi.stubEnv("TEST_USER_ID", "");
    await sql`UPDATE users SET lang = 'ne' WHERE id = ${ids.worker}`;
    await createSession(ids.worker, { via: "code" });
    expect(jar.store.has(SESSION_COOKIE)).toBe(true);
    expect(await lang()).toBe("ne");
  });

  it("a boss is English, whatever the cookie says — boss screens aren't translated", async () => {
    vi.stubEnv("TEST_USER_ID", "");
    await sql`UPDATE users SET lang = 'mn' WHERE id = ${ids.boss}`;
    await createSession(ids.boss, { via: "code" });
    jar.store.set(LANG_COOKIE, "mn");
    expect(await lang()).toBe("en");
  });

  it("a worker with lang=mn gets a Mongolian reminder, and their mate in English gets English", async () => {
    await sql`UPDATE users SET lang = 'mn' WHERE id = ${ids.worker}`;
    const [s] = await sql`INSERT INTO shifts (project_id, boss_id, day, start_time, hours, spots, role, tickets_required, rate)
      VALUES (${project}, ${ids.boss}, ${DAY}::date, '06:30', 8, 2, 'Steel fixer', '{WC}', 42) RETURNING id`;
    for (const k of ["worker", "mate"])
      await sql`INSERT INTO bookings (shift_id, worker_id, status) VALUES (${s.id}, ${ids[k]}, 'accepted')`;

    expect((await remindShifts(EVE)).eve).toBe(2);
    const [mon] = await sql`SELECT body FROM notifications WHERE user_id = ${ids.worker} AND kind = 'reminder_eve'`;
    const [eng] = await sql`SELECT body FROM notifications WHERE user_id = ${ids.mate} AND kind = 'reminder_eve'`;
    expect(mon.body).toMatch(/^Маргааш 6:30am · Language fixture site дээр Steel fixer · гэрээс [\d.]+ km$/);
    expect(eng.body).toMatch(/^Tomorrow 6:30am · Steel fixer at Language fixture site · [\d.]+ km from home$/);
  });
});
