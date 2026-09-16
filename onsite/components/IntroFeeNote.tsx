import { unbilledIntroduction } from "@/lib/invoicing";
import { matchFeeCents, priceWords } from "@/lib/subscription";

/**
 * The fee, said where it is incurred. This sits next to Approve hours, and only when approving is
 * what will cause the charge: a worker OnSite found for this boss whose introduction hasn't been
 * billed yet. Once it has been billed — or for anyone the boss already knew — it says nothing,
 * because there is nothing to charge.
 *
 * Renders nothing at all in every other case, so it can be dropped into the shift page on one line.
 */
export async function IntroFeeNote({ bossId, workerId, workerName }: { bossId: string; workerId: string; workerName: string }) {
  if (!(await unbilledIntroduction(bossId, workerId))) return null;
  const first = workerName.split(" ")[0] || workerName;
  return (
    <div className="text-sm text-steel">
      First shift with {first} through OnSite — {priceWords(matchFeeCents())} goes on your next invoice.
    </div>
  );
}
