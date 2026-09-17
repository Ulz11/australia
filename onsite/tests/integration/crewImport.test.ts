/**
 * A boss bringing their own crew (migration 019), through the real actions against a real DB
 * (needs DATABASE_URL). Own +614000083xx numbers, self-cleaning.
 *
 * The rule that matters most is the last one: a worker the boss brought themselves is never an introduction,
 * so importing your own crew can never cost you a match fee.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { sql } from "@/lib/db";
import * as boss from "@/actions/boss";
import { completeOnboarding } from "@/actions/auth";
import { leaveCrew } from "@/actions/worker";
import { bookWorker } from "@/lib/booking";
import { sweepCrewInvites } from "@/lib/crew";

const PHONES = {
  boss: "+61400008301", other: "+61400008302", known: "+61400008303",
  newbie: "+61400008304", linker: "+61400008305", stale: "+61400008306",
};
const ids: Record<string, string> = {};
const as = (id: string) => vi.stubEnv("TEST_USER_ID", id);
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
/** Every onboarding path ends in a redirect; this is where it went. */
const onboard = (form: FormData) => completeOnboarding(form).then(
  () => "no redirect",
  (e) => { const d = String((e as { digest?: string })?.digest ?? ""); if (!d.includes("NEXT_REDIRECT")) throw e; return d.split(";")[2]; });

const local = (e164: string) => "0" + e164.slice(3);
const invites = (bossKey: string) => sql`SELECT phone, name, joined_at, worker_id FROM crew_invites WHERE boss_id = ${ids[bossKey]} ORDER BY phone`;
const crewOf = (bossKey: string) => sql`SELECT worker_id FROM crew WHERE boss_id = ${ids[bossKey]}`;

