/**
 * One grace, read the same way twice.
 *
 * The worker's record (lib/profileStats.ts `onTime`) and the boss's clock-in label (lib/rules.ts
 * `clockInLooks`) used to carry their own grace period — 10 minutes on one screen, 15 on the other. A
 * worker who clocked in twelve minutes late was on time on their own record and late on the boss's, for
 * the identical event, and there was nothing on either screen to explain the difference. These tests pin
 * both readings to the same constant, so the two can never drift apart again without a failure here.
 */
import { describe, it, expect } from "vitest";
import * as rules from "@/lib/rules";
import { ON_TIME_GRACE_MIN, clockInLooks } from "@/lib/rules";
import { ON_TIME_GRACE_MIN as GRACE_ON_THE_RECORD, minutesLate, onTime } from "@/lib/profileStats";

const shift = { day: "2026-09-05", start_time: "06:30" };          // a Saturday, AEST: Sydney is not on DST in September
const start = Date.parse("2026-09-05T06:30:00+10:00");
/** The clock-in instant, `late` minutes after the agreed start. */
const clockedInAt = (late: number) => new Date(start + late * 60_000).toISOString();

describe("the on-time grace is a single number", () => {
  it("is ten minutes, and the record and the rules hold the very same constant", () => {
    expect(ON_TIME_GRACE_MIN).toBe(10);
    expect(GRACE_ON_THE_RECORD).toBe(ON_TIME_GRACE_MIN);
  });

  it("the second grace is gone, not merely unused", () => {
    expect("ON_TIME_MIN" in rules).toBe(false);
  });
});

describe("both readings of one clock-in agree, right across the boundary", () => {
  it("inside the grace: on time on the record, good on the boss's screen", () => {
    for (const late of [-30, 0, 5, 10]) {
      const at = clockedInAt(late);
      expect(clockInLooks(shift, { dist_m: 50, at }), `${late} min`).toBe("good");
      expect(onTime(minutesLate(shift.day, shift.start_time, at)), `${late} min`).toBe(true);
    }
  });

  it("past the grace: late on both, including the 11-15 minute window the two used to fight over", () => {
    for (const late of [11, 12, 15, 16, 45]) {
      const at = clockedInAt(late);
      expect(clockInLooks(shift, { dist_m: 50, at }), `${late} min`).toBe("late");
      expect(onTime(minutesLate(shift.day, shift.start_time, at)), `${late} min`).toBe(false);
    }
  });
});
