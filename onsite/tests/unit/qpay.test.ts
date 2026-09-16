import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { expiryToMs, getQpayToken, resetQpayToken, createQpayInvoice, checkQpayPayment, qpayConfigured, callbackSig, callbackSigOk } from "@/lib/qpay";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let calls: { url: string; init: RequestInit }[] = [];
function mockFetch(...responses: Response[]) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses.shift();
    if (!r) throw new Error("unexpected fetch " + url);
    return r;
  }));
}

beforeEach(() => {
  resetQpayToken();
  process.env.QPAY_BASE_URL = "https://merchant.qpay.mn/v2";
  process.env.QPAY_USERNAME = "TEST_USER";
  process.env.QPAY_PASSWORD = "test-pass";
  process.env.QPAY_INVOICE_CODE = "TEST_INVOICE";
});
afterEach(() => vi.unstubAllGlobals());

describe("expiryToMs — QPay sends epochs or durations", () => {
  const now = 1_790_000_000_000;
  it("reads a unix-seconds timestamp as a moment in time", () => expect(expiryToMs(1_790_003_600, now)).toBe(1_790_003_600_000));
  it("reads a small number as seconds from now", () => expect(expiryToMs(3600, now)).toBe(now + 3_600_000));
  it("passes epoch ms through", () => expect(expiryToMs(1_790_003_600_000, now)).toBe(1_790_003_600_000));
  it("garbage gets a short life, so we renew early rather than late", () => expect(expiryToMs("nope", now)).toBe(now + 300_000));
});

describe("token", () => {
  it("logs in with Basic auth and caches the token", async () => {
    mockFetch(json(200, { access_token: "A1", refresh_token: "R1", expires_in: Math.floor(Date.now() / 1000) + 3600, refresh_expires_in: 7200 }));
    expect(await getQpayToken()).toBe("A1");
    expect(await getQpayToken()).toBe("A1");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://merchant.qpay.mn/v2/auth/token");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Basic " + Buffer.from("TEST_USER:test-pass").toString("base64"));
  });

  it("concurrent callers share one login", async () => {
    mockFetch(json(200, { access_token: "A1", expires_in: 3600 }));
    const [a, b, c] = await Promise.all([getQpayToken(), getQpayToken(), getQpayToken()]);
    expect([a, b, c]).toEqual(["A1", "A1", "A1"]);
    expect(calls).toHaveLength(1);
  });

  it("uses the refresh token when the access token is nearly out", async () => {
    mockFetch(
      json(200, { access_token: "A1", refresh_token: "R1", expires_in: 30, refresh_expires_in: 7200 }),  // inside the 60 s skew
      json(200, { access_token: "A2", refresh_token: "R2", expires_in: 3600, refresh_expires_in: 7200 }),
    );
    await getQpayToken();
    expect(await getQpayToken()).toBe("A2");
    expect(calls[1].url).toMatch(/\/auth\/refresh$/);
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe("Bearer R1");
  });

  it("renews in the last 5 minutes, while QPay's refresh token (same 24 h expiry) still works", async () => {
    const soon = Math.floor(Date.now() / 1000) + 120;                  // QPay's real shape: both fields the same epoch
    mockFetch(
      json(200, { access_token: "A1", refresh_token: "R1", expires_in: soon, refresh_expires_in: soon }),
      json(200, { access_token: "A2", refresh_token: "R2", expires_in: soon + 86400, refresh_expires_in: soon + 86400 }),
    );
    await getQpayToken();
    expect(await getQpayToken()).toBe("A2");
    expect(calls[1].url).toMatch(/\/auth\/refresh$/);
  });

  it("a refresh QPay refuses falls back to a normal login", async () => {
    mockFetch(
      json(200, { access_token: "A1", refresh_token: "R1", expires_in: 30, refresh_expires_in: 7200 }),
      new Response("nope", { status: 500 }),
      json(200, { access_token: "A2", expires_in: 3600 }),
    );
    await getQpayToken();
    expect(await getQpayToken()).toBe("A2");
    expect(calls.map((c) => c.url.split("/v2")[1])).toEqual(["/auth/token", "/auth/refresh", "/auth/token"]);
  });

  it("a rejected login is an error, not a silent empty token", async () => {
    mockFetch(new Response("bad creds", { status: 401 }));
    await expect(getQpayToken()).rejects.toThrow(/401/);
  });

  it("is not configured without an invoice code", () => {
    delete process.env.QPAY_INVOICE_CODE;
    expect(qpayConfigured()).toBe(false);
  });
});

