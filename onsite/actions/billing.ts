"use server";
import { revalidatePath } from "@/lib/nav";
import { requireRole } from "@/lib/session";
import { cancelSubscription, resumeSubscription, startSubscription } from "@/lib/invoicing";
import { payFailureWords, payInvoiceWithQpay, type PayFormState } from "@/lib/invoiceQpay";
import { isInvoiceNumber } from "@/lib/subscription";

/**
 * The buttons on the Billing screens. None of them charges a card. Starting a subscription writes an
 * invoice; cancelling sets a date; "Pay with QPay" gets a QR the boss pays in their own bank app, and the
 * invoice marks itself paid when QPay confirms it (lib/billing.ts).
 *
 * The subscription ones are posted straight to a <form action={…}>, so they return nothing.
 */

/** From the trial or from lapsed: subscribed from now, and the first invoice goes out at once. */
export async function startSubscriptionNow() {
  const u = await requireRole("boss");
  await startSubscription(u.id);
  revalidatePath("/boss/billing");
  revalidatePath("/boss/pay");
}

/** Cancel: the pay tools keep working until the period that is already paid for runs out. */
export async function cancelSubscriptionNow() {
  const u = await requireRole("boss");
  await cancelSubscription(u.id);
  revalidatePath("/boss/billing");
  revalidatePath("/boss/pay");
}

/** Changed their mind while it was still running. This period is paid for, so nothing is invoiced. */
export async function keepSubscription() {
  const u = await requireRole("boss");
  await resumeSubscription(u.id);
  revalidatePath("/boss/billing");
  revalidatePath("/boss/pay");
}

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
  return { error: r.ok ? null : payFailureWords[r.reason] };
}
