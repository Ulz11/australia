/**
 * Where an invoice stands, in one word. Ink for "open" rather than orange: an invoice that is simply
 * due is not something gone wrong, and orange in this app only ever means "this needs you now".
 */
const MAP: Record<string, [string, string]> = {
  open: ["Open", "bg-ink text-white"],
  paid: ["Paid", "bg-go text-white"],
  void: ["Cancelled", "bg-site text-steel"],
};

export function InvoiceStatus({ s }: { s: string }) {
  const [label, skin] = MAP[s] ?? [s, "bg-site text-steel"];
  return <span className={`inline-flex items-center rounded-lg px-2.5 py-1 text-sm font-bold ${skin}`}>{label}</span>;
}
