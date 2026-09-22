/**
 * "Still to pay" — the orange number on the pay run, and the one a boss acts on.
 *
 * It has to be per shift. Pay Sam for Monday, leave Wednesday open, and you owe Wednesday; the old
 * per-worker roll-up asked "is Sam square?" and, hearing no, put Sam's whole week back into the total.
 * A boss owing one day was shown a week's wages and went looking for money already out the door.
 */
import { describe, it, expect } from "vitest";
import { payRunTotals } from "@/lib/payRun";
import { payForShift } from "@/lib/rules";

const award = { ot_mode: "award", ot_after_hours: 8, ot_multiplier: null } as const;
/** A day on the run, priced the way the page prices it, so the test moves if the pay maths does. */
const day = (hours: number, rate: number, status: "approved" | "paid") => {
  const p = payForShift(hours, rate, award);
  return { status, gross: p.gross, superAmt: p.superAmt };
};

describe("payRunTotals — a part-paid worker", () => {
  // Two 8-hour days at $40: Monday paid, Tuesday not.
  const run = [day(8, 40, "paid"), day(8, 40, "approved")];

  it("owes the unpaid day only, not the fortnight", () => {
    expect(payRunTotals(run).owed).toBe(320);
  });

  it("still counts both days as wages and super — that is what the week cost", () => {
    const t = payRunTotals(run);
    expect(t.gross).toBe(640);
    expect(t.sup).toBe(76.8);
    expect(t.owed).not.toBe(t.gross);   // the bug: one unpaid day used to drag the paid one back in
  });
});

describe("payRunTotals — the ends of the range", () => {
  it("owes the lot when nothing has been ticked", () => {
    expect(payRunTotals([day(8, 40, "approved"), day(8, 40, "approved")]).owed).toBe(640);
  });

  it("owes nothing once every shift is paid", () => {
    expect(payRunTotals([day(8, 40, "paid"), day(10, 40, "paid")]).owed).toBe(0);
  });

  it("is all zeros on an empty week", () => {
    expect(payRunTotals([])).toEqual({ gross: 0, sup: 0, owed: 0 });
  });
});

describe("payRunTotals — a whole run", () => {
  it("adds up across workers and keeps counting one shift at a time", () => {
    // Sam: a paid 8h day and an unpaid one. Tui: one unpaid 10h day, so two hours of it are overtime.
    const t = payRunTotals([day(8, 40, "paid"), day(8, 40, "approved"), day(10, 40, "approved")]);
    expect(t.gross).toBe(1080);
    expect(t.owed).toBe(760);
    expect(t.sup).toBe(129.6);
  });

  it("carries cents without drifting — a fortnight at the Award floor", () => {
    const t = payRunTotals(Array.from({ length: 10 }, () => day(8, 35.55, "approved")));
    expect(t.gross).toBe(2844);
    expect(t.owed).toBe(2844);
    expect(t.sup).toBe(341.3);
  });
});
