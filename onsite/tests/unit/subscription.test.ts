/**
 * The billing rules that need no database: the money, the calendar and the words. Everything here is
 * a pure function of what it is handed, so these are the tests that say what the product actually
 * charges — the integration tests only check the writing-down.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FX_UNAVAILABLE, QPAY_NOT_SET_UP, addMonths, audCentsToMnt, audMntRate, audMoney, billingBusiness, demoBillingWords, dueDateFor,
  fmtBillingDay, fmtInvoiceDay, fmtRateDay, gstRegistered, invoiceNumber, invoicePaidWords, isInvoiceNumber, isOverdue,
  matchFeeCents, mntWords, money, periodSoFar, priceWords, qpayDescription, qpayPayable, rateWords, splitGst,
  statusWords, subscriptionCents, trialDays, trialEndFrom, tugrik, upsellWords,
} from "@/lib/subscription";
import { parseArgs } from "@/scripts/billing";
import { DemoBillingNote } from "@/app/boss/billing/DemoBillingNote";

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

describe("paying through QPay — the tögrög amount", () => {
  it("is the AUD total at the rate, in whole tögrög", () => {
    expect(audCentsToMnt(3200, "2250")).toBe(72000);
    expect(audCentsToMnt(3300, "2250")).toBe(74250);
    expect(audCentsToMnt(200, "2250")).toBe(4500);
  });

  it("rounds up, never down — a tögrög over, never a tögrög under", () => {
    expect(audCentsToMnt(1, "2250")).toBe(23);                       // 22.5
    expect(audCentsToMnt(3300, "2268.54")).toBe(74862);              // 74,861.82
    expect(audCentsToMnt(3510, "2268.54")).toBe(79626);              // 79,625.754
    expect(audCentsToMnt(3300, "2268.5")).toBe(74861);               // 74,860.5
  });

  it("is exact where floating point isn't: 14 cents at 2250 is 315, not 316", () => {
    expect(Math.ceil((14 / 100) * 2250)).toBe(316);                  // the trap the integer arithmetic avoids
    expect(audCentsToMnt(14, "2250")).toBe(315);
    // across every total up to $300, it agrees with the rule worked in exact rationals
    for (let c = 0; c <= 30000; c++) {
      const want = Math.floor((c * 226854 + 9999) / 10000);         // ceil(c × 2268.54 / 100), all integers
      if (audCentsToMnt(c, "2268.54") !== want) throw new Error(`${c} cents → ${audCentsToMnt(c, "2268.54")}, want ${want}`);
    }
  });

  it("refuses to work in part-cents or with a rate that isn't a positive number", () => {
    expect(() => audCentsToMnt(12.5, "2250")).toThrow();
    expect(() => audCentsToMnt(100, "0")).toThrow();
    expect(() => audCentsToMnt(100, "abc")).toThrow();
  });

  it("reads the rate from AUD_MNT_RATE, and treats anything but a plain positive number as unset", () => {
    expect(audMntRate({ AUD_MNT_RATE: "2250" })).toBe("2250");
    expect(audMntRate({ AUD_MNT_RATE: " 2268.54 " })).toBe("2268.54");
    expect(audMntRate({ AUD_MNT_RATE: "02250" })).toBe("2250");
    for (const bad of [undefined, "", "  ", "0", "0.000", "-2250", "2,250", "2250 MNT", "1e3", "abc", "NaN"])
      expect(audMntRate({ AUD_MNT_RATE: bad }), String(bad)).toBeNull();
  });

  it("writes tögrög with thousands separators, beside the rate per Australian dollar and where it came from", () => {
    expect(tugrik(72000)).toBe("₮72,000");
    expect(tugrik("1234567")).toBe("₮1,234,567");
    expect(audMoney(3300)).toBe("A$33.00");
    expect(fmtRateDay("2026-09-17")).toBe("17 Sept");
    expect(mntWords(77550, { rate: 2350, source: "mongolbank", asOf: "2026-09-17" }))
      .toBe("≈ ₮77,550 · Bank of Mongolia rate for 17 Sept: ₮2,350 per A$1");
    expect(mntWords(84448, { rate: "2559.03", source: "mongolbank", asOf: "2026-09-17" }))
      .toBe("≈ ₮84,448 · Bank of Mongolia rate for 17 Sept: ₮2,559.03 per A$1");
    expect(rateWords({ rate: 2570.3, source: "fallback", asOf: "2026-09-17" })).toBe("ExchangeRate-API rate for 17 Sept: ₮2,570.30 per A$1");
    expect(rateWords({ rate: "2268.54", source: "env", asOf: "2026-09-18" })).toBe("Rate set by OnSite: ₮2,268.54 per A$1");
    // a QR raised before the source and day were kept
    expect(mntWords(72000, { rate: "2250", source: null, asOf: null })).toBe("≈ ₮72,000 at ₮2,250 per A$1");
    expect(FX_UNAVAILABLE).toBe("Couldn't get today's exchange rate — try again in a few minutes.");
  });

  it("tells QPay the invoice number and nothing else", () => {
    expect(qpayDescription("OS-2026-000123")).toBe("OnSite invoice OS-2026-000123");
    expect(invoicePaidWords("OS-2026-000123")).toBe("Invoice OS-2026-000123 paid — thanks.");
  });
});

describe("what an invoice says about paying it", () => {
  it("offers QPay whenever its credentials are set — the rate is looked up at the tap — and never invents bank details without them", () => {
    const creds = () => { vi.stubEnv("QPAY_USERNAME", "u"); vi.stubEnv("QPAY_PASSWORD", "p"); vi.stubEnv("QPAY_INVOICE_CODE", "c"); };
    creds();
    vi.stubEnv("AUD_MNT_RATE", "");
    expect(qpayPayable()).toBe(true);                                // no manual rate needed any more
    vi.stubEnv("AUD_MNT_RATE", "2250");
    vi.stubEnv("QPAY_INVOICE_CODE", "");
    expect(qpayPayable()).toBe(false);                               // no QPay
    expect(QPAY_NOT_SET_UP).toBe("Payment by QPay isn't set up yet — we'll send you payment details.");
  });

  it("is overdue only while open and past its due date", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    expect(isOverdue({ status: "open", due_at: "2026-09-30T23:59:59Z" }, now)).toBe(true);
    expect(isOverdue({ status: "open", due_at: "2026-10-01T00:00:01Z" }, now)).toBe(false);
    expect(isOverdue({ status: "paid", due_at: "2026-09-01T00:00:00Z" }, now)).toBe(false);
    expect(isOverdue({ status: "void", due_at: "2026-09-01T00:00:00Z" }, now)).toBe(false);
  });

  it("the demo notice stops saying 'nothing is charged' the moment QPay can take real money", () => {
    const text = (el: unknown): string => {
      if (el == null || typeof el === "boolean") return "";
      if (typeof el === "string") return el;
      const p = (el as { props?: Record<string, unknown> }).props ?? {};
      return [p.title, p.children].map(text).join("");
    };
    expect(demoBillingWords(false)).toBe("This is a demo — invoices here are examples and nothing is charged.");
    expect(demoBillingWords(true)).toBe("This is a demo, but paying an invoice here sends real money through QPay.");

    vi.stubEnv("DEMO_SITE", "1");
    vi.stubEnv("QPAY_USERNAME", "u"); vi.stubEnv("QPAY_PASSWORD", "p"); vi.stubEnv("QPAY_INVOICE_CODE", "");
    expect(text(DemoBillingNote())).toBe(demoBillingWords(false));
    vi.stubEnv("QPAY_INVOICE_CODE", "c");
    expect(text(DemoBillingNote())).toBe(demoBillingWords(true));
    vi.stubEnv("DEMO_SITE", "");
    expect(DemoBillingNote()).toBeNull();                            // not a demo: no line at all
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