describe("invoice", () => {
  it("sends the invoice code, our number, whole-MNT amount and callback", async () => {
    mockFetch(
      json(200, { access_token: "A1", expires_in: 3600 }),
      json(200, { invoice_id: "inv-1", qr_text: "qr", qr_image: "png", qPay_shortUrl: "https://s.qpay.mn/x", urls: [] }),
    );
    const inv = await createQpayInvoice({ senderInvoiceNo: "OS-123", amount: 3300, description: "Match fee", callbackUrl: "https://app/api/qpay/callback?invoice=OS-123" });
    expect(inv.invoice_id).toBe("inv-1");
    const body = JSON.parse(String(calls[1].init.body));
    expect(body).toMatchObject({ invoice_code: "TEST_INVOICE", sender_invoice_no: "OS-123", invoice_receiver_code: "terminal", amount: 3300 });
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe("Bearer A1");
  });

  it("refuses fractional or zero amounts before calling QPay", async () => {
    mockFetch();
    await expect(createQpayInvoice({ senderInvoiceNo: "OS-1", amount: 12.5, description: "x", callbackUrl: "https://x" })).rejects.toThrow(/whole number/);
    await expect(createQpayInvoice({ senderInvoiceNo: "OS-1", amount: 0, description: "x", callbackUrl: "https://x" })).rejects.toThrow(/whole number/);
    expect(calls).toHaveLength(0);
  });

  it("retries once with a fresh login when QPay says 401", async () => {
    mockFetch(
      json(200, { access_token: "OLD", expires_in: 3600 }),
      new Response("expired", { status: 401 }),
      json(200, { access_token: "NEW", expires_in: 3600 }),
      json(200, { invoice_id: "inv-2", qr_text: "", qr_image: "", qPay_shortUrl: "", urls: [] }),
    );
    const inv = await createQpayInvoice({ senderInvoiceNo: "OS-2", amount: 100, description: "x", callbackUrl: "https://x" });
    expect(inv.invoice_id).toBe("inv-2");
    expect((calls[3].init.headers as Record<string, string>).Authorization).toBe("Bearer NEW");
  });
});

describe("401 stampede", () => {
  it("eight calls hitting 401 together cause one login, not eight", async () => {
    let logins = 0;
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/auth/token")) {
        logins++;
        await new Promise((r) => setTimeout(r, 5));
        return json(200, { access_token: `T${logins}`, expires_in: 3600 });
      }
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === "Bearer T1" ? new Response("revoked", { status: 401 }) : json(200, { count: 0, rows: [] });
    }));
    await getQpayToken();                                              // T1 cached, then QPay revokes it
    const results = await Promise.all(Array.from({ length: 8 }, () => checkQpayPayment("inv")));
    expect(results.every((r) => r.paid === false)).toBe(true);
    expect(logins).toBe(2);                                            // the first login + exactly one re-login
  });
});

describe("callback signature", () => {
  it("accepts its own signature and nothing else", () => {
    const sig = callbackSig("OS-ABC", "s3cret");
    expect(sig).toMatch(/^[0-9a-f]{32}$/);
    expect(callbackSigOk("OS-ABC", sig, "s3cret")).toBe(true);
    expect(callbackSigOk("OS-ABD", sig, "s3cret")).toBe(false);       // another invoice
    expect(callbackSigOk("OS-ABC", sig, "other")).toBe(false);        // another secret
    expect(callbackSigOk("OS-ABC", sig.slice(0, 31), "s3cret")).toBe(false);
    expect(callbackSigOk("OS-ABC", "", "s3cret")).toBe(false);
  });
});

describe("payment check — the only thing that says 'paid'", () => {
  it("ignores a PAID row in a currency other than MNT", async () => {
    mockFetch(
      json(200, { access_token: "A1", expires_in: 3600 }),
      json(200, { count: 1, paid_amount: 3300, rows: [{ payment_id: "p1", payment_status: "PAID", payment_amount: "3300", payment_currency: "USD" }] }),
    );
    expect(await checkQpayPayment("inv-1")).toMatchObject({ paid: false, paidAmount: 0 });
  });

  it("paid when a row is PAID", async () => {
    mockFetch(
      json(200, { access_token: "A1", expires_in: 3600 }),
      json(200, { count: 1, paid_amount: 3300, rows: [{ payment_id: "p1", payment_status: "PAID", payment_amount: "3300.00" }] }),
    );
    const r = await checkQpayPayment("inv-1");
    expect(r).toMatchObject({ paid: true, paidAmount: 3300, count: 1 });
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({ object_type: "INVOICE", object_id: "inv-1" });
  });

  it("1 MNT beside 3300 USD counts as 1, not 3301 — QPay's own paid_amount mixes currencies", async () => {
    mockFetch(
      json(200, { access_token: "A1", expires_in: 3600 }),
      json(200, { count: 2, paid_amount: 3301, rows: [
        { payment_id: "p1", payment_status: "PAID", payment_amount: "3300", payment_currency: "USD" },
        { payment_id: "p2", payment_status: "PAID", payment_amount: "1", payment_currency: "MNT" },
      ] }),
    );
    expect(await checkQpayPayment("inv-1")).toMatchObject({ paid: true, paidAmount: 1 });
  });

  it("not paid when there are no rows", async () => {
    mockFetch(json(200, { access_token: "A1", expires_in: 3600 }), json(200, { count: 0, rows: [] }));
    expect(await checkQpayPayment("inv-1")).toMatchObject({ paid: false, paidAmount: 0 });
  });
});
