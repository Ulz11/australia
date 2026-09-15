import { describe, it, expect } from "vitest";
import { payForDay, AWARD_CASUAL_FLOOR, SUPER_RATE } from "@/lib/award";

describe("payForDay — Award mode (MA000020 casual)", () => {
  it("8h is all ordinary time", () => {
    expect(payForDay(8, 40, "award")).toEqual({ ordinary: 8, ot150: 0, ot200: 0, gross: 320, superAmt: 38.4 });
  });
});

describe("payForDay — overtime split", () => {
  it("10h = 8 ordinary + 2 at 150%", () => {
    expect(payForDay(10, 40, "award")).toMatchObject({ ordinary: 8, ot150: 2, ot200: 0, gross: 440 });
  });
  it("11.5h = 8 + 2 at 150% + 1.5 at 200%", () => {
    expect(payForDay(11.5, 40, "award")).toMatchObject({ ot150: 2, ot200: 1.5, gross: 320 + 120 + 120 });
  });
  it("flat mode is hours × rate, no OT", () => {
    expect(payForDay(11.5, 40, "flat")).toMatchObject({ ordinary: 11.5, ot150: 0, ot200: 0, gross: 460 });
  });
  it("rounds to cents and never returns negative for zero/negative hours", () => {
    expect(payForDay(7.5, 35.55, "award").gross).toBe(266.63);
    expect(payForDay(0, 40, "award").gross).toBe(0);
    expect(payForDay(-2, 40, "award")).toMatchObject({ ordinary: 0, gross: 0, superAmt: 0 });
  });
  it("floor and super constants are the published 2025-26 figures", () => {
    expect(AWARD_CASUAL_FLOOR).toBe(35.55);
    expect(SUPER_RATE).toBe(0.12);
  });
});

// ---------------------------------------------------------------- agreed terms
import { payForShift, type OtTerms } from "@/lib/rules";

describe("payForShift — overtime agreed in advance, Award as the floor", () => {
  const award: OtTerms = { ot_mode: "award", ot_after_hours: 8, ot_multiplier: null };

  it("award terms match payForDay", () => {
    expect(payForShift(10, 40, award).gross).toBe(440);
  });

  it("flat terms pay every hour at the rate when that beats the Award", () => {
    // $60/h flat for 10h = $600; award on $60 would be 8×60 + 2×90 = $660 → Award wins
    const flat: OtTerms = { ot_mode: "flat", ot_after_hours: 8, ot_multiplier: null };
    expect(payForShift(10, 60, flat).gross).toBe(660);
    expect(payForShift(10, 60, flat).appliedFloor).toBe(true);
  });

  it("custom multiplier agreed up front is used when it beats the Award", () => {
    // 2× after 8h on $40: 8×40 + 2×80 = $480, better than award's $440
    const custom: OtTerms = { ot_mode: "custom", ot_after_hours: 8, ot_multiplier: 2 };
    expect(payForShift(10, 40, custom).gross).toBe(480);
    expect(payForShift(10, 40, custom).appliedFloor).toBe(false);
  });

  it("a stingy agreed multiplier can never pay less than the Award", () => {
    // 1.1× after 10h would be $424 — below the Award's $440, so the Award applies
    const stingy: OtTerms = { ot_mode: "custom", ot_after_hours: 10, ot_multiplier: 1.1 };
    const p = payForShift(10, 40, stingy);
    expect(p.gross).toBe(440);
    expect(p.appliedFloor).toBe(true);
  });

  it("says in words what was paid, for the pay screen", () => {
    expect(payForShift(10, 40, { ot_mode: "custom", ot_after_hours: 8, ot_multiplier: 2 }).words)
      .toBe("8h at $40.00, then 2h at 2× ($80.00)");
    expect(payForShift(8, 40, award).words).toBe("8h at $40.00");
  });
});
