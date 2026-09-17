/**
 * Launch settings that need no database: the pool on Vercel, vercel.json, the privacy contact, and the
 * beta:invite command line.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import { privacyContact, PRIVACY_VERSION } from "@/lib/privacy";
import { TERMS_VERSION } from "@/lib/terms";
import { parseArgs } from "@/scripts/beta-invite";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("the database pool", () => {
  it("never idle-closes on a long-lived server, and lets idle connections go on Vercel", async () => {
    vi.stubEnv("VERCEL", "1");                                  // imported as if on Vercel: no warm-up connections from this test
    const cached = (globalThis as { __sql?: unknown }).__sql;  // a pool another file already built is reused, not rebuilt
    const { poolOptions, sql } = await import("@/lib/db");
    expect(poolOptions({})).toEqual({ idle_timeout: 0, max_lifetime: 1800, prepare: true });
    const vercel = poolOptions({ VERCEL: "1" });
    expect(vercel.idle_timeout).toBeGreaterThanOrEqual(10);
    expect(vercel.idle_timeout).toBeLessThanOrEqual(20);
    expect(vercel.max_lifetime).toBeGreaterThan(0);
    expect(vercel.max_lifetime).toBeLessThan(1800);
    // Through Neon's pooler a plan prepared before a migration goes stale ("cached plan must not change result
    // type", seen live after migration 009), so Vercel never uses named prepared statements.
    expect(vercel.prepare).toBe(false);
    // and those are what the real pool was built with
    if (!cached)
      expect({ idle_timeout: sql.options.idle_timeout, max_lifetime: sql.options.max_lifetime, prepare: sql.options.prepare }).toEqual(vercel);
  });
});

describe("vercel.json", () => {
  it("pins functions to Sydney and runs the cron every 20 minutes", () => {
    const v = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
    expect(v.regions).toEqual(["syd1"]);
    expect(v.crons).toEqual([{ path: "/api/cron/expand", schedule: "*/20 * * * *" }]);
    expect(fs.existsSync("render.yaml")).toBe(false);
    expect(fs.readFileSync("next.config.ts", "utf8")).not.toMatch(/standalone/);
  });
});

describe("privacy notice contact", () => {
  it("shows a contact only when both the email and the business name are set", () => {
    expect(privacyContact({})).toBeNull();
    expect(privacyContact({ PRIVACY_CONTACT_EMAIL: "privacy@example.com" })).toBeNull();
    expect(privacyContact({ BUSINESS_NAME: "OnSite Pty Ltd" })).toBeNull();
    expect(privacyContact({ PRIVACY_CONTACT_EMAIL: " privacy@example.com ", BUSINESS_NAME: "OnSite Pty Ltd" }))
      .toEqual({ email: "privacy@example.com", business: "OnSite Pty Ltd" });
    expect(PRIVACY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);                // a date, or a later change that day: 2026-09-17.2
  });

  it("the page reads them at request time and never hard-codes an address", () => {
    const src = fs.readFileSync("app/privacy/page.tsx", "utf8");
    expect(src).toMatch(/await connection\(\)/);
    expect(src).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);          // no email address typed into the page
  });
});

/**
 * The rules at /terms (lib/terms.ts). Same rule as the privacy notice: nothing about the business is typed
 * into the page, and every figure on it is read when the page is requested — never frozen at build time, so a
 * price can't go stale on the one screen that promises it.
 */
describe("the rules page", () => {
  const src = fs.readFileSync("app/terms/page.tsx", "utf8");

  it("reads its contact at request time and never hard-codes an address or an ABN", () => {
    expect(src).toMatch(/await connection\(\)/);
    expect(src).toMatch(/privacyContact\(\)/);
    expect(src).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(src).not.toMatch(/\b\d{11}\b/);
  });

  it("reads every fee from the code that charges it, not from words typed into the page", () => {
    for (const fn of ["matchFeeCents()", "subscriptionCents()", "trialDays()", "gstRegistered()", "demoSite()"])
      expect(src, fn).toContain(fn);
    expect(src).toContain("AWARD_CASUAL_FLOOR");
    expect(src).not.toMatch(/\$\d/);                              // no dollar figure typed in
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
  });

  it("is linked from the login screen, onboarding's consent box and the billing screens", () => {
    for (const f of ["app/login/page.tsx", "app/onboarding/RoleForm.tsx", "app/boss/billing/page.tsx", "app/boss/billing/[number]/page.tsx"])
      expect(fs.readFileSync(f, "utf8"), f).toMatch(/href="\/terms"/);
  });
});

describe("npm run beta:invite — arguments", () => {
  it("invite, with an optional role and note", () => {
    expect(parseArgs(["0412345678"])).toEqual({ cmd: "invite", phone: "0412345678", role: null, note: null });
    expect(parseArgs(["0412345678", "--role", "boss", "--note", "Dave's crew"])).toEqual({ cmd: "invite", phone: "0412345678", role: "boss", note: "Dave's crew" });
    expect(parseArgs(["--note", "mate", "0412 345 678", "--role", "worker"])).toEqual({ cmd: "invite", phone: "0412 345 678", role: "worker", note: "mate" });
    expect(parseArgs(["0412", "345", "678", "--role", "boss"])).toMatchObject({ cmd: "invite", phone: "0412 345 678" });   // typed unquoted
  });
  it("list and remove", () => {
    expect(parseArgs(["--list"])).toEqual({ cmd: "list" });
    expect(parseArgs(["--remove", "0412345678"])).toEqual({ cmd: "remove", phone: "0412345678" });
    expect(parseArgs(["--remove", "0412", "345", "678"])).toEqual({ cmd: "remove", phone: "0412 345 678" });
  });
  it("anything else is a usage error, not a guess", () => {
    expect(parseArgs([])).toEqual({ cmd: "help" });
    expect(parseArgs(["0412345678", "--role", "foreman"])).toMatchObject({ cmd: "help", error: expect.stringMatching(/worker or boss/) });
    expect(parseArgs(["0412345678", "--role", "boss", "Dave"])).toMatchObject({ cmd: "help", error: expect.any(String) });   // an unquoted note
    expect(parseArgs(["--remove", "0412345678", "--role", "boss"])).toMatchObject({ cmd: "help", error: expect.any(String) });
    expect(parseArgs(["--remove"])).toMatchObject({ cmd: "help", error: expect.any(String) });
    expect(parseArgs(["--list", "0412345678"])).toMatchObject({ cmd: "help", error: expect.any(String) });
    expect(parseArgs(["0412345678", "--admin"])).toMatchObject({ cmd: "help", error: expect.stringMatching(/Unknown option/) });
  });
});
