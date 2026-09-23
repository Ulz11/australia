import { describe, it, expect } from "vitest";
import { normalisePhone } from "@/lib/sms";
import { addDays, weekStart, hoursBetween, fmtTime, fmtDay, km, initials } from "@/lib/util";

describe("normalisePhone", () => {
  it("accepts AU mobiles in every common form → E.164", () => {
    for (const raw of ["0412 345 678", "0412345678", "+61 412 345 678", "61412345678", "(04) 1234 5678"]) expect(normalisePhone(raw)).toBe("+61412345678");
  });
  it("rejects landlines, short numbers and junk", () => {
    for (const raw of ["02 9999 9999", "0412", "hello", ""]) expect(normalisePhone(raw)).toBeNull();
  });
});

describe("dates", () => {
  it("addDays crosses month and year ends", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("weekStart is the Monday", () => {
    expect(weekStart("2026-09-03")).toBe("2026-08-31"); // Thu → Mon
    expect(weekStart("2026-09-06")).toBe("2026-08-31"); // Sun → previous Mon
    expect(weekStart("2026-08-31")).toBe("2026-08-31"); // Mon → itself
  });
  it("hoursBetween rounds to the nearest half hour", () => {
    const a = new Date("2026-09-03T06:30:00Z");
    expect(hoursBetween(a, new Date("2026-09-03T15:10:00Z"))).toBe(8.5);
    expect(hoursBetween(a, new Date("2026-09-03T14:40:00Z"))).toBe(8);
  });
  it("formats", () => {
    expect(fmtTime("06:30")).toBe("6:30am");
    expect(fmtTime("13:00")).toBe("1:00pm");
    expect(fmtDay("2026-09-05")).toMatch(/Sat/);
    expect(km(850)).toBe("850 m");
    expect(km(12345)).toBe("12.3 km");
    expect(initials("Batbayar Erdene")).toBe("BE");
    expect(initials("Dave  Carter")).toBe("DC");        // a double space is not a blank initial
    expect(initials(" Nima ")).toBe("N");
  });
});
