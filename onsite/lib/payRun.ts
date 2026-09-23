import { round2 } from "./award";

/** One approved day on the pay run: what it came to, and whether the boss has ticked it paid. */
export type PayRunShift = { status: string; gross: number; superAmt: number };

/**
 * The three numbers across the top of the pay run.
 *
 * "Still to pay" is counted a shift at a time, never a worker at a time. A boss who has paid Sam for
 * Monday and Tuesday but not Wednesday owes Wednesday — but rolling the week up per worker and asking
 * "is this worker square?" put Sam's whole week back into the total, so the orange hero number could
 * say $1,400 when the real debt was $320 and the boss went hunting for money that had already left his
 * account. Wages and super are the opposite: they are what the week cost, paid or not, so they count
 * every shift. Rounded at each step because a fortnight of cents otherwise drifts off the payslips.
 */
export function payRunTotals(shifts: PayRunShift[]): { gross: number; sup: number; owed: number } {
  return shifts.reduce(
    (a, s) => ({
      gross: round2(a.gross + s.gross),
      sup: round2(a.sup + s.superAmt),
      owed: round2(a.owed + (s.status === "paid" ? 0 : s.gross)),
    }),
    { gross: 0, sup: 0, owed: 0 },
  );
}
