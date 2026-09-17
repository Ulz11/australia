import { getUser } from "@/lib/session";
import { invoicePayStatus } from "@/lib/invoiceQpay";
import { isInvoiceNumber } from "@/lib/subscription";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * What the invoice page polls while a QR is up: settles the linked QPay invoice (at most one QPay check per
 * invoice per 10 s, however many tabs ask) and answers { status: "open" | "paid" | "void" }. A route, not a
 * server action — actions run one at a time per browser, so a poll would hold up the boss's own taps.
 * Another boss's invoice is a 404, the same as one that doesn't exist.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ number: string }> }) {
  const u = await getUser();
  if (!u || u.role !== "boss") return Response.json({ error: "sign in" }, { status: 401, headers: NO_STORE });
  const { number } = await params;
  const status = isInvoiceNumber(number) ? await invoicePayStatus(u.id, number) : null;
  if (!status) return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
  return Response.json({ status }, { headers: NO_STORE });
}
