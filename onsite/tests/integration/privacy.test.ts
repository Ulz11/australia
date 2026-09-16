/**
 * A boss can see a worker's phone, but never their visa type or card numbers.
 * Needs DATABASE_URL + a seeded DB (Batbayar has a visa and numbered cards on file).
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sql } from "@/lib/db";
import { workerForBoss, licencesForBoss } from "@/lib/bossQueries";

const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));

describe("boss view of a worker — source guard", () => {
  it("no boss screen or boss action reads visa type, licence rows, or workers.* directly", () => {
    const offenders = [...walk("app/boss"), ...walk("actions")]
      .filter((f) => !f.endsWith("actions/worker.ts"))                          // the worker editing their own profile
      .filter((f) => /visa_type|\b(FROM|JOIN)\s+licences\b|\bw\.\*|SELECT\s+\*\s+FROM\s+workers\b/i.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

/**
 * The register client reads WHITE_CARD_* and talks to api.onegov.nsw.gov.au. A client component
 * that imports it — directly, or through some module that imports it — ships that code to a
 * browser and puts the app one bundler setting away from shipping the credentials with it.
 * Tree-shaking currently saves us; this test means we don't have to rely on it noticing.
 */
describe("the register client cannot reach the browser", () => {
  const root = process.cwd();
  const resolve = (from: string, spec: string): string | null => {
    const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
    if (!base) return null;                                                     // a package, not our source
    for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")])
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    return null;
  };
  const importsOf = (file: string) =>
    [...fs.readFileSync(file, "utf8").matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1]);
  /** A "use server" file is a boundary: the client gets a call stub, never the module's code. */
  const isServerAction = (file: string) => /^["']use server["']/m.test(fs.readFileSync(file, "utf8"));

  it("no 'use client' module imports lib/whitecard or lib/licenceCheck, however many hops away", () => {
    const files = [...walk("app"), ...walk("components"), ...walk("lib"), ...walk("actions")];
    const forbidden = new Set([path.join(root, "lib/whitecard.ts"), path.join(root, "lib/licenceCheck.ts")]);
    const trails: string[] = [];
    for (const entry of files.filter((f) => /^["']use client["']/m.test(fs.readFileSync(f, "utf8")))) {
      const seen = new Set<string>();
      const walkImports = (file: string, trail: string[]) => {
        if (seen.has(file)) return;
        seen.add(file);
        for (const spec of importsOf(file)) {
          const next = resolve(file, spec);
          if (!next) continue;
          if (forbidden.has(next)) trails.push([...trail, path.relative(root, next)].join(" → "));
          else if (!isServerAction(next)) walkImports(next, [...trail, path.relative(root, next)]);
        }
      };
      walkImports(entry, [path.relative(root, entry)]);
    }
    expect(trails).toEqual([]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("boss view of a worker — what the queries return", () => {
  afterAll(async () => { await sql.end(); });

  it("has the phone, not the visa type", async () => {
    const [dave] = await sql`SELECT id FROM users WHERE phone = '+61400000001'`;
    const [who] = await sql`SELECT us.id, us.phone, w.visa_type FROM users us JOIN workers w ON w.user_id = us.id
                            WHERE us.phone LIKE '+6140000%' AND w.visa_type IS NOT NULL AND w.visa_type <> '' ORDER BY us.phone LIMIT 1`;
    expect(who, "seed a worker with a visa type").toBeTruthy();                // there is something to hide
    const w = await workerForBoss(dave.id, who.id);
    expect(w?.phone).toBe(who.phone);
    expect(Object.keys(w ?? {})).not.toContain("visa_type");
    expect(JSON.stringify(w)).not.toContain(who.visa_type);
  });

  it("lists cards without their numbers or the register's note", async () => {
    const [who] = await sql`SELECT worker_id AS id FROM licences WHERE number IS NOT NULL AND length(number) >= 4 ORDER BY worker_id LIMIT 1`;
    expect(who, "seed a worker with a numbered card").toBeTruthy();
    const stored = await sql`SELECT number FROM licences WHERE worker_id = ${who.id} AND number IS NOT NULL AND length(number) >= 4`;
    const rows = await licencesForBoss(who.id);
    expect(rows.length).toBe((await sql`SELECT 1 FROM licences WHERE worker_id = ${who.id}`).length);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["checked_at", "expires_on", "issued_state", "kind", "status"]);
      for (const s of stored) expect(JSON.stringify(r)).not.toContain(s.number);
    }
  });
});
