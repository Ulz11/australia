import { describe, it, expect, afterEach } from "vitest";
import { newCode, hashCode, codeMatches, phoneAllowed, inviteCode } from "@/lib/otp";
import { ipBucket } from "@/lib/ratelimit";

afterEach(() => { delete process.env.ALLOW_INTL_PHONES; });

describe("login codes", () => {
  it("are always six digits", () => {
    for (let i = 0; i < 500; i++) expect(newCode()).toMatch(/^[1-9]\d{5}$/);
  });
  it("are stored as a hash tied to the phone, never as the code", () => {
    const h = hashCode("+61412345678", "123456");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("123456");
    expect(hashCode("+61412345679", "123456")).not.toBe(h);          // same code, other phone
  });
  it("match only the right code for the right phone", () => {
    const h = hashCode("+61412345678", "123456");
    expect(codeMatches("+61412345678", "123456", h)).toBe(true);
    expect(codeMatches("+61412345678", "123457", h)).toBe(false);
    expect(codeMatches("+61412345679", "123456", h)).toBe(false);
    expect(codeMatches("+61412345678", "12345", h)).toBe(false);
    expect(codeMatches("+61412345678", "123456", "123456")).toBe(false);   // an old plain-text row never matches
    expect(codeMatches("+61412345678", "", h)).toBe(false);
  });
});

describe("who can be texted", () => {
  it("Australian mobiles only by default — foreign numbers are how SMS bills get pumped", () => {
    expect(phoneAllowed("+61412345678")).toBe(true);
    expect(phoneAllowed("+97699112233")).toBe(false);
    expect(phoneAllowed("+447911123456")).toBe(false);
  });
  it("foreign numbers only when explicitly allowed for testing", () => {
    process.env.ALLOW_INTL_PHONES = "1";
    expect(phoneAllowed("+97699112233")).toBe(true);
  });
});

describe("invite codes", () => {
  it("are six characters from A–Z and 0–9", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) { const c = inviteCode(); expect(c).toMatch(/^[A-Z0-9]{6}$/); seen.add(c); }
    expect(seen.size).toBeGreaterThan(290);
  });
});

describe("rate-limit buckets by address", () => {
  it("IPv4 is its own bucket; an IPv4-mapped IPv6 address is the same IPv4", () => {
    expect(ipBucket("203.0.113.9")).toBe("203.0.113.9");
    expect(ipBucket("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });
  it("IPv6 groups by /64, however it's written — one home can't mint a bucket per address", () => {
    const a = ipBucket("2001:db8:85a3:12::1"), b = ipBucket("2001:0db8:85a3:0012:ffff:eeee:dddd:cccc"), c = ipBucket("2001:db8:85a3:12:0:0:0:99%en0");
    expect(a).toBe("2001:db8:85a3:12::/64");
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(ipBucket("2001:db8:85a3:13::1")).not.toBe(a);
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
  });
  it("strips a port, so one client can't mint a bucket per source port", () => {
    expect(ipBucket("203.0.113.9:1234")).toBe("203.0.113.9");
    expect(ipBucket("203.0.113.9:5678")).toBe("203.0.113.9");
    expect(ipBucket("[2001:db8:abcd:1234::5]:443")).toBe("2001:db8:abcd:1234::/64");
  });
  it("unwraps every spelling of an IPv4-mapped address", () => {
    for (const spelling of ["::ffff:203.0.113.9", "0:0:0:0:0:ffff:203.0.113.9", "::ffff:203.0.113.9%eth0", "::FFFF:203.0.113.9", "::ffff:cb00:7109", "[::ffff:203.0.113.9]:443"])
      expect(ipBucket(spelling), spelling).toBe("203.0.113.9");
  });
  it("keeps a junk key short enough to store", () => expect(ipBucket("x".repeat(500)).length).toBeLessThanOrEqual(64));
  it("leaves non-addresses alone instead of inventing a prefix for them", () => {
    expect(ipBucket("local")).toBe("local");
    expect(ipBucket("garbage:::x")).toBe("garbage:::x");
    expect(ipBucket("localhost:3000")).toBe("localhost:3000");
    expect(ipBucket("foo:bar")).toBe("foo:bar");
  });
});
