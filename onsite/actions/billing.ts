"use server";
import { revalidatePath } from "@/lib/nav";
import { requireRole } from "@/lib/session";
import { payFailureWords, payInvoiceWithQpay, type PayFormState } from "@/lib/invoiceQpay";
import { isInvoiceNumber } from "@/lib/subscription";

/**
 * The one button on the Billing screens. There is nothing to start, nothing to cancel and nothing to
 * resume: a boss is charged $2 an introduction, invoiced every fortnight, and that is the whole
 * arrangement. Paying is the only action left — and it charges no card either. "Pay with QPay" gets a QR
 * the boss pays in their own bank app, and the invoice marks itself paid when QPay confirms it (lib/billing.ts).
 */

/**
 * "Pay with QPay" on one of this boss's open invoices. Raises a QPay invoice only when the one it already has
 * can't be used (lib/invoiceQpay.ts); the page re-renders with the QR. Someone else's invoice number is simply
 * not found. Used with useActionState, so it hands back the words to show when it didn't work.
 */
export async function payWithQpay(_prev: PayFormState, formData: FormData): Promise<PayFormState> {
  const u = await requireRole("boss");
  const number = String(formData.get("number") ?? "");
  if (!isInvoiceNumber(number)) return { error: payFailureWords.not_found };
  const r = await payInvoiceWithQpay(u.id, number);
  revalidatePath(`/boss/billing/${number}`);
  revalidatePath("/boss/billing");
  // /boss/money carries the same open invoices, and /boss ranks the nearest due date. Paying one and
  // leaving either stale is a boss being chased for an invoice he has just paid.
  revalidatePath("/boss/money");
  revalidatePath("/boss");
  return { error: r.ok ? null : payFailureWords[r.reason] };
}
