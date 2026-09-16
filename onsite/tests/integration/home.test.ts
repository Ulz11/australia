/**
 * A worker's home is stored to about a kilometre, whatever the form sends — onboarding and Me both.
 * Real actions, real DB (needs DATABASE_URL). Own +614000092xx numbers, self-cleaning.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { completeOnboarding } from "@/actions/auth";
import { updateMe } from "@/actions/worker";
import { sql } from "@/lib/db";

const PHONE = "+61400009211";
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
const home = async (id: string) =>
  (await sql`SELECT ST_Y(home::geometry) AS lat, ST_X(home::geometry) AS lng, home_label FROM workers WHERE user_id = ${id}`)[0];

describe.skipIf(!process.env.DATABASE_URL)("a worker's home is kept to about a kilometre", () => {
  let id = "";
  beforeEach(async () => {
    await sql`DELETE FROM users WHERE phone = ${PHONE}`;
    id = (await sql`INSERT INTO users (phone) VALUES (${PHONE}) RETURNING id`)[0].id;
    vi.stubEnv("TEST_USER_ID", id);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await sql`DELETE FROM users WHERE phone = ${PHONE}`;
    await sql.end();
  });

  it("at onboarding, and again when it's changed on Me", async () => {
    await completeOnboarding(fd({ role: "worker", name: "Home Fixture", privacy: "yes", lat: "-33.9107821", lng: "151.1552087", home_label: "Marrickville NSW" }))
      .catch((e) => { if (!String((e as { digest?: string }).digest).includes("NEXT_REDIRECT")) throw e; });
    expect(await home(id)).toEqual({ lat: -33.91, lng: 151.16, home_label: "Marrickville NSW" });

    await updateMe(fd({ radius_km: "25", lat: "-33.8977123", lng: "151.1789456", home_label: "Newtown NSW", name: "Home Fixture" }));
    expect(await home(id)).toEqual({ lat: -33.9, lng: 151.18, home_label: "Newtown NSW" });
  });
});
