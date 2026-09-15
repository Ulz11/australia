/** Sends an SMS via Twilio if configured, else logs to the server console. */
export async function sendSms(to: string, body: string): Promise<{ sent: boolean }> {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !tok || !from) {
    console.log(`[sms:stub] to=${to} :: ${body}`);
    return { sent: false };
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${tok}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!res.ok) console.error("twilio error", await res.text());
  return { sent: res.ok };
}

/** Normalise an Australian mobile to E.164. Accepts 04xx, 614xx, +614xx. Falls back to raw +. */
export function normalisePhone(raw: string): string | null {
  const d = raw.replace(/[^\d+]/g, "");
  if (/^04\d{8}$/.test(d)) return "+61" + d.slice(1);
  if (/^614\d{8}$/.test(d)) return "+" + d;
  if (/^\+614\d{8}$/.test(d)) return d;
  if (/^\+\d{8,15}$/.test(d)) return d; // other countries, for testing
  return null;
}
