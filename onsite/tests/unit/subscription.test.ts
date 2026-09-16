/**
 * The billing rules that need no database: the money, the calendar and the words. Everything here is
 * a pure function of what it is handed, so these are the tests that say what the product actually
 * charges — the integration tests only check the writing-down.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  addMonths, billingBusiness, dueDateFor, fmtBillingDay, fmtInvoiceDay, gstRegistered, invoiceNumber,
  isInvoiceNumber, matchFeeCents, money, payInstructions, periodSoFar, priceWords, splitGst,
  statusWords, subscriptionCents, trialDays, trialEndFrom, upsellWords,
} from "@/lib/subscription";
import { parseArgs } from "@/scripts/billing";

afterEach(() => { vi.unstubAllEnvs(); });

describe("what it costs", () => {
  it("has the product's prices as its defaults, and lets the environment move them", () => {
    expect([matchFeeCents({}), subscriptionCents({}), trialDays({})]).toEqual([200, 3300, 3]);
    expect(matchFeeCents({ MATCH_FEE_CENTS: "500" })).toBe(500);
    expect(subscriptionCents({ SUBSCRIPTION_CENTS: "4400" })).toBe(4400);
    expect(trialDays({ TRIAL_DAYS: "14" })).toBe(14);
  });

  it("ignores nonsense in the environment rather than charging a strange number", () => {
    for (const bad of ["", "   ", "free", "-100", "NaN"])
      expect(matchFeeCents({ MATCH_FEE_CENTS: bad }), bad).toBe(200);
  });

  it("writes money the way the rest of the app does, and prices in a sentence without dead cents", () => {
    expect(money(3300)).toBe("$33.00");
    expect(money(200)).toBe("$2.00");
    expect(money(123456)).toBe("$1,234.56");
    expect([priceWords(3300), priceWords(200), priceWords(250)]).toEqual(["$33", "$2", "$2.50"]);
  });
});

describe("GST", () => {
  it("is the eleventh already inside the total, never added on top", () => {
    expect(splitGst(3300, true)).toEqual({ subtotal_cents: 3000, gst_cents: 300, total_cents: 3300 });
    expect(splitGst(200, true)).toEqual({ subtotal_cents: 182, gst_cents: 18, total_cents: 200 });
    // a whole invoice: subscription + three matches
    expect(splitGst(3300 + 3 * 200, true)).toEqual({ subtotal_cents: 3545, gst_cents: 355, total_cents: 3900 });
  });

  it("is nothing at all when OnSite is not registered — the total is the same either way", () => {
    expect(splitGst(3300, false)).toEqual({ subtotal_cents: 3300, gst_cents: 0, total_cents: 3300 });
    expect(splitGst(3900, false).total_cents).toBe(splitGst(3900, true).total_cents);
  });

  it("only GST_REGISTERED=1 counts", () => {
    for (const v of ["", "0", "yes", "true", undefined]) expect(gstRegistered({ GST_REGISTERED: v }), String(v)).toBe(false);
    expect(gstRegistered({ GST_REGISTERED: "1" })).toBe(true);
  });

  it("every split adds up, whatever the total", () => {
    for (const cents of [1, 99, 200, 3300, 3500, 12345, 999999]) {
      const s = splitGst(cents, true);
      expect(s.subtotal_cents + s.gst_cents, String(cents)).toBe(s.total_cents);
    }
  });
});

describe("the calendar", () => {
  const at = (iso: string) => new Date(iso);

  it("bills on the anniversary, with no proration", () => {
    expect(addMonths(at("2026-09-20T03:00:00Z"), 1).toISOString()).toBe("2026-10-20T03:00:00.000Z");
    expect(addMonths(at("2026-09-20T03:00:00Z"), 12).toISOString()).toBe("2027-09-20T03:00:00.000Z");
  });

  it("lands on the last day of a month too short for the anniversary, and never skips into the next one", () => {
    expect(addMonths(at("2026-01-31T03:00:00Z"), 1).toISOString()).toBe("2026-02-28T03:00:00.000Z");
    expect(addMonths(at("2028-01-31T03:00:00Z"), 1).toISOString()).toBe("2028-02-29T03:00:00.000Z");   // leap year
    expect(addMonths(at("2026-03-31T03:00:00Z"), 1).toISOString()).toBe("2026-04-30T03:00:00.000Z");
  });

  it("steps a month at a time without drifting off the billing day", () => {
    let d = at("2026-01-15T03:00:00Z");
    for (let i = 0; i < 24; i++) { d = addMonths(d, 1); expect(d.getUTCDate()).toBe(15); }
    expect(d.toISOString()).toBe("2028-01-15T03:00:00.000Z");
  });

  it("gives a new boss three days, and an invoice two weeks to be paid", () => {
    expect(trialEndFrom(at("2026-09-17T03:00:00Z"), {}).toISOString()).toBe("2026-09-20T03:00:00.000Z");
    expect(dueDateFor(at("2026-09-20T03:00:00Z")).toISOString()).toBe("2026-10-04T03:00:00.000Z");
  });

  it("writes dates in Sydney, the way a boss reads them", () => {
    expect(fmtBillingDay("2026-09-20T05:00:00Z")).toBe("Sun 20 Sept");
    expect(fmtInvoiceDay("2026-09-20T05:00:00Z")).toBe("20 September 2026");
    // 09:30 UTC is the next morning in Sydney — the date a boss sees is the Sydney one.
    expect(fmtBillingDay("2026-09-20T23:30:00Z")).toBe("Mon 21 Sept");
  });
});

describe("invoice numbers", () => {
  it("are the year and that year's count, padded", () => {
    expect(invoiceNumber(2026, 123)).toBe("OS-2026-000123");
    expect(invoiceNumber(2026, 1)).toBe("OS-2026-000001");
    expect(invoiceNumber(2027, 999999)).toBe("OS-2027-999999");
  });

  it("are recognised exactly, so a typed one can't reach the database as a guess", () => {
    expect(isInvoiceNumber("OS-2026-000123")).toBe(true);
    for (const bad of ["OS-2026-123", "os-2026-000123", "OS-26-000123", "OS-2026-0001234", "000123", "", "OS-2026-00012a"])
      expect(isInvoiceNumber(bad), bad).toBe(false);
  });
});

describe("what the boss is told", () => {
  const state = (status: "trialing" | "active" | "cancelling" | "lapsed") =>
    ({ status, trial_ends_at: "2026-09-20T05:00:00Z", period_ends_at: "2026-10-20T05:00:00Z" });

  it("says where they stand in one sentence, with the date and the price in it", () => {
    expect(statusWords(state("trialing")).title).toBe("Free trial — ends Sun 20 Sept, then $33.00 a month");
    expect(statusWords(state("active")).title).toBe("Subscribed — next invoice Tue 20 Oct");
    expect(statusWords(state("cancelling")).title).toBe("Cancelling — pay tools until Tue 20 Oct");
    expect(statusWords(state("lapsed")).title).toBe("Not subscribed");
  });

  it("never shows an empty date when there isn't one", () => {
    for (const status of ["trialing", "active", "cancelling", "lapsed"] as const) {
      const w = statusWords({ status, trial_ends_at: null, period_ends_at: null });
      expect(w.title, status).not.toMatch(/null|undefined|Invalid/);
      expect(w.sub, status).toBeTruthy();
    }
  });

  it("tells a lapsed boss when the trial ended and what the pay tools cost", () => {
    const w = upsellWords("2026-09-20T05:00:00Z");
    expect(w.title).toBe("Your free trial ended on Sun 20 Sept.");
    expect(w.sub).toBe("The pay run, approvals record and export are $33.00 a month.");
    expect(upsellWords(null).title).not.toMatch(/null|Invalid/);
  });
});

describe("this period so far", () => {
  it("counts the matches at the match fee and the month ahead at the subscription", () => {
    expect(periodSoFar({ matches: 3, status: "active" }, {}))
      .toMatchObject({ matchCents: 600, nextSubscription: 3300, totalCents: 3900 });
  });

  it("stops counting the next month once the subscription is ending or gone", () => {
    for (const status of ["cancelling", "lapsed"] as const)
      expect(periodSoFar({ matches: 2, status }, {}), status)
        .toMatchObject({ matchCents: 400, nextSubscription: 0, totalCents: 400 });
  });

  it("charges a boss with no matches the subscription and nothing else", () => {
    expect(periodSoFar({ matches: 0, status: "active" }, {}).totalCents).toBe(3300);
  });
});

describe("what an invoice says about paying it", () => {
  it("never invents bank details — without instructions it promises to send them", () => {
    expect(payInstructions({})).toBe("We'll send you payment details.");
    expect(payInstructions({ BILLING_PAY_INSTRUCTIONS: "   " })).toBe("We'll send you payment details.");
    expect(payInstructions({ BILLING_PAY_INSTRUCTIONS: " Transfer to the account on your welcome email. " }))
      .toBe("Transfer to the account on your welcome email.");
  });

  it("shows a From block only when there is a business name to put in it", () => {
    expect(billingBusiness({})).toBeNull();
    expect(billingBusiness({ BUSINESS_ABN: "12 345 678 901" })).toBeNull();
    expect(billingBusiness({ BUSINESS_NAME: "OnSite Pty Ltd" })).toEqual({ name: "OnSite Pty Ltd", abn: null });
    expect(billingBusiness({ BUSINESS_NAME: "OnSite Pty Ltd", BUSINESS_ABN: "12 345 678 901" }))
      .toEqual({ name: "OnSite Pty Ltd", abn: "12345678901" });
  });
});

describe("npm run billing:… — arguments", () => {
  it("lists", () => {
    expect(parseArgs(["list"])).toEqual({ cmd: "list" });
    expect(parseArgs(["list", "OS-2026-000123"])).toMatchObject({ cmd: "help", error: expect.any(String) });
  });

  it("marks one paid, with an optional note", () => {
    expect(parseArgs(["paid", "OS-2026-000123"])).toEqual({ cmd: "paid", number: "OS-2026-000123", note: null });
    expect(parseArgs(["paid", "OS-2026-000123", "--note", "Transfer 17/9"])).toEqual({ cmd: "paid", number: "OS-2026-000123", note: "Transfer 17/9" });
  });

  it("refuses anything that isn't an invoice number rather than guessing at one", () => {
    expect(parseArgs(["paid"])).toMatchObject({ cmd: "help", error: expect.stringMatching(/Which invoice/) });
    expect(parseArgs(["paid", "123"])).toMatchObject({ cmd: "help", error: expect.stringMatching(/not an invoice number/) });
    expect(parseArgs(["paid", "OS-2026-000123", "OS-2026-000124"])).toMatchObject({ cmd: "help", error: expect.any(String) });
    expect(parseArgs(["paid", "OS-2026-000123", "--void"])).toMatchObject({ cmd: "help", error: expect.stringMatching(/Unknown option/) });
    expect(parseArgs(["refund", "OS-2026-000123"])).toMatchObject({ cmd: "help", error: expect.stringMatching(/Unknown command/) });
    expect(parseArgs([])).toEqual({ cmd: "help" });
  });
});
