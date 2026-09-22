import { describe, it, expect } from "vitest";
import { clampRate } from "@/lib/rules";

describe("clampRate", () => {
  it("never goes under the Award casual floor", () => {
    expect(clampRate(30)).toBe(35.55);
  });
});

describe("clampRate — bad input", () => {
  it("treats NaN / empty as the floor, not NaN", () => {
    expect(clampRate(NaN)).toBe(35.55);
  });
  it("keeps a rate above the floor, rounded to cents", () => {
    expect(clampRate(38.004)).toBe(38);
  });
});

import { normaliseTickets } from "@/lib/rules";
describe("normaliseTickets", () => {
  it("always includes White Card, dedupes, drops unknown codes, keeps a stable order", () => {
    expect(normaliseTickets(["LF", "hax", "LF", "DG"])).toEqual(["WC", "LF", "DG"]);
    expect(normaliseTickets([])).toEqual(["WC"]);
  });
});

import { batchSize } from "@/lib/rules";
describe("batchSize — how many phones one shift wakes up", () => {
  it("is 3× the spots still open, never negative", () => {
    expect(batchSize({ spots: 2, taken: 0 })).toBe(6);
    expect(batchSize({ spots: 2, taken: 1 })).toBe(3);
    expect(batchSize({ spots: 2, taken: 2 })).toBe(0);
    expect(batchSize({ spots: 1, taken: 3 })).toBe(0);
  });
});

import { clockInLooks } from "@/lib/rules";
describe("clockInLooks — clear, not strict", () => {
  const shift = { day: "2026-09-05", start_time: "06:30" };
  it("is 'good' within 300 m and the 10-minute grace", () => {
    expect(clockInLooks(shift, { dist_m: 120, at: "2026-09-05T06:40:00+10:00" })).toBe("good");
  });
  it("is 'far' when more than 300 m away", () => {
    expect(clockInLooks(shift, { dist_m: 900, at: "2026-09-05T06:30:00+10:00" })).toBe("far");
  });
  it("is 'late' past the grace — the one grace, ON_TIME_GRACE_MIN (tests/unit/onTimeGrace.test.ts)", () => {
    expect(clockInLooks(shift, { dist_m: 50, at: "2026-09-05T06:50:00+10:00" })).toBe("late");
  });
  it("is 'unknown' with no GPS fix", () => {
    expect(clockInLooks(shift, { dist_m: null, at: "2026-09-05T06:30:00+10:00" })).toBe("unknown");
  });
});

// ────────────────────────────────────────────────────── deal requests (offers)
import { checkOffer } from "@/lib/rules";
const shift = { rate: 36, hours: 8, start_time: "06:30", allow_offers: true, spots: 2, taken: 0, status: "open" };

