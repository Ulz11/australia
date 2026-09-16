import Link from "next/link";
import { Say } from "@/components/ui";
import { startSubscriptionNow } from "@/actions/billing";
import { upsellWords, type BillingState } from "@/lib/subscription";

/**
 * What stands in for the pay run once the subscription has lapsed. Only the pay tools are behind it —
 * posting shifts, matching, approving hours and the Workers screen never stop, because approving hours
 * is what makes a match billable and OnSite has no business charging for that.
 */
export function Upsell({ boss }: { boss: Pick<BillingState, "trial_ends_at"> }) {
  const words = upsellWords(boss.trial_ends_at);
  return (
    <>
      <Say tone="orange" title={words.title} sub={words.sub}>
        <form action={startSubscriptionNow} className="mt-3"><button className="btn-dark w-full">Start subscription</button></form>
      </Say>
      <p className="text-steel">
        Your hours and approvals are all still here — the pay run, the record and Export come back the moment you start again.
        Posting shifts, matching and approving hours stay free.
      </p>
      <Link href="/boss/billing" className="btn-ghost">See billing</Link>
    </>
  );
}
