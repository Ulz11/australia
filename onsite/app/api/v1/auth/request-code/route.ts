import { requestCode } from "@/actions/auth";
import { body, fail, json, preflight } from "@/lib/apiJson";

/**
 * Ask for a login code. Everything that makes this safe — the per-connection, per-number
 * and app-wide budgets, the atomic send, the refund on any path that doesn't end in a
 * text — lives in `requestCode` and is shared with the web form. This only translates.
 */
export async function POST(req: Request) {
  const b = await body<{ phone?: string }>(req);
  if (!b?.phone) return fail(req, 400, "Enter an Australian mobile, e.g. 0412 345 678");

  const form = new FormData();
  form.set("phone", b.phone);
  const r = await requestCode({ step: "phone" }, form);

  if (r.error) return fail(req, 429, r.error);
  return json(req, { step: "code", phone: r.phone, devCode: r.devCode ?? null });
}

export const OPTIONS = preflight;
