"use client";
import { useOptimistic, useTransition } from "react";
import { Check } from "lucide-react";
/** Flips instantly, then tells the server. If the server fails, it flips back. */
export function PaidToggle({ paid, ids, action }: { paid: boolean; ids: string[]; action: (ids: string[], paid: boolean) => Promise<void> }) {
  const [shown, setShown] = useOptimistic(paid);
  const [pending, start] = useTransition();
  return (
    <button disabled={pending} onClick={() => start(async () => { setShown(!paid); await action(ids, !paid); })}
      className={`btn btn-sm ${shown ? "bg-go text-white" : "bg-white border-2 border-ink text-ink"}`}>
      {shown ? <><Check size={18} strokeWidth={2.5} aria-hidden />Paid</> : "Mark paid"}
    </button>
  );
}
