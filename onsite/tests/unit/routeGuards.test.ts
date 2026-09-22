/**
 * There is no proxy in front of the signed-in screens: on Vercel it would run in every region, not in Sydney.
 * So every page, layout and route under /boss, /worker and /onboarding has to turn a signed-out visitor away
 * itself, and every server action they post to has to check who is calling. A layout's check isn't enough on
 * its own — layouts don't re-run on client navigation, and a page renders alongside its layout, not after it.
 * This fails the moment someone adds a screen that forgets.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

const SIGNED_IN_DIRS = ["app/boss", "app/worker", "app/onboarding"];
const ENTRY = /^(page|layout|template|default|route)\.(tsx|ts|jsx|js)$/;

/** Calls requireRole (which redirects signed-out users to /login), or reads the user and redirects to /login itself. */
const guardsPage = (src: string) =>
  /\brequireRole\(\s*["'](boss|worker)["']\s*\)/.test(src) ||
  (/\bgetUser\(\)/.test(src) && /\bredirect\(\s*["']\/login["']\s*\)/.test(src));

/** A route handler: reads the user, and answers a signed-out caller before doing anything else. */
const guardsRoute = (src: string) =>
  /\brequireRole\(/.test(src) ||
  (/\b(getUser|getApiUser)\(\)/.test(src) && /if\s*\(\s*!u\b/.test(src));

describe("signed-in screens guard themselves", () => {
  it("there is no proxy or middleware left to rely on", () => {
    for (const f of ["proxy.ts", "proxy.js", "middleware.ts", "middleware.js"]) expect(fs.existsSync(f), f).toBe(false);
  });

  it("every page, layout and route under /boss, /worker and /onboarding turns signed-out visitors away", () => {
    const entries = SIGNED_IN_DIRS.flatMap(walk).filter((f) => ENTRY.test(path.basename(f)));
    expect(entries.length).toBeGreaterThan(15);                        // the walk really found the screens
    const unguarded = entries.filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      return path.basename(f).startsWith("route.") ? !guardsRoute(src) : !guardsPage(src);
    });
    expect(unguarded).toEqual([]);
  });

  it("every boss and worker server action checks the caller's role before it touches anything", () => {
    // [file, the role it is for, how many actions it must at least have — so an empty or renamed file fails here]
    // actions/billing.ts is down to one: there is nothing to start, cancel or resume under $2-an-introduction,
    // so paying an invoice is the only action left. One is still the floor that catches an emptied file.
    for (const [file, role, least] of [["actions/boss.ts", "boss", 6], ["actions/worker.ts", "worker", 6], ["actions/billing.ts", "boss", 1]] as const) {
      const src = fs.readFileSync(file, "utf8");
      const bodies = src.split(/^export async function /m).slice(1);
      expect(bodies.length, file).toBeGreaterThanOrEqual(least);
      const unguarded = bodies
        .filter((b) => {
          const firstStatement = b.slice(b.indexOf("{") + 1).trimStart().split("\n")[0];
          return !new RegExp(`^const u = await requireRole\\("${role}"\\);`).test(firstStatement);
        })
        .map((b) => `${file}: ${b.slice(0, b.indexOf("("))}`);
      expect(unguarded).toEqual([]);
    }
  });
});

/**
 * Face ID / fingerprint sign-in (actions/passkeys.ts) lives outside the signed-in folders too. Registering and
 * removing act on the caller's own passkeys, so each checks who is calling before anything else; signing in has
 * nobody to check yet, so it refuses when passkeys are off and counts against the connection's limit first.
 */
describe("the passkey actions guard themselves", () => {
  const src = fs.readFileSync("actions/passkeys.ts", "utf8");
  const bodies = Object.fromEntries(src.split(/^export async function /m).slice(1)
    .map((b) => [b.slice(0, b.indexOf("(")), b.slice(b.indexOf("{\n") + 2).trimStart().split("\n").map((l) => l.trim())]));

  it("the file is a server action file with the five actions", () => {
    expect(src).toMatch(/^"use server";/);
    expect(Object.keys(bodies).sort()).toEqual(["passkeyLoginOptions", "passkeyRegister", "passkeyRegisterOptions", "passkeySignIn", "removePasskey"]);
  });

  it("registering and removing read the signed-in user first and stop when there is none", () => {
    for (const name of ["passkeyRegisterOptions", "passkeyRegister", "removePasskey"]) {
      expect(bodies[name][0], name).toBe("const u = await getUser();");
      expect(bodies[name][1], name).toMatch(/^if \(!u\) return\b/);
    }
  });

  it("signing in refuses when passkeys are off, then spends the connection's allowance before any checking", () => {
    for (const name of ["passkeyLoginOptions", "passkeySignIn"]) {
      const [a, b, c, d] = bodies[name];
      expect([a, b], name).toEqual(["const rp = relyingParty();", `if (!rp) return refuse("off");`]);
      expect(c, name).toBe("const ip = await clientIp();");
      expect(d, name).toMatch(/^if \(ip && !\(await hit\(`passkey-(login|verify):ip:\$\{ip\}`/);
    }
  });
});

/**
 * Me → "Where you're signed in" ends a session (lib/session.ts, migration 015). Both actions live in
 * actions/auth.ts, outside the signed-in folders and outside the role-checked files above, and both act on the
 * caller's own sessions — so each reads the user first and stops when there is none.
 */
describe("the sign-out-a-phone actions guard themselves", () => {
  const src = fs.readFileSync("actions/auth.ts", "utf8");
  const bodies = Object.fromEntries(src.split(/^export async function /m).slice(1)
    .map((b) => [b.slice(0, b.indexOf("(")), b.slice(b.indexOf("{\n") + 2).trimStart().split("\n").map((l) => l.trim())]));

  it("both are there, read the signed-in user first, and stop when there is none", () => {
    for (const name of ["signOutSession", "signOutOtherSessions"]) {
      expect(bodies[name], name).toBeTruthy();
      expect(bodies[name][0], name).toBe("const u = await getUser();");
      expect(bodies[name][1], name).toMatch(/^if \(!u\b/);
    }
  });

  it("both boss and worker settings show the list, so neither side is left without a way to sign a phone out", () => {
    for (const f of ["app/boss/me/settings/page.tsx", "app/worker/me/settings/page.tsx"])
      expect(fs.readFileSync(f, "utf8"), f).toMatch(/<SessionsSection /);
  });
});

/**
 * Picking a language (actions/lang.ts) works signed out — the login screen is the first place anyone meets it —
 * so it can't demand a role. It still has to read who is calling before it writes anything to an account.
 */
describe("the language action guards itself", () => {
  const src = fs.readFileSync("actions/lang.ts", "utf8");
  const body = src.slice(src.indexOf("export async function setLanguage"));
  const lines = body.slice(body.indexOf("{\n") + 2).split("\n").map((l) => l.trim());

  it("reads the user first, checks the language is one we have, and only writes the caller's own row", () => {
    expect(src).toMatch(/^"use server";/);
    expect(lines[0]).toBe("const u = await getUser();");
    expect(lines[1]).toBe("if (!isLang(lang)) return;");
    expect(src).toMatch(/UPDATE users SET lang = \$\{lang\} WHERE id = \$\{u\.id\}/);
    expect(src).not.toMatch(/WHERE id = \$\{(?!u\.id)/);
  });
});

/**
 * Staying signed in adds two routes outside the signed-in folders (lib/session.ts). Nothing in front of them
 * checks anything either, so each must verify the token — and that its user still exists — before it does anything.
 */
describe("the session refresh routes guard themselves", () => {
  const ROUTES = ["app/api/session/refresh/route.ts", "app/api/v1/auth/refresh/route.ts"];
  const firstStatement = (src: string) => {
    const body = src.slice(src.indexOf("export async function POST"));
    return body.slice(body.indexOf("{") + 1).trimStart().split("\n")[0];
  };

  it("both verify the token first and answer a bad one with 401", () => {
    for (const f of ROUTES) {
      const src = fs.readFileSync(f, "utf8");
      expect(firstStatement(src), f).toMatch(/^const r = await renewSession\(/);
      expect(src, f).toMatch(/if \(!r\)/);
      expect(src, f).toMatch(/401/);
    }
  });

  it("the cookie route reads only the session cookie — never a frame cookie, never getUser (which prefers frames)", () => {
    const src = fs.readFileSync("app/api/session/refresh/route.ts", "utf8");
    expect(firstStatement(src)).toBe("const r = await renewSession(req.cookies.get(SESSION_COOKIE)?.value);");
    expect(src).not.toMatch(/FRAME_COOKIES|onsite_frame|getUser|getApiUser|next\/headers/);
  });

  it("the app's route takes a bearer token only — no cookie fallback", () => {
    const src = fs.readFileSync("app/api/v1/auth/refresh/route.ts", "utf8");
    expect(firstStatement(src)).toBe(`const r = await renewSession(bearerToken(req.headers.get("authorization")), 0);`);
    expect(src).not.toMatch(/\bcookies\b|getUser|getApiUser|next\/headers/);
  });

  it("the boss and worker layouts both mount the refresher", () => {
    for (const f of ["app/boss/layout.tsx", "app/worker/layout.tsx"])
      expect(fs.readFileSync(f, "utf8"), f).toMatch(/<SessionRefresh \/>/);
  });
});
