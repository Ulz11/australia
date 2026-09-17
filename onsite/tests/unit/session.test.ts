/**
 * Staying signed in, the parts that need no database: the cookie's shape and lifetime, the bearer header,
 * and how often a browser asks for a renewal. tests/integration/session.test.ts runs the routes themselves.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { RENEW_AFTER_SECONDS, SESSION_COOKIE, SESSION_DAYS, bearerToken, sessionCookie } from "@/lib/session";
import { ago } from "@/lib/util";
import { REFRESH_EVERY_MS, refreshDue } from "@/components/SessionRefresh";

afterEach(() => { vi.unstubAllEnvs(); });

const DAY = 24 * 60 * 60;

describe("the session cookie", () => {
  it("lasts a year — under Chrome's 400-day cap — and keeps its protections", () => {
    expect(SESSION_DAYS).toBe(365);
    expect(sessionCookie("t")).toEqual({ name: SESSION_COOKIE, value: "t", httpOnly: true, sameSite: "lax", secure: false, maxAge: 365 * DAY, path: "/" });
    expect(sessionCookie("t").maxAge).toBeLessThan(400 * DAY);
    expect(SESSION_COOKIE).toBe("onsite_session");
  });

  it("is https-only in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookie("t").secure).toBe(true);
  });

  it("is renewed by the server once it is a day old", () => {
    expect(RENEW_AFTER_SECONDS).toBe(DAY);
  });
});

describe("the mobile bearer header", () => {
  it("reads `Authorization: Bearer <token>` and nothing else", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer   abc ")).toBe("abc");
    expect(bearerToken("Bearer ")).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe("how long ago a phone was last used", () => {
  it("reads as a person would say it, and never as a clock", () => {
    const now = new Date("2026-09-18T09:00:00Z");
    const back = (ms: number) => new Date(now.getTime() - ms);
    expect(ago(back(0), now)).toBe("just now");
    expect(ago(back(90_000), now)).toBe("just now");
    expect(ago(back(20 * 60_000), now)).toBe("20 min ago");
    expect(ago(back(2 * 60 * 60_000), now)).toBe("2 h ago");
    expect(ago(back(23 * 60 * 60_000), now)).toBe("23 h ago");
    expect(ago(back(30 * 60 * 60_000), now)).toBe("yesterday");
    expect(ago(back(9 * DAY * 1000), now)).toBe("9 days ago");
    expect(ago(back(70 * DAY * 1000), now)).toBe("2 months ago");
    expect(ago(back(800 * DAY * 1000), now)).toBe("over a year ago");
  });
});

describe("how often a browser asks", () => {
  it("at most once every 6 hours; a never-asked browser or a clock that went backwards asks now", () => {
    const now = Date.UTC(2026, 8, 16, 9);
    expect(REFRESH_EVERY_MS).toBe(6 * 60 * 60 * 1000);
    expect(refreshDue(0, now)).toBe(true);
    expect(refreshDue(now - 60_000, now)).toBe(false);
    expect(refreshDue(now - REFRESH_EVERY_MS + 1, now)).toBe(false);
    expect(refreshDue(now - REFRESH_EVERY_MS, now)).toBe(true);
    expect(refreshDue(now + 60 * 60 * 1000, now)).toBe(true);
    expect(refreshDue(Number.NaN, now)).toBe(true);
  });
});