describe.skipIf(!process.env.DATABASE_URL)("a boss brings their own crew", () => {
  const clean = async () => {
    await sql`DELETE FROM projects WHERE name = 'Crew import fixture site'`;
    await sql`DELETE FROM crew_invites WHERE phone = ANY(${Object.values(PHONES)})`;
    await sql`DELETE FROM users WHERE phone = ANY(${Object.values(PHONES)})`;
  };

  beforeEach(async () => {
    await clean();
    for (const [k, phone] of Object.entries(PHONES))
      ids[k] = (await sql`INSERT INTO users (phone, name, role, last_seen_at) VALUES (${phone}, ${`Crew ${k} fixture`}, ${k === "boss" || k === "other" ? "boss" : null}, now()) RETURNING id`)[0].id;
    for (const k of ["boss", "other"])
      await sql`INSERT INTO bosses (user_id, company, invite_code) VALUES (${ids[k]}, ${`Crew ${k} Co`}, ${k === "boss" ? "CREW01" : "CREW02"})`;
    // One worker who is already on OnSite; the rest have accounts with no role yet, as a new sign-up does.
    await sql`UPDATE users SET role = 'worker' WHERE id = ${ids.known}`;
    await sql`INSERT INTO workers (user_id, home, home_label, radius_km, tickets, invite_code)
              VALUES (${ids.known}, ST_SetSRID(ST_MakePoint(151.155, -33.910),4326)::geography, 'Marrickville', 25, '{WC}', 'CIKNWN')`;
    await sql`UPDATE users SET role = NULL, name = NULL WHERE id = ANY(${[ids.newbie, ids.linker, ids.stale]})`;
  });
  afterAll(async () => { vi.unstubAllEnvs(); await clean(); await sql.end(); });

  it("says what will happen to each number before anything does", async () => {
    as(ids.boss);
    const p = await boss.previewCrew(`Batbayar ${local(PHONES.known)}\n${local(PHONES.newbie)}\n(02) 9555 1234`);
    expect(p).toMatchObject({ ok: true, dropped: ["(02) 9555 1234"], overflowed: false });
    if (!p.ok) throw new Error("preview refused");
    expect(p.rows).toEqual([
      { phone: PHONES.known, name: "Batbayar", label: "Batbayar", known: true },
      { phone: PHONES.newbie, name: null, label: local(PHONES.newbie).replace(/^(\d{4})(\d{3})(\d{3})$/, "$1 $2 $3"), known: false },
    ]);
    expect(await crewOf("boss")).toEqual([]);                       // a look, not a change
  });

  it("puts the ones already here into the crew and tells them, and invites the rest", async () => {
    as(ids.boss);
    const r = await boss.importCrew(`Batbayar ${local(PHONES.known)}\nNima ${local(PHONES.newbie)}\nrubbish`);
    expect(r).toMatchObject({ ok: true, added: 1, invited: 1, code: "CREW01", company: "Crew boss Co" });

    expect((await crewOf("boss")).map((c) => c.worker_id)).toEqual([ids.known]);
    const [note] = await sql`SELECT body, kind FROM notifications WHERE user_id = ${ids.known}`;
    expect(note.kind).toBe("crew_added");
    expect(note.body).toBe("Crew boss Co added you to their crew. They can book you directly. Not your boss? Leave the crew in Me → Settings.");

    const rows = await invites("boss");
    expect(rows).toHaveLength(2);
    expect(rows.find((i) => i.phone === PHONES.newbie)).toMatchObject({ name: "Nima", joined_at: null, worker_id: null });
    // The one already on OnSite is recorded as joined: that row is the record of who brought whom.
    expect(rows.find((i) => i.phone === PHONES.known)).toMatchObject({ worker_id: ids.known });
    expect(rows.find((i) => i.phone === PHONES.known)!.joined_at).not.toBeNull();
  });

  it("the same number twice is one invite, and importing again doesn't double anything", async () => {
    as(ids.boss);
    await boss.importCrew(`${local(PHONES.newbie)}\n${PHONES.newbie}\nNima ${local(PHONES.newbie)}`);
    expect(await invites("boss")).toHaveLength(1);
    await boss.importCrew(`Nima Sherpa ${local(PHONES.newbie)}`);
    const rows = await invites("boss");
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Nima Sherpa");                       // the newer name wins
  });

  it("one boss's invited numbers are never in another boss's queries", async () => {
    as(ids.boss);
    await boss.importCrew(local(PHONES.newbie));
    as(ids.other);
    await boss.importCrew(local(PHONES.stale));
    expect((await invites("boss")).map((i) => i.phone)).toEqual([PHONES.newbie]);
    expect((await invites("other")).map((i) => i.phone)).toEqual([PHONES.stale]);
  });

  it("signing up with an invited number lands them in the crew and tells the boss", async () => {
    as(ids.boss);
    await boss.importCrew(`Nima ${local(PHONES.newbie)}`);

    as(ids.newbie);
    expect(await onboard(fd({ role: "worker", name: "Nima Sherpa", privacy: "yes" }))).toBe("/worker");

    expect((await crewOf("boss")).map((c) => c.worker_id)).toEqual([ids.newbie]);
    const [inv] = await invites("boss");
    expect(inv.worker_id).toBe(ids.newbie);
    expect(inv.joined_at).not.toBeNull();
    const [note] = await sql`SELECT kind, body FROM notifications WHERE user_id = ${ids.boss}`;
    expect(note).toMatchObject({ kind: "crew_joined", body: "Nima Sherpa joined your crew." });
  });

  it("the boss's link does the same for a number nobody typed in", async () => {
    as(ids.linker);
    expect(await onboard(fd({ role: "worker", name: "Link Joiner", privacy: "yes", invite: "crew01" }))).toBe("/worker");
    expect((await crewOf("boss")).map((c) => c.worker_id)).toEqual([ids.linker]);
    const [inv] = await invites("boss");
    expect(inv).toMatchObject({ phone: PHONES.linker, worker_id: ids.linker });
    expect(await sql`SELECT 1 FROM notifications WHERE user_id = ${ids.boss} AND kind = 'crew_joined'`).toHaveLength(1);
  });

  it("a worker can leave a crew, and nobody is told", async () => {
    as(ids.boss);
    await boss.importCrew(local(PHONES.known));
    await sql`DELETE FROM notifications WHERE user_id = ${ids.boss}`;
    as(ids.known);
    await leaveCrew(ids.boss);
    expect(await crewOf("boss")).toEqual([]);
    expect(await sql`SELECT 1 FROM notifications WHERE user_id = ${ids.boss}`).toHaveLength(0);
  });

  it("a worker the boss brought themselves is never an introduction", async () => {
    as(ids.boss);
    await boss.importCrew(local(PHONES.known));
    const [p] = await sql`INSERT INTO projects (boss_id, name, address, location)
      VALUES (${ids.boss}, 'Crew import fixture site', 'Marrickville', ST_SetSRID(ST_MakePoint(151.155, -33.910),4326)::geography) RETURNING id`;
    const [s] = await sql`INSERT INTO shifts (project_id, boss_id, day, start_time, hours, spots, role, tickets_required, rate)
      VALUES (${p.id}, ${ids.boss}, CURRENT_DATE + 3, '06:30', 8, 1, 'General labourer', '{WC}', 40) RETURNING id`;

    // Taken out of the pool, the way any matched shift is — and still not an introduction.
    expect(await bookWorker({ shiftId: s.id, workerId: ids.known, workerName: "Crew known fixture", via: "match", notify: null }))
      .toMatchObject({ ok: true });
    expect(await sql`SELECT 1 FROM introductions WHERE boss_id = ${ids.boss} AND worker_id = ${ids.known}`).toHaveLength(0);

    // Another boss, who never met them, is an introduction as before.
    const [p2] = await sql`INSERT INTO projects (boss_id, name, address, location)
      VALUES (${ids.other}, 'Crew import fixture site', 'Marrickville', ST_SetSRID(ST_MakePoint(151.155, -33.910),4326)::geography) RETURNING id`;
    const [s2] = await sql`INSERT INTO shifts (project_id, boss_id, day, start_time, hours, spots, role, tickets_required, rate)
      VALUES (${p2.id}, ${ids.other}, CURRENT_DATE + 4, '06:30', 8, 1, 'General labourer', '{WC}', 40) RETURNING id`;
    expect(await bookWorker({ shiftId: s2.id, workerId: ids.known, workerName: "Crew known fixture", via: "match", notify: null }))
      .toMatchObject({ ok: true });
    expect(await sql`SELECT 1 FROM introductions WHERE boss_id = ${ids.other} AND worker_id = ${ids.known}`).toHaveLength(1);
  });

  it("an invited number that nobody used is deleted after 90 days; one that joined is kept", async () => {
    as(ids.boss);
    await boss.importCrew(`${local(PHONES.newbie)}\n${local(PHONES.known)}`);
    expect(await sweepCrewInvites()).toEqual({ expired: 0 });
    await sql`UPDATE crew_invites SET expires_at = now() - interval '1 day' WHERE boss_id = ${ids.boss}`;
    expect(await sweepCrewInvites()).toEqual({ expired: 1 });
    expect((await invites("boss")).map((i) => i.phone)).toEqual([PHONES.known]);   // the one who joined stays
  });
});
