import { demoSite } from "@/lib/flags";

/**
 * On the demo deployment the invoices are made up and nobody owes anything. Said once, on every
 * billing screen, so a number on a tax-invoice layout can't be mistaken for a real bill.
 */
export function DemoBillingNote() {
  if (!demoSite()) return null;
  return <p className="text-steel">This is a demo — invoices here are examples and nothing is charged.</p>;
}
