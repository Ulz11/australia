/**
 * The rules behind the record (lib/profileStats.ts), with no database in sight: what shade a day gets, where
 * a week starts, what counts as a streak, what counts as on time, and when a figure is allowed to be a
 * percentage at all. Plus the ABN check the boss's settings form leans on.
 */
import { describe, it, expect } from "vitest";
import {
  fillWords, heatmapGrid, hoursLevel, lastMonths, median, minutesLate, onTime, peopleLevel, share, SMALL_N,
  weekStreak, workerFacts, type Level, type WorkerShift,
} from "@/lib/profileStats";
import { cleanAbn } from "@/lib/validate";

/** A grid of `weeks` weeks ending in the week of `today`, with these days worked. */
const grid = (worked: Record<string, number>, today: string, weeks = 4) =>
  heatmapGrid(new Map(Object.entries(worked).map(([d, h]) => [d, hoursLevel(h)] as [string, Level])), today, weeks);

describe("how dark a day is drawn", () => {
  it("a worker's day: nothing, short, normal, long", () => {
    expect([0, -1, 0.0].map(hoursLevel)).toEqual([0, 0, 0]);
    expect([0.5, 3.9].map(hoursLevel)).toEqual([1, 1]);
    expect([4, 6, 8].map(hoursLevel)).toEqual([2, 2, 2]);
    expect([8.1, 12].map(hoursLevel)).toEqual([3, 3]);
  });

  it("a boss's day counts people, not hours", () => {
    expect([0, 1, 2, 3, 4, 40].map(peopleLevel)).toEqual([0, 1, 2, 2, 3, 3]);
  });
});

describe("the grid", () => {
  // Friday 18 Sept 2026. Its week starts Monday the 14th.
  const today = "2026-09-18";

  it("is 52 weeks by 7 days, Monday first, ending in the week we are in", () => {
    const weeks = heatmapGrid(new Map(), today);
    expect(weeks).toHaveLength(52);
    expect(weeks.every((w) => w.days.length === 7)).toBe(true);
    expect(weeks[51].start).toBe("2026-09-14");
    expect(weeks[51].days[0]?.day).toBe("2026-09-14");
    expect(weeks[0].start).toBe("2025-09-22");
    // every week starts on a Monday
    expect(weeks.every((w) => new Date(w.start + "T00:00:00Z").getUTCDay() === 1)).toBe(true);
  });

  it("stops at today: the rest of this week is empty, not zero", () => {
    const [, , , week] = grid({ "2026-09-18": 8 }, today);
    expect(week.days.map((d) => d?.day ?? null))
      .toEqual(["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", null, null]);
    expect(week.days[4]!.level).toBe(2);
    expect(week.days[0]!.level).toBe(0);
  });

  it("puts a day in the right week and the right row", () => {
    const weeks = grid({ "2026-09-06": 9, "2026-09-07": 2 }, today);
    expect(weeks[1].days[6]).toEqual({ day: "2026-09-06", level: 3 });   // Sunday of the week before last
    expect(weeks[2].days[0]).toEqual({ day: "2026-09-07", level: 1 });   // the Monday after it
  });
});

describe("weeks in a row", () => {
  const today = "2026-09-18";

  it("counts back from this week", () => {
    expect(weekStreak(grid({ "2026-09-15": 8, "2026-09-08": 8, "2026-09-01": 8 }, today))).toBe(3);
  });

  it("counts back from last week when this one hasn't started yet", () => {
    expect(weekStreak(grid({ "2026-09-08": 8, "2026-09-01": 8 }, today))).toBe(2);
  });

  it("stops at the first empty week, and a gap two weeks back doesn't count", () => {
    expect(weekStreak(grid({ "2026-09-15": 8, "2026-09-01": 8 }, today))).toBe(1);
    expect(weekStreak(grid({}, today))).toBe(0);
    // one empty week is forgiven only when it is the week we are still in — not the one before it
    expect(weekStreak(grid({ "2026-09-01": 8 }, today))).toBe(0);
  });
});

describe("clocking in on time", () => {
  // Sydney is UTC+10 in September: a 06:30 start is 20:30 UTC the day before.
  const day = "2026-09-18", start = "06:30";

  it("measures lateness in site time, not the server's", () => {
    expect(minutesLate(day, start, "2026-09-17T20:30:00Z")).toBe(0);
    expect(minutesLate(day, start, "2026-09-17T20:41:00Z")).toBe(11);
    expect(minutesLate(day, start, "2026-09-17T20:00:00Z")).toBe(-30);
    expect(minutesLate(day, "06:30:00", "2026-09-17T20:30:00Z")).toBe(0);      // a time straight out of Postgres
  });

  it("a clock-in on the next Sydney day is a day late, not a few minutes early", () => {
    expect(minutesLate(day, start, "2026-09-18T20:30:00Z")).toBe(1440);
  });

  it("ten minutes is on time; eleven is not", () => {
    expect([-30, 0, 10].map(onTime)).toEqual([true, true, true]);
    expect([11, 45, 1440].map(onTime)).toEqual([false, false, false]);
  });
});