describe("checkOffer", () => {
  it("accepts a sensible ask and reports what changed", () => {
    const r = checkOffer(shift, { rate: 42, hours: 8, start_time: "06:30", message: "I'll bring my own tools" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.changes).toEqual(["Rate $36.00 → $42.00"]);
  });
  it("drops fields that match the shift, so an empty offer is refused", () => {
    const r = checkOffer(shift, { rate: 36, hours: 8, start_time: "06:30", message: "" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/change something/i);
  });
  it("lets a message-only request through", () => {
    const r = checkOffer(shift, { rate: null, hours: null, start_time: null, message: "Can I finish at 2 for uni?" });
    expect(r.ok).toBe(true);
  });
  it("never lets an offer go under the Award floor", () => {
    const r = checkOffer(shift, { rate: 30, hours: 8, start_time: "06:30", message: "" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/35\.55/);
  });
  it("refuses when the boss turned offers off, or the shift is gone", () => {
    expect(checkOffer({ ...shift, allow_offers: false }, { rate: 42, hours: null, start_time: null, message: "" }).ok).toBe(false);
    expect(checkOffer({ ...shift, status: "filled" }, { rate: 42, hours: null, start_time: null, message: "" }).ok).toBe(false);
    expect(checkOffer({ ...shift, taken: 2 }, { rate: 42, hours: null, start_time: null, message: "" }).ok).toBe(false);
  });
  it("caps silly numbers", () => {
    expect(checkOffer(shift, { rate: 4000, hours: null, start_time: null, message: "" }).ok).toBe(false);
    expect(checkOffer(shift, { rate: null, hours: 20, start_time: null, message: "" }).ok).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────── site crew cap
import { crewStatus } from "@/lib/rules";
describe("crewStatus", () => {
  it("counts own crew plus booked casuals against the target", () => {
    expect(crewStatus({ crew_target: 12, own_crew: 8, booked_ahead: 2 })).toMatchObject({ on: 10, target: 12, spare: 2, over: false });
  });
  it("flags going over so the boss sees it before he hires", () => {
    expect(crewStatus({ crew_target: 10, own_crew: 8, booked_ahead: 3 })).toMatchObject({ on: 11, spare: 0, over: true });
  });
  it("no target set means no warnings, ever", () => {
    expect(crewStatus({ crew_target: null, own_crew: 8, booked_ahead: 3 })).toMatchObject({ target: null, over: false });
  });
});

// ──────────────────────────────────────────────────────── weather / rain day
import { weatherSuggestion } from "@/lib/rules";
describe("weatherSuggestion — what to pay when it rains", () => {
  it("suggests the full shift when they were sent home after starting", () => {
    // turned up, worked 2h, rained out: Award inclement-weather thinking says pay the day
    expect(weatherSuggestion({ scheduled: 8, worked: 2, clockedIn: true }).hours).toBe(8);
  });
  it("suggests nothing when they never turned up", () => {
    expect(weatherSuggestion({ scheduled: 8, worked: 0, clockedIn: false }).hours).toBe(0);
  });
  it("suggests what they worked when that is already more than the shift", () => {
    expect(weatherSuggestion({ scheduled: 8, worked: 9, clockedIn: true }).hours).toBe(9);
  });
  it("always explains itself in one sentence", () => {
    expect(weatherSuggestion({ scheduled: 8, worked: 2, clockedIn: true }).why).toMatch(/turned up/i);
  });
});

// ──────────────────────────────── what the simulation taught the matching engine
import { pickBatch, urgencyOf, NEW_WORKER_SHIFTS } from "@/lib/rules";
const w = (id: string, past: number, score: number | null) => ({ user_id: id, past_shifts: past, score, dist_m: 1000, worked_before: false });

describe("pickBatch — one seat per round for someone new", () => {
  it("takes the top of the ranked pool as-is when a new worker is already in it", () => {
    const pool = [w("a", 20, 98), w("new", 0, null), w("c", 15, 90), w("d", 9, 88)];
    expect(pickBatch(pool, 3).map((x) => x.user_id)).toEqual(["a", "new", "c"]);
  });
  it("swaps the last seat for the best new worker when none made the cut", () => {
    const pool = [w("a", 20, 98), w("b", 12, 95), w("c", 15, 90), w("new1", 1, 100), w("new2", 0, null)];
    expect(pickBatch(pool, 3).map((x) => x.user_id)).toEqual(["a", "b", "new1"]);
  });
  it("never reserves a seat when the batch is a single spot — the boss needs a sure thing", () => {
    const pool = [w("a", 20, 98), w("new", 0, null)];
    expect(pickBatch(pool, 1).map((x) => x.user_id)).toEqual(["a"]);
  });
  it("does nothing when there is nobody new", () => {
    const pool = [w("a", 20, 98), w("b", 12, 95), w("c", 15, 90), w("d", 9, 88)];
    expect(pickBatch(pool, 3).map((x) => x.user_id)).toEqual(["a", "b", "c"]);
  });
  it(`"new" means fewer than ${NEW_WORKER_SHIFTS} shifts`, () => {
    expect(NEW_WORKER_SHIFTS).toBe(3);
  });
});

describe("urgencyOf — a shift starting soon wakes more phones, faster", () => {
  it("is urgent inside three hours of the start", () => {
    expect(urgencyOf({ day: "2026-09-15", start_time: "06:30" }, new Date("2026-09-15T04:00:00+10:00"))).toEqual({ urgent: true, batchMultiplier: 9, roundMinutes: 5 });
  });
  it("is normal the evening before", () => {
    expect(urgencyOf({ day: "2026-09-15", start_time: "06:30" }, new Date("2026-09-14T19:00:00+10:00"))).toEqual({ urgent: false, batchMultiplier: 3, roundMinutes: 20 });
  });
});
