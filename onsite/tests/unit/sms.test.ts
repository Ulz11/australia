import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { sendSms, smsProvider, CLICKSEND_SEND_URL } from "@/lib/sms";

const CODE = "OnSite code: 987654";
const TO = "+61400000101";
let out: string[], errs: string[];
const logged = () => [...out, ...errs].join("\n");

const PROVIDER_VARS = ["SMS_PROVIDER", "CLICKSEND_USERNAME", "CLICKSEND_API_KEY", "CLICKSEND_FROM", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"];

beforeEach(() => {
  out = []; errs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { errs.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errs.push(a.join(" ")); });
  for (const k of PROVIDER_VARS) vi.stubEnv(k, "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const clicksend = (from = "") => {
  vi.stubEnv("CLICKSEND_USERNAME", "onsite-test-user");
  vi.stubEnv("CLICKSEND_API_KEY", "TEST-API-KEY-0000");
  vi.stubEnv("CLICKSEND_FROM", from);
};
/** ClickSend's documented reply, for one message with the given status. */
const reply = (status: string, over: Record<string, unknown> = {}) => ({
  http_code: 200, response_code: "SUCCESS", response_msg: "Messages queued for delivery.",
  data: {
    total_price: 0.0792, total_count: 1, queued_count: status === "SUCCESS" ? 1 : 0, blocked_count: 0, _currency: {},
    messages: [{ to: TO, body: CODE, from: "+61411111111", message_id: "1EF50711-2787-68F4-8223-9F9C4393E380", status, ...over }],
  },
});
const stubFetch = (res: () => Response | Promise<Response>) => {
  const spy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => res());
  vi.stubGlobal("fetch", spy);
  return spy;
};

describe("sending a text with no provider configured", () => {
  it("in development, logs the message so you can read the code on screen", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const r = await sendSms(TO, CODE);
    expect(r).toEqual({ sent: false, stub: true });          // 'stub' means there was nothing to try, so nothing to retry
    expect(out.join("\n")).toContain("987654");
  });

  it("in production, says nothing was sent — and never writes the message to the log", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const r = await sendSms(TO, CODE);
    expect(r.sent).toBe(false);
    expect(r.stub).toBeUndefined();                          // a plain failure: alerts retry it, budgets are handed back
    expect(out).toEqual([]);
    expect(errs.join("\n")).not.toContain("987654");          // a login code must never reach the logs
    expect(errs.join("\n")).not.toContain(TO);
    expect(errs.join("\n")).toMatch(/no provider configured/);
  });

  it("in production, a provider named without its credentials refuses and says which variables are missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMS_PROVIDER", "clicksend");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test"); vi.stubEnv("TWILIO_AUTH_TOKEN", "tok"); vi.stubEnv("TWILIO_FROM", "+61400000000");
    const spy = stubFetch(() => json(200, {}));
    expect(await sendSms(TO, CODE)).toEqual({ sent: false });
    expect(spy).not.toHaveBeenCalled();                       // it asked for ClickSend: it doesn't quietly fall back to Twilio
    expect(errs.join("\n")).toMatch(/no provider configured.*CLICKSEND_USERNAME/);
  });
});

describe("choosing a provider", () => {
  it("SMS_PROVIDER wins; unset, whichever has credentials — ClickSend first", () => {
    expect(smsProvider().provider).toBeNull();
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test"); vi.stubEnv("TWILIO_AUTH_TOKEN", "tok"); vi.stubEnv("TWILIO_FROM", "+61400000000");
    expect(smsProvider().provider).toBe("twilio");
    clicksend();
    expect(smsProvider().provider).toBe("clicksend");
    vi.stubEnv("SMS_PROVIDER", "twilio");
    expect(smsProvider().provider).toBe("twilio");
    vi.stubEnv("SMS_PROVIDER", "Twilio ");
    expect(smsProvider().provider).toBe("twilio");
    vi.stubEnv("SMS_PROVIDER", "carrier-pigeon");
    expect(smsProvider()).toMatchObject({ provider: null, why: expect.stringMatching(/clicksend or twilio/) });
  });
});