describe("percentages need a denominator worth one", () => {
  it("counts under five, a percentage from five up, a dash for nothing", () => {
    expect(share(4, 4)).toBe("4 of 4");
    expect(share(0, 1)).toBe("0 of 1");
    expect(share(5, 5)).toBe("100%");
    expect(share(46, 48)).toBe("96%");
    expect(share(0, 0)).toBe("—");
    expect(SMALL_N).toBe(5);
  });
});

describe("how long a shift takes to fill", () => {
  it("picks the unit that suits the number", () => {
    expect(fillWords(null)).toBe("—");
    expect(fillWords(41)).toBe("41 min");
    expect(fillWords(0.2)).toBe("1 min");                 // faster than a minute is still a minute
    expect(fillWords(90)).toBe("90 min");                 // not rounded up into "2 h"
    expect(fillWords(200)).toBe("3 h");
    expect(fillWords(2880)).toBe("2 days");
    expect(fillWords(-5)).toBe("—");
  });

  it("the middle one, not the average — one shift nobody took can't move it", () => {
    expect(median([])).toBe(null);
    expect(median([7])).toBe(7);
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 20, 30, 40])).toBe(25);
    expect(median([5, 5, 5, 100000])).toBe(5);
  });
});

describe("the last twelve months", () => {
  it("ends with the month we are in and crosses the year", () => {
    const m = lastMonths("2026-09-18");
    expect(m).toHaveLength(12);
    expect(m[11]).toEqual({ key: "2026-09", label: "Sept" });
    expect(m[0]).toEqual({ key: "2025-10", label: "Oct" });
  });
});

describe("what a shift list says about a worker", () => {
  const shift = (o: Partial<WorkerShift>): WorkerShift => ({
    day: "2026-09-15", start_time: "06:30", status: "approved", hours: 8, hours_worked: 8, hours_approved: 8,
    clock_in_at: null, disputed_at: null, role: "Formwork", project_id: "site-a", ...o,
  });

  it("counts hours, shifts, sites and trades off the worked rows only", () => {
    const f = workerFacts([
      shift({}),
      shift({ day: "2026-09-16", project_id: "site-b", role: "Concreting", hours_approved: 6 }),
      shift({ day: "2026-09-17", status: "accepted", hours_approved: null, hours_worked: null }),   // not worked yet
      shift({ day: "2026-09-18", status: "cancelled", hours_approved: null, hours_worked: null }),
    ], { past_shifts: 4, showed: 3, cancels: 1 }, "2026-09-18");

    expect({ shifts: f.shifts, hours: f.hours, sites: f.sites }).toEqual({ shifts: 2, hours: 14, sites: 2 });
    expect(f.trades).toEqual([{ role: "Formwork", hours: 8 }, { role: "Concreting", hours: 6 }]);
    expect(f.months[11]).toEqual({ key: "2026-09", label: "Sept", hours: 14 });
    expect(f.reliability).toMatchObject({ showed: 3, past: 4, pulled: 1, disagreed: 0, ofWorked: 2 });
  });

  it("uses approved hours where there are any, and the worker's own where there aren't", () => {
    const f = workerFacts([
      shift({ hours_approved: null, hours_worked: 7.5, status: "clocked_out" }),
      shift({ day: "2026-09-16", hours_approved: 3 }),
    ], {}, "2026-09-18");
    expect(f.hours).toBe(10.5);
    expect(f.weeks[51].days.map((d) => d?.level ?? null)).toEqual([0, 2, 1, 0, 0, null, null]);
    expect(f.days).toBe(2);
  });

  it("counts clock-ins on time, and only shifts that had one", () => {
    const f = workerFacts([
      shift({ clock_in_at: "2026-09-14T20:35:00Z", day: "2026-09-15" }),   // 5 min late
      shift({ clock_in_at: "2026-09-15T20:55:00Z", day: "2026-09-16" }),   // 25 min late
      shift({ status: "accepted", day: "2026-09-17" }),                    // never turned up
    ], {}, "2026-09-18");
    expect(f.reliability.clockIns).toBe(2);
    expect(f.reliability.onTime).toBe(1);
  });

  it("an empty record still comes back finished, not broken", () => {
    const f = workerFacts([], {}, "2026-09-18");
    expect({ shifts: f.shifts, hours: f.hours, sites: f.sites, days: f.days, streak: f.streak }).toEqual({ shifts: 0, hours: 0, sites: 0, days: 0, streak: 0 });
    expect(f.weeks).toHaveLength(52);
    expect(f.trades).toEqual([]);
    expect(f.months).toHaveLength(12);
  });
});

describe("an ABN is checked, not just counted", () => {
  it("takes a real one, in any spacing, and keeps only the digits", () => {
    expect(cleanAbn("51824753556")).toBe("51824753556");
    expect(cleanAbn(" 51 824 753 556 ")).toBe("51824753556");
  });

  it("turns down anything that fails the sum or isn't eleven digits", () => {
    expect(cleanAbn("51824753557")).toBe(null);            // one digit out
    expect(cleanAbn("51824753565")).toBe(null);            // two digits swapped
    expect(cleanAbn("5182475355")).toBe(null);             // ten
    expect(cleanAbn("518247535561")).toBe(null);           // twelve
    expect(cleanAbn("")).toBe(null);
    expect(cleanAbn(null)).toBe(null);
    expect(cleanAbn(undefined)).toBe(null);
    expect(cleanAbn("abcdefghijk")).toBe(null);
  });
});
