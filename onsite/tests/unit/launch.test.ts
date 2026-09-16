/**
 * Launch settings that need no database: the pool on Vercel, vercel.json, the privacy contact, and the
 * beta:invite command line.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import { privacyContact, PRIVACY_VERSION } from "@/lib/privacy";
import { parseArgs } from "@/scripts/beta-invite";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("the database pool", () => {
  it("never idle-closes on a long-lived server, and lets idle connections go on Vercel", async () => {
    vi.stubEnv("VERCEL", "1");                                  // imported as if on Vercel: no warm-up connections from this test
    const cached = (globalThis as { __sql?: unknown }).__sql;  // a pool another file already built is reused, not rebuilt
    const { poolOptions, sql } = await import("@/lib/db");
    expect(poolOptions({})).toEqual({ idle_timeout: 0, max_lifetime: 1800 });
    const vercel = poolOptions({ VERCEL: "1" });
    expect(vercel.idle_timeout).toBeGreaterThanOrEqual(10);
    expect(vercel.idle_timeout).toBeLessThanOrEqual(20);
    expect(vercel.max_lifetime).toBeGreaterThan(0);
    expect(vercel.max_lifetime).toBeLessThan(1800);
    // and those are what the real pool was built with
    if (!cached)
      expect({ idle_timeout: sql.options.idle_timeout, max_lifetime: sql.options.max_lifetime }).toEqual(vercel);
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
    expect(PRIVACY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("the page reads them at request time and never hard-codes an address", () => {
    const src = fs.readFileSync("app/privacy/page.tsx", "utf8");
    expect(src).toMatch(/await connection\(\)/);
    expect(src).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);          // no email address typed into the page
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
