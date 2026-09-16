import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isExpired, namesMatch, licenceWords, canAutoCheck } from "@/lib/verify";
import { checkLicence } from "@/lib/licenceCheck";
import { resetWhitecardToken } from "@/lib/whitecard";

const BASE = "https://whitecard.test.invalid";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * checkLicence now charges the app's daily register budget before it calls out, and that counter
 * lives in Postgres. Stub it here: these stay unit tests (fast, no DB), and nothing in this file
 * spends the real `whitecard:all` budget that tests/integration/licences.test.ts — which owns the
 * ceiling — is counting in parallel. Flip `budget.room` to stand at the ceiling.
 */
const budget = vi.hoisted(() => ({ room: true }));
vi.mock("@/lib/ratelimit", () => ({ hit: async () => budget.room, refund: async () => {} }));

let calls: string[] = [];
/** Token always works; the register answers with whatever the test hands it. */
function register(...verify: Response[]) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    calls.push(String(url));
    if (String(url).includes("/accesstoken")) return json(200, { access_token: "T1", token_type: "BearerToken", expires_in: "1799" });
    const r = verify.shift();
    if (!r) throw new Error("unexpected verify call");
    return r;
  }));
}
const card = (over: Record<string, unknown> = {}) => ({
  licenceID: "9999", licenceNumber: "CIC1765241", status: "Current", startDate: "01/07/2023", expiryDate: "30/06/2028",
  refusedDate: "", licenceType: "White Card", licenceName: "General Construction Induction Training", licensee: "Batbayar Erdene",
  address: "12 Nowhere Lane", suburb: "MARRICKVILLE", postcode: "2204", ...over,
});
const wc = { kind: "WC" as const, number: "CIC1765241", issued_state: "NSW", holder_name: "Batbayar Erdene" };

