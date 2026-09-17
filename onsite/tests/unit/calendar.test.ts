/**
 * The worker's calendar, the part that needs no browser: what a day shows, and what a tap on it does.
 * The same order worker_free() reads in SQL (migration 017), so the screen can never disagree with what
 * a boss is shown. tests/integration/usualWeek.test.ts runs the SQL side.
 */
import { describe, it, expect } from "vitest";
import { dayState, nextDayState, type DayFacts } from "@/app/worker/Calendar";
import { WEEKDAYS } from "@/app/worker/UsualWeek";

const day = (f: Partial<DayFacts> = {}): DayFacts => ({ booked: false, usual: false, ...f });

describe("what a day shows", () => {
  it("a booking beats everything, then the day's own answer, then the usual week", () => {
    expect(dayState(day({ booked: true, explicit: "busy", usual: true }))).toBe("working");
    expect(dayState(day({ explicit: "free" }))).toBe("free");
    expect(dayState(day({ explicit: "busy", usual: true }))).toBe("busy");
    expect(dayState(day({ usual: true }))).toBe("usual");
    expect(dayState(day())).toBe("busy");
  });
});

describe("what a tap on a day does", () => {
  it("walks round a circle, so two or three taps land back where you started", () => {
    // A plain busy day: busy -> free -> busy (yours) -> back to plain busy.
    expect(nextDayState(day())).toBe("free");
    expect(nextDayState(day({ explicit: "free" }))).toBe("busy");
    expect(nextDayState(day({ explicit: "busy" }))).toBe("clear");
    // A day in the usual week: usually free -> busy (yours) -> back to usually free.
    expect(nextDayState(day({ usual: true }))).toBe("busy");
    expect(nextDayState(day({ explicit: "busy", usual: true }))).toBe("clear");
    // Free by hand on a usual day goes the same way as free by hand anywhere.
    expect(nextDayState(day({ explicit: "free", usual: true }))).toBe("busy");
  });

  it("a tap never leaves a day in a state the screen can't show", () => {
    for (const explicit of [undefined, "free", "busy"])
      for (const usual of [false, true]) {
        const f = day({ explicit, usual });
        const next = nextDayState(f);
        expect(["free", "busy", "clear"]).toContain(next);
        expect(dayState({ ...f, explicit: next === "clear" ? undefined : next })).toBe(
          next === "free" ? "free" : next === "busy" ? "busy" : usual ? "usual" : "busy");
      }
  });
});

describe("the first offer", () => {
  it("is Monday to Friday, and nothing else", () => {
    expect(WEEKDAYS).toEqual([1, 2, 3, 4, 5]);
  });
});
