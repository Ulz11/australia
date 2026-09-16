import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  expiryToMs, isoDay, sameNumber, resetWhitecardToken, whitecardConfigured, whitecardToken, verifyWhiteCard,
} from "@/lib/whitecard";

const BASE = "https://whitecard.test.invalid";
const KEY = "test-api-key-0000000000000000000";
const SECRET = "test-secret-0000";

/** One record exactly as the register sends it — home address and all. None of it may come out. */
const ADDRESS = "12 Nowhere Lane";
const RAW = {
  licenceID: "9999",
  licenceNumber: "CIC1765241",
  status: "Current",
  startDate: "01/07/2023",
  expiryDate: "30/06/2028",
  refusedDate: "",
  licenceType: "White Card",
  licenceName: "General Construction Induction Training",
  licensee: "John Smith",
  address: ADDRESS,
  suburb: "MARRICKVILLE",
  postcode: "2204",
  vehicleRegistration: "ABC123",
  businessNames: ["Smith Formwork"],
  categories: ["GCIT"],
  classes: ["WC"],
  historicalLicenceNumbers: ["CIC0000001"],      // undocumented, and other card numbers are none of our business
};

/** What the live register actually sent on 16 Sept 2026 — dates as "N/A", no licenceName, a longer type. */
const LIVE_SHAPE = {
  licenceID: "1", licenceNumber: "CIC1765241", status: "Current", startDate: "N/A", expiryDate: "N/A", refusedDate: "N/A",
  licenceType: "General Construction Induction Training Card", licenceName: null, licensee: "JOHN CITIZEN",
  address: ADDRESS, suburb: "MARRICKVILLE", postcode: "2204",
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tokenBody = (access: string, expires_in: unknown = "1799") =>
  json(200, { access_token: access, token_type: "BearerToken", expires_in, issued_at: String(Date.now()), scope: "", status: "approved" });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let calls: { url: string; init: RequestInit }[] = [];
function mockFetch(handler: Handler) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }));
}
const tokenCalls = () => calls.filter((c) => c.url.includes("/accesstoken"));
const verifyCalls = () => calls.filter((c) => c.url.includes("/wcregister/v1/verify"));
const authOf = (c: { init: RequestInit }) => (c.init.headers as Record<string, string>).Authorization;
/** Token always works, verify answers however the test says. */
const registerSays = (verify: Handler): Handler => {
  let n = 0;
  return (url, init) => (url.includes("/accesstoken") ? tokenBody(`T${++n}`) : verify(url, init));
};

