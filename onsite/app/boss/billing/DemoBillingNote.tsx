import { demoSite } from "@/lib/flags";
import { demoBillingWords, qpayPayable } from "@/lib/subscription";
import { Say } from "@/components/ui";

/**
 * On the demo deployment, said once on every billing screen. While QPay can't take a payment the invoices
 * there are made-up examples, and a quiet line says so. Once it can, a QR on a demo invoice takes real money —
 * that needs the boss's attention, so it is orange.
 */
export function DemoBillingNote() {
  if (!demoSite()) return null;
  const live = qpayPayable();
  return live
    ? <Say tone="orange" title={demoBillingWords(true)} />
    : <p className="text-steel">{demoBillingWords(false)}</p>;
}
