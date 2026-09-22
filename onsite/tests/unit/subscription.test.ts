/**
 * The billing rules that need no database: the money, the calendar and the words. Everything here is
 * a pure function of what it is handed, so these are the tests that say what the product actually
 * charges — the integration tests only check the writing-down.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DAY_MS, FORTNIGHT_DAYS, FX_UNAVAILABLE, QPAY_NOT_SET_UP, addDays, audCentsToMnt, audMntRate, audMoney, billingBusiness,
  demoBillingWords, dueDateFor, fmtBillingDay, fmtInvoiceDay, fmtRateDay, gstRegistered, invoiceNumber, invoicePaidWords,
  isInvoiceNumber, isOverdue, matchFeeCents, mntWords, moneyCents, nextPeriod, paymentTermsDays, periodSoFar, priceWords,
  qpayDescription, qpayPayable, rateWords, splitGst, tugrik,
} from "@/lib/subscription";
import { parseArgs } from "@/scripts/billing";
import { DemoBillingNote } from "@/app/boss/billing/DemoBillingNote";

afterEach(() => { vi.unstubAllEnvs(); });

describe("what it costs", () => {
  it("has the product's one price as its default, and lets the environment move it", () => {
    expect([matchFeeCents({}), paymentTermsDays({})]).toEqual([200, 7]);
    expect(matchFeeCents({ MATCH_FEE_CENTS: "500" })).toBe(500);
    expect(paymentTermsDays({ PAYMENT_TERMS_DAYS: "21" })).toBe(21);
  });

  it("ignores nonsense in the environment rather than charging a strange number", () => {
    for (const bad of ["", "   ", "free", "-100", "NaN"])
      expect(matchFeeCents({ MATCH_FEE_CENTS: bad }), bad).toBe(200);
    for (const bad of ["", "   ", "soon", "-7", "NaN"])
      expect(paymentTermsDays({ PAYMENT_TERMS_DAYS: bad }), bad).toBe(7);
  });

  it("writes money the way the rest of the app does, and prices in a sentence without dead cents", () => {
    expect(moneyCents(200)).toBe("$2.00");
    expect(moneyCents(4600)).toBe("$46.00");
    expect(moneyCents(123456)).toBe("$1,234.56");
    expect([priceWords(200), priceWords(4600), priceWords(250)]).toEqual(["$2", "$46", "$2.50"]);
  });

  it("gives a boss less time to pay than a fortnight, so one open invoice is the normal state", () => {
    // Terms of a full fortnight would mean every invoice was still inside its window when the next one was
    // raised: a boss would permanently carry two, and "overdue" would only ever mean an invoice a month old.
    expect(paymentTermsDays({})).toBeLessThan(FORTNIGHT_DAYS);
  });
});

describe("GST", () => {
  it("is the eleventh already inside the total, never added on top", () => {
    expect(splitGst(3300, true)).toEqual({ subtotal_cents: 3000, gst_cents: 300, total_cents: 3300 });
    expect(splitGst(200, true)).toEqual({ subtotal_cents: 182, gst_cents: 18, total_cents: 200 });
    // a whole fortnight: nineteen introductions
    expect(splitGst(19 * 200, true)).toEqual({ subtotal_cents: 3455, gst_cents: 345, total_cents: 3800 });
  });

  it("is nothing at all when OnSite is not registered — the total is the same either way", () => {
    expect(splitGst(3800, false)).toEqual({ subtotal_cents: 3800, gst_cents: 0, total_cents: 3800 });
    expect(splitGst(3800, false).total_cents).toBe(splitGst(3800, true).total_cents);
  });

  it("only GST_REGISTERED=1 counts", () => {
    for (const v of ["", "0", "yes", "true", undefined]) expect(gstRegistered({ GST_REGISTERED: v }), String(v)).toBe(false);
    expect(gstRegistered({ GST_REGISTERED: "1" })).toBe(true);
  });

  it("every split adds up, whatever the total", () => {
    for (const cents of [1, 99, 200, 3300, 3800, 12345, 999999]) {
      const s = splitGst(cents, true);
      expect(s.subtotal_cents + s.gst_cents, String(cents)).toBe(s.total_cents);
    }
  });
});

describe("the calendar", () => {
  const at = (iso: string) => new Date(iso);
  /** The wall clock in Sydney, where a boss reads these dates. */
  const syd = (d: Date) => d.toLocaleString("en-AU", { timeZone: "Australia/Sydney", hour12: false, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  it("bills every fortnight, with no gap between periods and no overlap", () => {
    const p = nextPeriod(at("2026-09-16T14:00:00Z"), at("2026-09-30T14:00:00Z"));
    expect(p.start.toISOString()).toBe("2026-09-30T14:00:00.000Z");          // starts where the last one ended
    expect(p.end.toISOString()).toBe("2026-10-14T14:00:00.000Z");
    let start = at("2026-01-06T13:00:00Z"), end = addDays(start, FORTNIGHT_DAYS);
    for (let i = 0; i < 26; i++) {
      const n = nextPeriod(start, end);
      expect(n.start.getTime(), `fortnight ${i}`).toBe(end.getTime());
      expect(n.end.getTime() - n.start.getTime(), `fortnight ${i}`).toBe(FORTNIGHT_DAYS * DAY_MS);
      start = n.start; end = n.end;
    }
  });

  it("is exactly 14 x 24 hours across a daylight saving change, both ways", () => {
    // Sydney's clocks go forward on 4 October 2026 and back on 5 April. A period built by setting a calendar
    // date would be 13 days 23 hours one fortnight a year and 14 days 1 hour another, and the boundary would
    // walk an hour further every six months until a boss's fortnight closed at 3am.
    const forward = nextPeriod(at("2026-09-16T14:00:00Z"), at("2026-09-30T14:00:00Z"));
    expect(forward.end.getTime() - forward.start.getTime()).toBe(FORTNIGHT_DAYS * DAY_MS);
    expect(forward.end.toISOString()).toBe("2026-10-14T14:00:00.000Z");
    expect([syd(forward.start), syd(forward.end)]).toEqual(["01/10, 00:00", "15/10, 01:00"]);   // +10 → +11

    const back = nextPeriod(at("2026-03-15T13:00:00Z"), at("2026-03-29T13:00:00Z"));
    expect(back.end.getTime() - back.start.getTime()).toBe(FORTNIGHT_DAYS * DAY_MS);
    expect(back.end.toISOString()).toBe("2026-04-12T13:00:00.000Z");
    expect([syd(back.start), syd(back.end)]).toEqual(["30/03, 00:00", "12/04, 23:00"]);         // +11 → +10
  });

  it("gives an invoice PAYMENT_TERMS_DAYS to be paid — seven by default, and whatever the environment says", () => {
    expect(dueDateFor(at("2026-09-20T03:00:00Z"), {}).toISOString()).toBe("2026-09-27T03:00:00.000Z");
    expect(dueDateFor(at("2026-09-20T03:00:00Z"), { PAYMENT_TERMS_DAYS: "21" }).toISOString()).toBe("2026-10-11T03:00:00.000Z");
    expect(dueDateFor(at("2026-09-20T03:00:00Z"), { PAYMENT_TERMS_DAYS: "0" }).toISOString()).toBe("2026-09-20T03:00:00.000Z");
    expect(dueDateFor(at("2026-09-20T03:00:00Z"), { PAYMENT_TERMS_DAYS: "next week" }).toISOString()).toBe("2026-09-27T03:00:00.000Z");
    // and the due date is an instant too: a week is a week whatever the clocks do in the middle of it
    expect(dueDateFor(at("2026-10-01T13:00:00Z"), {}).getTime() - at("2026-10-01T13:00:00Z").getTime()).toBe(7 * DAY_MS);
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

/**
 * What the boss is told about where he stands used to live here — statusWords() and upsellWords(), the trial
 * countdown, "Cancelling — pay tools until…", "Not subscribed". Those cases are gone rather than rewritten,
 * because the thing they described is gone: there is no status, nothing lapses and nothing is switched off.
 * The only words a boss now reads about money are a count of introductions and a total.
 */
describe("this fortnight so far", () => {
  it("is a multiplication over introductions and nothing else", () => {
    expect(periodSoFar({ matches: 3 }, {})).toEqual({ matches: 3, fee: 200, totalCents: 600 });
    expect(periodSoFar({ matches: 1 }, {})).toEqual({ matches: 1, fee: 200, totalCents: 200 });
    expect(periodSoFar({ matches: 19 }, {}).totalCents).toBe(3800);
  });

  it("charges a quiet fortnight nothing at all — a real answer the screens say in words, not as a $0.00 tile", () => {
    expect(periodSoFar({ matches: 0 }, {})).toEqual({ matches: 0, fee: 200, totalCents: 0 });
  });

  it("counts at the fee the environment is set to, not at one baked in when the page was built", () => {
    expect(periodSoFar({ matches: 4 }, { MATCH_FEE_CENTS: "500" })).toEqual({ matches: 4, fee: 500, totalCents: 2000 });
  });
});

describe("paying through QPay — the tögrög amount", () => {
  it("is the AUD total at the rate, in whole tögrög", () => {
    expect(audCentsToMnt(3200, "2250")).toBe(72000);
    expect(audCentsToMnt(3800, "2250")).toBe(85500);
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