beforeEach(() => {
  resetWhitecardToken();
  vi.stubEnv("WHITE_CARD_BASE_URL", BASE);
  vi.stubEnv("WHITE_CARD_API_KEY", KEY);
  vi.stubEnv("WHITE_CARD_API_SECRET", SECRET);
  vi.stubEnv("WHITE_CARD_AUTH_HEADER", "");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("configured", () => {
  it("needs a key and something to authenticate with", () => {
    expect(whitecardConfigured()).toBe(true);
    vi.stubEnv("WHITE_CARD_API_SECRET", "");
    expect(whitecardConfigured()).toBe(false);
    vi.stubEnv("WHITE_CARD_AUTH_HEADER", "Basic cGFzdGVk");     // the portal's own header is enough on its own
    expect(whitecardConfigured()).toBe(true);
    vi.stubEnv("WHITE_CARD_API_KEY", "");
    expect(whitecardConfigured()).toBe(false);                   // the verify call needs the key header regardless
  });

  it("with no credentials it does not call anything at all", async () => {
    vi.stubEnv("WHITE_CARD_API_KEY", "");
    mockFetch(() => json(200, [RAW]));
    expect(await verifyWhiteCard("CIC1765241")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("expires_in — a string, and the spec never says what unit", () => {
  const now = 1_790_000_000_000;
  it("reads a small number as seconds", () => expect(expiryToMs("1799", now)).toBe(now + 1_799_000));
  it("reads anything over 1e7 as milliseconds", () => expect(expiryToMs("86400000", now)).toBe(now + 86_400_000));
  it("takes a number as happily as a string", () => expect(expiryToMs(1799, now)).toBe(now + 1_799_000));
  it("garbage gets half an hour, so we renew early rather than late", () => {
    expect(expiryToMs("", now)).toBe(now + 1_800_000);
    expect(expiryToMs("soon", now)).toBe(now + 1_800_000);
    expect(expiryToMs("-5", now)).toBe(now + 1_800_000);
  });
});

describe("dates and numbers", () => {
  it("normalises whatever date shape arrives", () => {
    expect(isoDay("30/06/2028")).toBe("2028-06-30");
    expect(isoDay("1/7/2023")).toBe("2023-07-01");
    expect(isoDay("2028-06-30")).toBe("2028-06-30");
    expect(isoDay("2028-06-30T00:00:00.000Z")).toBe("2028-06-30");
    expect(isoDay("N/A")).toBeNull();                            // what the live register sends for a card with no dates
    expect(isoDay("")).toBeNull();
    expect(isoDay("sometime")).toBeNull();
    expect(isoDay(null)).toBeNull();
  });
  it("compares numbers without case or stray spaces", () => {
    expect(sameNumber(" cic1765241 ", "CIC1765241")).toBe(true);
    expect(sameNumber("CIC1765241", "CIC1765242")).toBe(false);
    expect(sameNumber(null, "CIC1765241")).toBe(false);
  });
});

describe("token", () => {
  it("sends Basic auth, then keeps the token", async () => {
    mockFetch(registerSays(() => json(200, [])));
    expect(await whitecardToken()).toBe("T1");
    expect(await whitecardToken()).toBe("T1");
    expect(tokenCalls()).toHaveLength(1);
    expect(tokenCalls()[0].url).toBe(`${BASE}/oauth/client_credential/accesstoken?grant_type=client_credentials`);
    expect(authOf(tokenCalls()[0])).toBe("Basic " + Buffer.from(`${KEY}:${SECRET}`).toString("base64"));
  });

  it("sends the portal's header as pasted when there is one", async () => {
    vi.stubEnv("WHITE_CARD_AUTH_HEADER", "Basic cGFzdGVkLWZyb20tdGhlLXBvcnRhbA==");
    mockFetch(registerSays(() => json(200, [])));
    await whitecardToken();
    expect(authOf(tokenCalls()[0])).toBe("Basic cGFzdGVkLWZyb20tdGhlLXBvcnRhbA==");
  });

  it("caches a token that lasts, renews one that doesn't", async () => {
    mockFetch((url) => (url.includes("/accesstoken") ? tokenBody("LONG", "1799") : json(200, [])));
    await verifyWhiteCard("CIC1765241");
    await verifyWhiteCard("CIC1765241");
    expect(tokenCalls()).toHaveLength(1);                        // second check rode on the cached token

    resetWhitecardToken();
    mockFetch((url) => (url.includes("/accesstoken") ? tokenBody("SHORT", "30") : json(200, [])));
    await verifyWhiteCard("CIC1765241");
    await verifyWhiteCard("CIC1765241");
    expect(tokenCalls()).toHaveLength(2);                        // 30 s is inside the renew window
  });

  it("ten checks at once buy one token, not ten", async () => {
    mockFetch(registerSays(async () => { await new Promise((r) => setTimeout(r, 2)); return json(200, [RAW]); }));
    const results = await Promise.all(Array.from({ length: 10 }, () => verifyWhiteCard("CIC1765241")));
    expect(results.every((r) => r?.length === 1)).toBe(true);
    expect(tokenCalls()).toHaveLength(1);
    expect(verifyCalls()).toHaveLength(10);
  });

  it("a refused login is an error, not an empty token", async () => {
    mockFetch(() => json(401, { ErrorCode: "invalid_client", Error: "Client credentials are invalid" }));
    await expect(whitecardToken()).rejects.toThrow(/401/);
  });

  it("a login that fails doesn't poison the cache — the next call tries again", async () => {
    mockFetch(() => { throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" }); });
    await expect(whitecardToken()).rejects.toThrow();
    await expect(whitecardToken()).rejects.toThrow();              // still failing, still trying
    expect(tokenCalls()).toHaveLength(2);                          // not one stuck rejected promise handed to everyone

    mockFetch(registerSays(() => json(200, [])));                  // the endpoint comes back
    expect(await whitecardToken()).toBe("T1");
  });

  it("a token endpoint blip inside the renew minute leaves the live token in use", async () => {
    // 30 s of life left: inside the renew-early minute, so the next call goes for a new one —
    // but the token in hand is still live.
    mockFetch((url) => (url.includes("/accesstoken") ? tokenBody("GOOD", "30") : json(200, [RAW])));
    expect(await whitecardToken()).toBe("GOOD");
    mockFetch((url) => {
      if (url.includes("/accesstoken")) return json(503, { Error: "Service Unavailable" });
      return json(200, [RAW]);
    });
    expect(await whitecardToken()).toBe("GOOD");                   // a check still happens, rather than "couldn't check"
    expect(await verifyWhiteCard("CIC1765241")).toHaveLength(1);
  });

  it("but a token the API itself rejected is never reused", async () => {
    let tokens = 0, refusals = 0;
    mockFetch((url, init) => {
      if (url.includes("/accesstoken")) return ++tokens === 1 ? tokenBody("DEAD", "90") : json(503, { Error: "Service Unavailable" });
      refusals++;
      return authOf({ init }) === "Bearer DEAD" ? json(401, { Error: "Invalid Access Token." }) : json(200, [RAW]);
    });
    expect(await verifyWhiteCard("CIC1765241")).toBeNull();        // 401 drops it, the retry can't get another: couldn't check
    expect(refusals).toBe(1);                                      // and the dead token is not handed straight back
  });
});

describe("verify", () => {
  it("asks by number, with the bearer token and the apikey header", async () => {
    mockFetch(registerSays(() => json(200, [RAW])));
    await verifyWhiteCard("  cic1765241  ");
    expect(verifyCalls()[0].url).toBe(`${BASE}/wcregister/v1/verify?licenceNumber=cic1765241`);
    expect(authOf(verifyCalls()[0])).toBe("Bearer T1");
    expect((verifyCalls()[0].init.headers as Record<string, string>).apikey).toBe(KEY);
  });

  it("returns the minimal record, dates normalised", async () => {
    mockFetch(registerSays(() => json(200, [RAW])));
    const rows = await verifyWhiteCard("CIC1765241");
    expect(rows).toEqual([{
      licenceNumber: "CIC1765241",
      status: "Current",
      licenceType: "White Card",
      licenceName: "General Construction Induction Training",
      licensee: "John Smith",
      startDate: "2023-07-01",
      expiryDate: "2028-06-30",
      refusedDate: null,
    }]);
  });

  it("takes the live register's shape as it is: 'N/A' dates, no licenceName, a longer type", async () => {
    mockFetch(registerSays(() => json(200, [LIVE_SHAPE])));
    const rows = await verifyWhiteCard("CIC1765241");
    expect(rows).toEqual([{
      licenceNumber: "CIC1765241",
      status: "Current",
      licenceType: "General Construction Induction Training Card",
      licenceName: null,
      licensee: "JOHN CITIZEN",
      startDate: null,
      expiryDate: null,
      refusedDate: null,
    }]);
  });

  it("drops the address at the parser and never logs it", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")]
      .map((s) => s.mockImplementation(() => {}));
    mockFetch(registerSays(() => json(200, [RAW])));
    const rows = await verifyWhiteCard("CIC1765241");

    for (const gone of ["address", "suburb", "postcode", "vehicleRegistration", "businessNames", "categories", "classes", "licenceID", "historicalLicenceNumbers"])
      expect(Object.keys(rows![0])).not.toContain(gone);
    const serialised = JSON.stringify(rows);
    for (const value of [ADDRESS, "MARRICKVILLE", "2204", "ABC123", "Smith Formwork", "9999", "CIC0000001"])
      expect(serialised).not.toContain(value);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(ADDRESS);
    }
  });

  it("an empty array means checked-and-nothing-there, not a failure", async () => {
    mockFetch(registerSays(() => json(200, [])));
    expect(await verifyWhiteCard("CIC0000000")).toEqual([]);
  });

  it("a server error, a refused request, a timeout or a body we can't read is 'couldn't check'", async () => {
    mockFetch(registerSays(() => json(500, { ErrorCode: "internal_server_error", Error: "Unable to search." })));
    expect(await verifyWhiteCard("CIC1765241")).toBeNull();

    resetWhitecardToken();
    // A 400 is the register declining to look, not the register saying the card isn't there.
    mockFetch(registerSays(() => json(400, { ErrorCode: "invalid_request", Error: "licenceNumber is invalid" })));
    expect(await verifyWhiteCard("nonsense!!")).toBeNull();
    expect(verifyCalls()).toHaveLength(1);                         // and it is not retried

    resetWhitecardToken();
    mockFetch(registerSays(() => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); }));
    expect(await verifyWhiteCard("CIC1765241")).toBeNull();

    resetWhitecardToken();
    mockFetch(registerSays(() => new Response("<html>gateway</html>", { status: 200 })));
    expect(await verifyWhiteCard("CIC1765241")).toBeNull();

    resetWhitecardToken();
    mockFetch(registerSays(() => json(200, { licenceNumber: "CIC1765241" })));   // an object where the array should be
    expect(await verifyWhiteCard("CIC1765241")).toBeNull();
  });

  // The free tier is 2,500 calls a month and the product page documents no status for a spent
  // quota; the sibling NSW gateway answers one with a 503. Both readings of "throttled" must come
  // back as "couldn't check" — an empty array here would put a red "not on the register" badge on
  // a worker because *we* called too often.
  it("429 and 503 are 'couldn't check', not 'nothing on the register', and are never retried", async () => {
    for (const status of [429, 503]) {
      resetWhitecardToken();
      mockFetch(registerSays(() => json(status, { Error: "Your API quota or rate limit has been exceeded." })));
      expect(await verifyWhiteCard("CIC1765241"), `HTTP ${status}`).toBeNull();
      expect(verifyCalls(), `HTTP ${status}`).toHaveLength(1);        // one call, then we stop asking
    }
  });

  it("a throttled token endpoint never reaches the verify call at all", async () => {
    for (const status of [429, 503]) {
      resetWhitecardToken();
      mockFetch(() => json(status, { Error: "Your API quota or rate limit has been exceeded." }));
      expect(await verifyWhiteCard("CIC1765241"), `HTTP ${status}`).toBeNull();
      expect(tokenCalls(), `HTTP ${status}`).toHaveLength(1);
      expect(verifyCalls(), `HTTP ${status}`).toHaveLength(0);
    }
  });

  it("a token the API has stopped liking is dropped, re-fetched and retried once", async () => {
    let n = 0;
    mockFetch((url, init) => {
      if (url.includes("/accesstoken")) return tokenBody(`T${++n}`);
      return authOf({ init }) === "Bearer T1" ? json(401, { ErrorCode: "invalid_token_response", Error: "Invalid Access Token." }) : json(200, [RAW]);
    });
    const rows = await verifyWhiteCard("CIC1765241");
    expect(rows).toHaveLength(1);
    expect(tokenCalls()).toHaveLength(2);
    expect(verifyCalls().map(authOf)).toEqual(["Bearer T1", "Bearer T2"]);
  });

  it("401 that keeps coming is 'couldn't check' after exactly one retry", async () => {
    let n = 0;
    mockFetch((url) => (url.includes("/accesstoken") ? tokenBody(`T${++n}`) : json(401, { Error: "Invalid Access Token." })));
    expect(await verifyWhiteCard("CIC1765241")).toBeNull();
    expect(verifyCalls()).toHaveLength(2);
    expect(tokenCalls()).toHaveLength(2);
  });
});
