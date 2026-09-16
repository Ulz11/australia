import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { sendSms } from "@/lib/sms";

const CODE = "OnSite code: 987654";
let out: string[], errs: string[];

beforeEach(() => {
  out = []; errs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errs.push(a.join(" ")); });
  for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"]) vi.stubEnv(k, "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("sending a text with no provider configured", () => {
  it("in development, logs the message so you can read the code on screen", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const r = await sendSms("+61400000101", CODE);
    expect(r).toEqual({ sent: false, stub: true });          // 'stub' means there was nothing to try, so nothing to retry
    expect(out.join("\n")).toContain("987654");
  });

  it("in production, says nothing was sent — and never writes the message to the log", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const r = await sendSms("+61400000101", CODE);
    expect(r.sent).toBe(false);
    expect(r.stub).toBeUndefined();                          // a plain failure: alerts retry it, budgets are handed back
    expect(out).toEqual([]);
    expect(errs.join("\n")).not.toContain("987654");          // a login code must never reach the logs
    expect(errs.join("\n")).not.toContain("+61400000101");
    expect(errs.join("\n")).toMatch(/no provider configured/);
  });
});