describe("ClickSend", () => {
  beforeEach(() => { vi.stubEnv("NODE_ENV", "production"); clicksend(); });

  it("sends one message to POST /v3/sms/send with Basic username:api_key — and no `from`, so the shared number is used", async () => {
    const spy = stubFetch(() => json(200, reply("SUCCESS")));
    expect(await sendSms(TO, CODE)).toEqual({ sent: true });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe("https://rest.clicksend.com/v3/sms/send");
    expect(CLICKSEND_SEND_URL).toBe(String(url));
    expect(init?.method).toBe("POST");
    const h = new Headers(init?.headers);
    expect(h.get("authorization")).toBe("Basic " + Buffer.from("onsite-test-user:TEST-API-KEY-0000").toString("base64"));
    expect(h.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ messages: [{ source: "onsite", to: TO, body: CODE }] });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(logged()).toBe("");                                // a good send says nothing
  });

  it("sends `from` when CLICKSEND_FROM is set", async () => {
    clicksend("OnSite");
    const spy = stubFetch(() => json(200, reply("SUCCESS")));
    expect(await sendSms(TO, CODE)).toEqual({ sent: true });
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body)).messages[0]).toEqual({ source: "onsite", to: TO, body: CODE, from: "OnSite" });
  });

  it("HTTP 200 is not enough: a message ClickSend didn't accept is not sent", async () => {
    for (const status of ["INSUFFICIENT_CREDIT", "INVALID_RECIPIENT", "COUNTRY_NOT_ENABLED", "QUEUED_BLOCKED"]) {
      stubFetch(() => json(200, { ...reply(status), response_code: "SUCCESS" }));
      expect(await sendSms(TO, CODE), status).toEqual({ sent: false });
      expect(errs.at(-1)).toContain(status);                  // the provider's own word is logged, so ops can see why
    }
    stubFetch(() => json(200, { http_code: 200, response_code: "SUCCESS", data: { messages: [] } }));
    expect(await sendSms(TO, CODE)).toEqual({ sent: false }); // no message in the reply is no message sent
    stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));
    expect(await sendSms(TO, CODE)).toEqual({ sent: false }); // a body we can't read is not a send
  });

  it("an HTTP error is not sent", async () => {
    for (const [status, body] of [[401, { http_code: 401, response_code: "UNAUTHORIZED", response_msg: "Invalid credentials" }], [500, "oops"], [429, {}]] as const) {
      stubFetch(() => (typeof body === "string" ? new Response(body, { status }) : json(status, body)));
      expect(await sendSms(TO, CODE), String(status)).toEqual({ sent: false });
    }
    expect(errs.join("\n")).toMatch(/clicksend error 401 UNAUTHORIZED/);
  });

  it("a network failure or the 8-second timeout is not sent, and never throws", async () => {
    stubFetch(() => { throw new TypeError("fetch failed"); });
    expect(await sendSms(TO, CODE)).toEqual({ sent: false });

    // The real timeout, sped up: the request is given AbortSignal.timeout(8000); we hand it a 20 ms one instead.
    const real = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(20));
    vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_ok, fail) => {
      init?.signal?.addEventListener("abort", () => fail(init.signal!.reason));           // a gateway that never answers
    })));
    const t0 = Date.now();
    expect(await sendSms(TO, CODE)).toEqual({ sent: false });
    expect(timeout).toHaveBeenCalledWith(8000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(errs.join("\n")).toMatch(/clicksend unreachable TimeoutError/);
  });

  it("never logs the number, the message or the credentials — whatever ClickSend sends back", async () => {
    const echo = { response_msg: `Invalid recipient ${TO}: ${CODE}`, to: TO, body: CODE };
    const replies: (() => Response)[] = [
      () => json(200, reply("INVALID_RECIPIENT", { to: TO, body: CODE, status_text: `bad ${TO}` })),
      () => json(200, { ...reply("SUCCESS"), data: { messages: [{ status: `FAILED ${TO} ${CODE}` }] } }),
      () => json(400, { http_code: 400, response_code: `BAD ${TO}`, ...echo }),
      () => json(500, echo),
      () => { throw new Error(`socket hang up while sending ${CODE} to ${TO}`); },
    ];
    for (const r of replies) {
      stubFetch(r);
      expect(await sendSms(TO, CODE)).toEqual({ sent: false });
    }
    expect(errs.length).toBeGreaterThanOrEqual(replies.length);
    for (const secret of [TO, "0400000101", "987654", "TEST-API-KEY-0000", "onsite-test-user"]) expect(logged()).not.toContain(secret);
  });
});

describe("Twilio", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test"); vi.stubEnv("TWILIO_AUTH_TOKEN", "tok"); vi.stubEnv("TWILIO_FROM", "+61400000000");
  });

  it("still sends when it is the provider, and a refusal never logs the number or the message", async () => {
    const ok = stubFetch(() => json(201, { sid: "SM1" }));
    expect(await sendSms(TO, CODE)).toEqual({ sent: true });
    expect(String(ok.mock.calls[0][0])).toContain("api.twilio.com");

    stubFetch(() => json(400, { code: 21211, message: `The 'To' number ${TO} is not a valid phone number. ${CODE}` }));
    expect(await sendSms(TO, CODE)).toEqual({ sent: false });
    expect(errs.join("\n")).toMatch(/twilio error 400 21211/);
    for (const secret of [TO, "987654"]) expect(logged()).not.toContain(secret);
  });
});