beforeEach(() => {
  resetWhitecardToken();
  vi.stubEnv("WHITE_CARD_BASE_URL", BASE);
  vi.stubEnv("WHITE_CARD_API_KEY", "test-key");
  vi.stubEnv("WHITE_CARD_API_SECRET", "test-secret");
  vi.stubEnv("WHITE_CARD_AUTH_HEADER", "");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("licence checking — honest by default", () => {
  it("a state we can't check automatically is 'unchecked', never 'verified'", async () => {
    const r = await checkLicence({ kind: "WC", number: "123456", issued_state: "VIC", holder_name: "Batbayar Erdene" });
    expect(r.status).toBe("unchecked");
    expect(r.note).toMatch(/WorkSafe Victoria/);
  });
  it("NSW with no White Card keys configured falls back to a human check, not a guess", async () => {
    vi.stubEnv("WHITE_CARD_API_KEY", "");
    vi.stubEnv("WHITE_CARD_API_SECRET", "");
    register();
    const r = await checkLicence({ ...wc, number: "123456" });
    expect(r.status).toBe("unchecked");
    expect(r.via).toBe("manual");
    expect(calls).toHaveLength(0);
  });
  it("an out-of-date card is caught locally, no register needed", async () => {
    const r = await checkLicence({ kind: "WC", number: "1", issued_state: "NSW", holder_name: "X Y", expires_on: "2020-01-01" });
    expect(r.status).toBe("expired");
  });
  it("isExpired only counts dates already past", () => {
    expect(isExpired("2020-06-30")).toBe(true);
    expect(isExpired("2099-01-01")).toBe(false);
    expect(isExpired(null)).toBe(false);
    expect(isExpired("")).toBe(false);
    expect(isExpired("N/A")).toBe(false);                  // the register's own word for "no date"
    expect(isExpired("2020-06-30T00:00:00.000Z")).toBe(true);    // a date column read back as a timestamp
  });

  it("a card is good until the end of its day in Sydney, not on the server's clock", () => {
    vi.useFakeTimers();
    try {
      // 11pm Sydney on the expiry day. A UTC server is still on 13:00 of that day.
      vi.setSystemTime(new Date("2026-09-16T13:00:00Z"));
      expect(isExpired("2026-09-16")).toBe(false);
      expect(isExpired("2026-09-15")).toBe(true);
      // 12:30am Sydney the next morning: the card is done, whatever UTC says.
      vi.setSystemTime(new Date("2026-09-16T14:30:00Z"));
      expect(isExpired("2026-09-16")).toBe(true);
      // and the day after tomorrow's card is not expired an hour before Sydney's midnight
      vi.setSystemTime(new Date("2026-09-16T12:59:00Z"));
      expect(isExpired("2026-09-17")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("canAutoCheck is the NSW White Card corner and nothing else", () => {
    expect(canAutoCheck("WC", "NSW")).toBe(true);
    expect(canAutoCheck("LF", "NSW")).toBe(false);
    expect(canAutoCheck("WC", "VIC")).toBe(false);
  });
});

describe("NSW White Card register — what each answer means", () => {
  it("a current card in the right name is verified, with the register's expiry and name", async () => {
    register(json(200, [card()]));
    const r = await checkLicence(wc);
    expect(r).toMatchObject({ status: "verified", via: "safework_nsw", expires_on: "2028-06-30", holder_name: "Batbayar Erdene" });
  });

  it("the live register's shape — 'N/A' dates, no licenceName — still verifies", async () => {
    register(json(200, [{
      licenceID: "1", licenceNumber: "CIC1765241", status: "Current", startDate: "N/A", expiryDate: "N/A", refusedDate: "N/A",
      licenceType: "General Construction Induction Training Card", licenceName: null, licensee: "Batbayar Erdene",
      address: "12 Nowhere Lane", suburb: "MARRICKVILLE", postcode: "2204",
    }]));
    const r = await checkLicence(wc);
    expect(r).toMatchObject({ status: "verified", via: "safework_nsw", expires_on: null });   // no date on the card is not an expired card
  });

  it("a suspended card is not_found, in the register's own word", async () => {
    register(json(200, [card({ status: "Suspended" })]));
    const r = await checkLicence(wc);
    expect(r.status).toBe("not_found");
    expect(r.note).toMatch(/Suspended/);
  });

  it("a card the register calls Expired is expired, whatever its date says", async () => {
    register(json(200, [card({ status: "Expired", expiryDate: "2099-01-01" })]));
    const r = await checkLicence(wc);
    expect(r).toMatchObject({ status: "expired", via: "safework_nsw" });
  });

  it("nothing on the register is not_found", async () => {
    register(json(200, []));
    const r = await checkLicence(wc);
    expect(r).toMatchObject({ status: "not_found", via: "safework_nsw" });
    expect(r.note).toMatch(/no White Card with that number/);
  });

  it("a result for some other number is not a result for this one", async () => {
    register(json(200, [card({ licenceNumber: "CIC9999999" })]));
    expect((await checkLicence(wc)).status).toBe("not_found");
  });

  it("a card in someone else's name is a mismatch that does not say whose", async () => {
    register(json(200, [card({ licensee: "Tom Walsh" })]));
    const r = await checkLicence(wc);
    expect(r.status).toBe("mismatch");
    // Anyone can type a number into that form. The answer must not hand back a stranger's name —
    // not in the sentence the worker reads, not in the field that gets stored.
    expect(r.note).not.toMatch(/Tom|Walsh/i);
    expect(r.holder_name ?? null).toBeNull();
    expect(JSON.stringify(r)).not.toContain("Walsh");
  });

  it("a stranger's name doesn't come back on any other answer either", async () => {
    for (const over of [{ status: "Expired" }, { status: "Suspended" }, { status: "Refused" }]) {
      register(json(200, [card({ ...over, licensee: "Tom Walsh" })]));
      const r = await checkLicence(wc);
      expect(JSON.stringify(r), `status ${over.status}`).not.toContain("Walsh");
    }
  });

  it("a Traffic Control Work Card is not a White Card, however current it is", async () => {
    register(json(200, [card({ licenceType: "Traffic Control Work Card", licenceName: null })]));
    const r = await checkLicence(wc);
    expect(r).toMatchObject({ status: "not_found", via: "safework_nsw" });
    expect(r.note).toBe("That number is a Traffic Control Work Card, not a White Card.");
  });

  it("the live White Card wording — 'General Construction Induction Training Card' — passes the type gate", async () => {
    register(json(200, [card({ licenceType: "general construction induction training card" })]));
    expect((await checkLicence(wc)).status).toBe("verified");
  });

  it("a row with no card type at all is a human check, not a verified White Card", async () => {
    register(json(200, [card({ licenceType: null })]));
    const r = await checkLicence(wc);
    expect(r.status).toBe("unchecked");
    expect(r.note).toMatch(/by hand/);
  });

  it("a White Card and a traffic card on one number: the White Card is the one that counts", async () => {
    register(json(200, [card({ licenceType: "Traffic Control Work Card" }), card()]));
    expect((await checkLicence(wc)).status).toBe("verified");
  });

  it("a 400 from the register is 'couldn't check', never 'not on the register'", async () => {
    register(json(400, { ErrorCode: "invalid_request", Error: "licenceNumber is invalid" }));
    const r = await checkLicence(wc);
    expect(r).toMatchObject({ status: "unchecked", via: "manual" });   // a refusal to look is not an answer about the card
    expect(r.note).toMatch(/by hand/);
  });

  it("two cards on one number: the current one wins", async () => {
    register(json(200, [card({ status: "Expired", expiryDate: "01/01/2020" }), card()]));
    expect((await checkLicence(wc)).status).toBe("verified");
  });

  it("a register we couldn't reach means 'we'll confirm by hand' — never 'not on the register'", async () => {
    register(json(500, { ErrorCode: "internal_server_error", Error: "Unable to search." }));
    const r = await checkLicence(wc);
    expect(r).toMatchObject({ status: "unchecked", via: "manual" });
    expect(r.note).toMatch(/by hand/);
  });

  it("at the app's daily ceiling nothing is asked, and the card waits for a human", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    budget.room = false;
    try {
      register(json(200, [card()]));                     // a perfectly good card, never asked about
      const r = await checkLicence(wc);
      expect(r).toMatchObject({ status: "unchecked", via: "manual" });
      expect(r.note).toMatch(/by hand/);
      expect(r.status).not.toBe("not_found");             // our budget is not the register's answer
      expect(calls).toHaveLength(0);
    } finally {
      budget.room = true;
      err.mockRestore();
    }
  });

  it("a high risk work licence is not in that register, so it stays a human check", async () => {
    register();
    const r = await checkLicence({ ...wc, kind: "LF", number: "1234567" });
    expect(r).toMatchObject({ status: "unchecked", via: "manual" });
    expect(r.note).toMatch(/by hand/);
    expect(calls).toHaveLength(0);
  });
});

/**
 * Whether a card goes on the re-check queue is decided here, explicitly, where each failure happens —
 * lib/licenceRecheck.ts must never have to guess it from the words of a note.
 */
describe("retryable — only a check that was due and gave no answer", () => {
  const failures: [string, () => void][] = [
    ["the token service refusing", () => vi.stubGlobal("fetch", vi.fn(async () => json(500, { error: "down" })))],
    ["the token service not answering at all", () => vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }))],
    ["a timeout on the verify call", () => vi.stubGlobal("fetch", vi.fn(async (url: string | URL) =>
      String(url).includes("/accesstoken") ? json(200, { access_token: "T1", expires_in: "1799" }) : Promise.reject(new DOMException("timed out", "TimeoutError"))))],
    ["a 400", () => register(json(400, { ErrorCode: "invalid_request" }))],
    ["a 429", () => register(json(429, { message: "slow down" }))],
    ["a 500", () => register(json(500, { ErrorCode: "internal_server_error" }))],
    ["a 503 (spent quota)", () => register(json(503, { message: "Your API quota or rate limit has been exceeded" }))],
    ["a body that isn't a list", () => register(json(200, { unexpected: true }))],
    ["a 401 twice", () => register(json(401, {}), json(401, {}))],
  ];
  for (const [what, arrange] of failures) {
    it(`${what} is "failed"`, async () => {
      arrange();
      const r = await checkLicence(wc);
      expect(r).toMatchObject({ status: "unchecked", via: "manual", retryable: "failed" });
      expect(r.note).toMatch(/by hand/);
    });
  }

  it("the app's daily ceiling is \"cap_refused\" — told apart from a failure, and nothing is asked", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    budget.room = false;
    try {
      register(json(200, [card()]));
      const r = await checkLicence(wc);
      expect(r).toMatchObject({ status: "unchecked", via: "manual", retryable: "cap_refused" });
      expect(calls).toHaveLength(0);
    } finally {
      budget.room = true;
      err.mockRestore();
    }
  });

  it("every real answer carries no retry flag", async () => {
    const answers: Response[][] = [
      [json(200, [card()])],                                         // verified
      [json(200, [])],                                               // not_found
      [json(200, [card({ status: "Expired" })])],                    // expired
      [json(200, [card({ licensee: "Tom Walsh" })])],                // mismatch
      [json(200, [card({ licenceType: "Traffic Control Work Card" })])],
      [json(200, [card({ licenceType: null })])],                    // an answer that still needs a person
    ];
    for (const a of answers) {
      register(...a);
      const r = await checkLicence(wc);
      expect(r.retryable, `${r.status}: ${r.note}`).toBeUndefined();
    }
  });

  it("cards no register of ours can check are never retryable, and cost no call", async () => {
    register();
    expect((await checkLicence({ ...wc, issued_state: "VIC" })).retryable).toBeUndefined();
    expect((await checkLicence({ ...wc, kind: "LF", number: "1234567" })).retryable).toBeUndefined();
    expect((await checkLicence({ ...wc, expires_on: "2020-01-01" })).retryable).toBeUndefined();   // expired by its own date
    vi.stubEnv("WHITE_CARD_API_KEY", "");
    vi.stubEnv("WHITE_CARD_API_SECRET", "");
    expect((await checkLicence(wc)).retryable).toBeUndefined();                                    // no keys: retrying can't help
    expect(calls).toHaveLength(0);
  });
});

describe("namesMatch — registers spell names differently", () => {
  it("matches across middle names, order and punctuation", () => {
    expect(namesMatch("BATBAYAR ERDENE", "Batbayar Erdene")).toBe(true);
    expect(namesMatch("Erdene, Batbayar B.", "Batbayar Erdene")).toBe(true);
  });
  it("does not match a different person", () => {
    expect(namesMatch("Tom Walsh", "Batbayar Erdene")).toBe(false);
  });
});

describe("licenceWords", () => {
  it("never says 'checked' for something we haven't checked", () => {
    expect(licenceWords({ status: "unchecked" }).label).toMatch(/not checked/i);
    expect(licenceWords({ status: "verified", issued_state: "NSW" }).label).toMatch(/✓/);
    expect(licenceWords({ status: "expired", expires_on: "2020-01-01" }).tone).toBe("red");
  });
});
