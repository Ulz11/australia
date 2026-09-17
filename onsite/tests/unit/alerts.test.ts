import { describe, it, expect, afterEach } from "vitest";
import { alertFor, endpointOk, smsFor, SMS_KINDS } from "@/lib/alerts";

afterEach(() => { delete process.env.PUSH_ENDPOINT_HOSTS; });

describe("what the phone shows", () => {
  const n = (kind: string, role: string, body = "Something happened", shift_id: string | null = "s1", starts_soon = false) => alertFor({ id: "n1", kind, body, shift_id, role, starts_soon });

  it("a shift offer opens the worker's calendar", () => {
    expect(n("shift_match", "worker", "General labourer at Duplex · Tue 7:00am")).toMatchObject({ title: "Shift near you", url: "/worker", urgent: false });
  });
  it("a shift starting within 3 hours says so and is urgent — decided by the shift, not the wording", () => {
    expect(n("shift_match", "worker", "Duplex: Tue 7:00am. Booked directly for you.", "s1", true)).toMatchObject({ title: "Starts soon — shift near you", urgent: true });
    expect(n("shift_match", "worker", "Starts soon — but the flag says otherwise", "s1", false).urgent).toBe(false);
    expect(n("hours_approved", "worker", "x", "s1", true).urgent).toBe(false);          // only offers are urgent
  });
  it("sends each kind to the screen that deals with it", () => {
    expect(n("hours_approved", "worker").url).toBe("/worker/me");
    expect(n("paid", "worker").url).toBe("/worker/me");
    expect(n("counter", "worker").url).toBe("/worker/offers");
    expect(n("removed", "worker").url).toBe("/worker/shift");
    expect(n("approve", "boss").url).toBe("/boss/shifts/s1");
    expect(n("offer", "boss").url).toBe("/boss/offers");
    expect(n("dispute", "boss", "x", null).url).toBe("/boss");
  });
  it("a card re-check result opens My cards, has a title of its own, and is never worth a text", () => {
    expect(n("licence_check", "worker", "Your White Card checked out with SafeWork NSW.", null)).toMatchObject({ title: "Card checked", url: "/worker/me/edit", urgent: false, tag: "licence_check:n1" });
    expect(SMS_KINDS.has("licence_check")).toBe(false);
    expect([...SMS_KINDS]).toEqual(["shift_match"]);
  });
  it("an invoice QPay confirmed opens Billing, has its own title, and is never worth a text", () => {
    expect(n("invoice_paid", "boss", "Invoice OS-2026-000123 paid — thanks.", null)).toMatchObject({ title: "Invoice paid", url: "/boss/billing", urgent: false, tag: "invoice_paid:n1" });
    expect(SMS_KINDS.has("invoice_paid")).toBe(false);
  });
  it("tags by kind and shift, so a second alert about the same shift replaces the first", () => {
    expect(n("shift_match", "worker").tag).toBe("shift_match:s1");
    expect(n("test", "worker", "x", null).tag).toBe("test:n1");
  });
});

describe("push endpoints — only real push services (we POST to these)", () => {
  it("accepts the big push services", () => {
    for (const e of [
      "https://fcm.googleapis.com/fcm/send/abc:123",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
      "https://web.push.apple.com/QGuQyavXutnMH0",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA",
    ]) expect(endpointOk(e), e).toBe(true);
  });
  it("refuses anything that could reach inside our network or pose as a push service", () => {
    for (const e of [
      "http://fcm.googleapis.com/fcm/send/abc",          // not https
      "https://169.254.169.254/latest/meta-data",
      "https://localhost:5432/",
      "https://googleapis.com.evil.example/x",
      "https://evilgoogleapis.com/x",
      "not a url",
      "https://fcm.googleapis.com/" + "a".repeat(1000),
    ]) expect(endpointOk(e), e).toBe(false);
  });
  it("a local test push service only when explicitly allowed", () => {
    expect(endpointOk("http://127.0.0.1:4555/push/x")).toBe(false);
    process.env.PUSH_ENDPOINT_HOSTS = "127.0.0.1:4555";
    expect(endpointOk("http://127.0.0.1:4555/push/x")).toBe(true);
    expect(endpointOk("http://127.0.0.1:4556/push/x")).toBe(false);
  });
});

describe("the text message", () => {
  const a = (urgent: boolean) => ({ ...alertFor({ id: "n", kind: "shift_match", body: "PAY ON HOLD - confirm bank at evil.example", shift_id: "s", role: "worker", starts_soon: urgent }) });
  it("is fixed wording plus the system-formatted time — never the boss's words", () => {
    const t = smsFor(a(false), "Thu 17 Sep, 6:30am", "https://onsite.app");
    expect(t).toBe("OnSite: a new shift offer for Thu 17 Sep, 6:30am. Open the app to see it: https://onsite.app/worker");
    expect(t).not.toContain("evil");
  });
  it("says 'starting soon' when it is", () => expect(smsFor(a(true), null, "")).toBe("OnSite: a shift starting soon. Open the app to see it."));
  it("stays inside one SMS segment", () => expect(smsFor(a(true), "Thu 17 Sep, 12:30pm", "https://onsite.onrender.com").length).toBeLessThanOrEqual(160));
});
