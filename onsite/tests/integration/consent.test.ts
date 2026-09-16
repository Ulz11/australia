/**
 * Consent to the privacy notice at onboarding, enforced by the server action — not just the checkbox.
 * Real action, real DB (needs DATABASE_URL; the last test needs a seeded DB). Own +614000094xx numbers, self-cleaning.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { completeOnboarding } from "@/actions/auth";
import { sql } from "@/lib/db";
import { PRIVACY_VERSION } from "@/lib/privacy";

const PHONES = ["+61400009401", "+61400009402", "+61400009403"];
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
/** Where the action sent them (it always ends in a redirect), or what it threw instead. */
const onboard = (form: FormData) => completeOnboarding(form).then(
  () => "no redirect",
  (e) => { const d = String((e as { digest?: string })?.digest ?? ""); if (!d.includes("NEXT_REDIRECT")) throw e; return d.split(";")[2]; },
);

describe.skipIf(!process.env.DATABASE_URL)("privacy consent at onboarding", () => {
  const ids: string[] = [];
  const me = async (i: number) => (await sql`SELECT role, name, privacy_accepted_at, privacy_version FROM users WHERE id = ${ids[i]}`)[0];

  beforeEach(async () => {
    await sql`DELETE FROM users WHERE phone = ANY(${PHONES})`;          // bosses and workers rows cascade
    ids.length = 0;
    for (const phone of PHONES) ids.push((await sql`INSERT INTO users (phone) VALUES (${phone}) RETURNING id`)[0].id);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await sql`DELETE FROM users WHERE phone = ANY(${PHONES})`;
    await sql.end();
  });

  it("without the box ticked nothing is set up, and they're sent back to onboarding with a reason", async () => {
    vi.stubEnv("TEST_USER_ID", ids[0]);
    for (const form of [
      fd({ role: "worker", name: "Consent Fixture", home_label: "Marrickville", invite: "ABC123" }),
      fd({ role: "worker", name: "Consent Fixture", privacy: "" }),
      fd({ role: "boss", name: "Consent Fixture", company: "Fixture Co", privacy: "on" }),   // only the form's own value counts
    ]) {
      const to = await onboard(form);
      expect(to).toMatch(/^\/onboarding\?err=privacy/);
      expect(await me(0)).toEqual({ role: null, name: null, privacy_accepted_at: null, privacy_version: null });
    }
    expect(await onboard(fd({ role: "worker", name: "Consent Fixture", invite: "ABC123" }))).toBe("/onboarding?err=privacy&invite=ABC123");
    expect((await sql`SELECT 1 FROM workers WHERE user_id = ${ids[0]}`).length).toBe(0);
    expect((await sql`SELECT 1 FROM bosses WHERE user_id = ${ids[0]}`).length).toBe(0);
  });

  it("with the box ticked, a worker is set up and the consent is stamped with the notice's version", async () => {
    vi.stubEnv("TEST_USER_ID", ids[1]);
    expect(await onboard(fd({ role: "worker", name: "Consent Worker", privacy: "yes" }))).toBe("/worker");
    const u = await me(1);
    expect(u).toMatchObject({ role: "worker", name: "Consent Worker", privacy_version: PRIVACY_VERSION });
    expect(u.privacy_accepted_at).toBeInstanceOf(Date);
    expect((await sql`SELECT 1 FROM workers WHERE user_id = ${ids[1]}`).length).toBe(1);
  });

  it("and a boss the same way", async () => {
    vi.stubEnv("TEST_USER_ID", ids[2]);
    expect(await onboard(fd({ role: "boss", name: "Consent Boss", company: "Consent Fixture Co", privacy: "yes" }))).toBe("/boss");
    expect(await me(2)).toMatchObject({ role: "boss", privacy_version: PRIVACY_VERSION, privacy_accepted_at: expect.any(Date) });
  });

  it("seeded demo accounts count as having agreed, so the local demo keeps working", async () => {
    const demo = await sql`SELECT phone, privacy_accepted_at, privacy_version FROM users WHERE phone LIKE '+61400000___'`;
    expect(demo.length, "seed the database first: npm run db:seed").toBeGreaterThan(0);
    expect(demo.filter((u) => !u.privacy_accepted_at || u.privacy_version !== PRIVACY_VERSION)).toEqual([]);
  });
});
