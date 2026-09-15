const map: Record<string, [string, string]> = {
  accepted: ["Coming", "bg-site text-ink"],
  clocked_in: ["On site", "bg-go text-white"],
  clocked_out: ["Approve hours", "bg-hv text-ink"],
  approved: ["Owed", "bg-ink text-white"],
  paid: ["Paid", "bg-go text-white"],
  removed: ["Removed", "bg-site text-steel"],
  cancelled: ["Pulled out", "bg-warn text-white"],
  open: ["Looking for workers", "bg-hv text-ink"],
  filled: ["All spots taken", "bg-go text-white"],
  closed: ["Done", "bg-site text-steel"],
};
export function StatusPill({ s }: { s: string }) {
  const [l, c] = map[s] ?? [s, "bg-site text-steel"];
  return <span className={`inline-flex items-center rounded-lg px-2.5 py-1 text-sm font-bold ${c}`}>{l}</span>;
}
