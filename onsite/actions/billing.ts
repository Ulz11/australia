"use server";
import { revalidatePath } from "@/lib/nav";
import { requireRole } from "@/lib/session";
import { cancelSubscription, resumeSubscription, startSubscription } from "@/lib/invoicing";

/**
 * The two buttons on the Billing screen. Neither takes a payment — nothing in OnSite does. Starting a
 * subscription writes an invoice; cancelling sets a date. A person marks the invoice paid later
 * (npm run billing:paid).
 *
 * Both are posted straight to a <form action={…}>, so both return nothing.
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
