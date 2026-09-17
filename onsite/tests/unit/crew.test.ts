/**
 * Reading a crew off a boss's phone (lib/crew.ts), and the words that go with it. No database.
 * tests/integration/crewImport.test.ts runs the actions themselves.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_IMPORT, crewInviteSms, crewJoinUrl, crewLabel, crewShareText, parseCrewList, prettyPhone,
} from "@/lib/crew";

describe("reading a pasted list", () => {
  it("takes the number off the end of the line and the name off the front", () => {
    const r = parseCrewList("Batbayar 0412 345 678\n0413 222 111\nNima Sherpa: 0400 111 222\n+61 414 000 111");
    expect(r.entries).toEqual([
      { phone: "+61412345678", name: "Batbayar" },
      { phone: "+61413222111", name: null },
      { phone: "+61400111222", name: "Nima Sherpa" },
      { phone: "+61414000111", name: null },
    ]);
    expect(r.dropped).toEqual([]);
  });

  it("keeps anything that isn't an Australian mobile out, exactly as it was typed", () => {
    const r = parseCrewList("Dave\n(02) 9555 1234\nnot a number at all\n0412 345 678\n\n   \n");
    expect(r.entries.map((e) => e.phone)).toEqual(["+61412345678"]);
    expect(r.dropped).toEqual(["Dave", "(02) 9555 1234", "not a number at all"]);
  });

  it("the same number twice is one person, and the line that named them wins", () => {
    const r = parseCrewList("0412 345 678\nBatbayar 0412345678\n+61412345678");
    expect(r.entries).toEqual([{ phone: "+61412345678", name: "Batbayar" }]);
  });

  it("stops at fifty and says so, rather than quietly adding the rest", () => {
    const many = Array.from({ length: 60 }, (_, i) => `04120000${String(i).padStart(2, "0")}`).join("\n");
    const r = parseCrewList(many);
    expect(r.entries).toHaveLength(MAX_IMPORT);
    expect(r.overflowed).toBe(true);
    expect(parseCrewList("0412 345 678").overflowed).toBe(false);
  });
});

describe("the words", () => {
  it("writes a number the way it is written on a van", () => {
    expect(prettyPhone("+61412345678")).toBe("0412 345 678");
    expect(prettyPhone("+15551234567")).toBe("+15551234567");
    expect(crewLabel({ name: "Batbayar", phone: "+61412345678" })).toBe("Batbayar");
    expect(crewLabel({ name: null, phone: "+61412345678" })).toBe("0412 345 678");
  });

  it("the boss's own share carries their name; the text OnSite sends carries nobody's", () => {
    const url = crewJoinUrl("https://onsite-au.vercel.app/", "AB12CD");
    expect(url).toBe("https://onsite-au.vercel.app/join/c/AB12CD");
    expect(crewShareText({ firstName: "Dave", company: "Dave's Concreting" }, url))
      .toBe("Dave from Dave's Concreting put you on the OnSite crew list. Sign up here and you're in: " + url);
    // A text goes to someone who has never used OnSite and costs money: nothing a boss typed travels in it.
    const sms = crewInviteSms(url);
    expect(sms).not.toMatch(/Dave/);
    expect(sms).toContain(url);
    expect(sms.endsWith("Didn't expect this? Ignore it.")).toBe(true);
  });
});
