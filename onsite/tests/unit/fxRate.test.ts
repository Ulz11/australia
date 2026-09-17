/**
 * Reading a rate out of each source's answer — no database, no network. The answers are trimmed copies of what
 * the Bank of Mongolia and ExchangeRate-API really returned on 17 Sept 2026. The cache, the order of the sources
 * and the invoice around them are tests/integration/fxRate.test.ts.
 */
import { describe, it, expect } from "vitest";
import { AUD_MNT_MAX, AUD_MNT_MIN, FX_TIMEOUT_MS, parseFallback, parseMongolbank, plausibleAudMnt } from "@/lib/fxRate";

const mongolbank = (row: Record<string, unknown>, more: Record<string, unknown>[] = []) => ({
  success: true,
  data: [{ RATE_DATE: "2026-09-17", USD: "3,595.66", EUR: "4,125.48", AUD: "2,559.03", XAU: "15,558,798.36", ...row }, ...more],
  langData: { title: "Official Daily Foreign Exchange Rates" },
});
const exchangeRateApi = (over: Record<string, unknown> = {}) => ({
  result: "success", provider: "https://www.exchangerate-api.com", time_last_update_unix: 1789603351,
  time_last_update_utc: "Thu, 17 Sep 2026 00:02:31 +0000", base_code: "AUD", rates: { AUD: 1, MNT: 2570.295114, USD: 0.710998 }, ...over,
});

describe("the Bank of Mongolia's answer", () => {
  it("is read by the AUD key — never the US dollar beside it — with its thousands separators taken out", () => {
    expect(parseMongolbank(mongolbank({}))).toEqual({ rate: 2559.03, asOf: "2026-09-17" });
  });

  it("takes the latest day when it sends more than one", () => {
    expect(parseMongolbank(mongolbank({}, [{ RATE_DATE: "2026-09-16", AUD: "2,551.10" }, { RATE_DATE: "2026-09-18", AUD: "2,561.00" }])))
      .toEqual({ rate: 2561, asOf: "2026-09-18" });
  });

  it("gives nothing for an answer it can't read, rather than a guess", () => {
    for (const bad of [
      null, "oops", {}, { success: false, data: [] }, { success: true, data: [] }, { success: true, data: "x" },
      mongolbank({ AUD: undefined }), mongolbank({ AUD: "" }), mongolbank({ AUD: "N/A" }), mongolbank({ AUD: "-2,559.03" }),
      mongolbank({ AUD: 2559.03 }), mongolbank({ RATE_DATE: "17/09/2026" }),
    ]) expect(parseMongolbank(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("ExchangeRate-API's answer", () => {
  it("is tögrög per Australian dollar, to two decimals as the Bank of Mongolia gives it, dated by its last update", () => {
    expect(parseFallback(exchangeRateApi())).toEqual({ rate: 2570.3, asOf: "2026-09-17" });
  });

  it("gives nothing unless it is AUD-based and has MNT", () => {
    for (const bad of [
      null, {}, exchangeRateApi({ result: "error" }), exchangeRateApi({ base_code: "USD", rates: { MNT: 3618.8 } }),
      exchangeRateApi({ rates: { AUD: 1 } }), exchangeRateApi({ rates: { MNT: "2570" } }), exchangeRateApi({ time_last_update_unix: null }),
    ]) expect(parseFallback(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("a plausible rate", () => {
  it("is between ₮1,000 and ₮5,000 per A$1 — anything else is a broken source", () => {
    expect([AUD_MNT_MIN, AUD_MNT_MAX, FX_TIMEOUT_MS]).toEqual([1000, 5000, 8000]);
    for (const ok of [1000, 2559.03, 5000]) expect(plausibleAudMnt(ok), String(ok)).toBe(true);
    for (const bad of [0, 25.59, 999.99, 5000.01, 255903, NaN, Infinity]) expect(plausibleAudMnt(bad), String(bad)).toBe(false);
  });
});
