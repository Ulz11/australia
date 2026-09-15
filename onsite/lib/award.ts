/**
 * Building and Construction General On-site Award 2020 (MA000020), casual.
 * Numbers here are the MVP's stated floor; update on 1 July each year.
 * Level 1 (CW/ECW 1) casual hourly incl. 25% loading.
 */
export const AWARD_CASUAL_FLOOR = 35.55;
export const SUPER_RATE = 0.12; // from 1 July 2025
export const ORDINARY_HOURS_PER_DAY = 8;

export type PayLine = { ordinary: number; ot150: number; ot200: number; gross: number; superAmt: number };

/**
 * Award mode: first 8h at rate, next 2h at 150%, then 200%.
 * Flat mode: hours x rate. Super is always shown separately (boss pays it on top).
 */
export function payForDay(hoursIn: number, rate: number, mode: "award" | "flat"): PayLine {
  const hours = Number.isFinite(hoursIn) ? Math.max(0, hoursIn) : 0;
  let ordinary = hours, ot150 = 0, ot200 = 0;
  if (mode === "award") {
    ordinary = Math.min(hours, ORDINARY_HOURS_PER_DAY);
    const over = Math.max(0, hours - ORDINARY_HOURS_PER_DAY);
    ot150 = Math.min(over, 2);
    ot200 = Math.max(0, over - 2);
  }
  const gross = round2(ordinary * rate + ot150 * rate * 1.5 + ot200 * rate * 2);
  return { ordinary, ot150, ot200, gross, superAmt: round2(gross * SUPER_RATE) };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const money = (n: number) => "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const TICKETS: Record<string, string> = {
  WC: "White Card",
  LF: "Forklift (LF)",
  WP: "EWP over 11m (WP)",
  DG: "Dogging (DG)",
  SB: "Basic scaffolding (SB)",
};
