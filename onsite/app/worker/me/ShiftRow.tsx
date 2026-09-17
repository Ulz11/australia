import { Check, CircleAlert } from "lucide-react";
import { StatusPill } from "@/components/StatusPill";
import { ConfirmButton } from "@/components/ConfirmButton";
import { CallLink } from "@/components/CallLink";
import { disagree, workerLogCall } from "@/actions/worker";
import { fmtDay } from "@/lib/util";
import { money } from "@/lib/award";
import type { HistoryRow } from "@/lib/profileStats";

/**
 * One shift on the worker's record: day, site, boss, what it paid. Shared by the ten most recent on
 * /worker/me and the full list on /worker/me/shifts, so a change to the row happens once.
 */
export function ShiftRow({ h, gross }: { h: HistoryRow; gross: (h: HistoryRow) => number }) {
  const first = h.boss_name.split(" ")[0];
  return (
    <div className="py-3">
      <div className="flex justify-between items-center gap-2">
        <div><div className="font-bold">{fmtDay(h.day)} · {h.site}</div><div className="text-sm text-steel">{h.boss_name}{h.company ? ` · ${h.company}` : ""}</div></div>
        <div className="text-right num"><div className="font-extrabold text-lg">{h.hours_approved != null ? money(gross(h)) : "—"}</div><StatusPill s={h.status} view="worker" /></div>
      </div>
      {/* Hours that don't match are waiting on this worker to say something — orange until they do. */}
      {h.hours_approved != null && Number(h.hours_approved) !== Number(h.hours_worked) && (
        <div className={`mt-2 ${h.disputed_at ? "say-grey" : "say-orange"}`}>
          <div className="flex items-start gap-3">
            {h.disputed_at
              ? <Check size={22} strokeWidth={2.25} aria-hidden className="shrink-0 mt-0.5 text-go" />
              : <CircleAlert size={22} strokeWidth={2.25} aria-hidden className="shrink-0 mt-0.5" />}
            <div className="min-w-0 flex-1">
              <div className="font-bold">Boss approved {Number(h.hours_approved)}h. You recorded {Number(h.hours_worked)}h.</div>
              <div className="say-sub">{h.disputed_at ? "You've told them you disagree. Both numbers stay on record." : "Both numbers stay on record. Best fix: ring them."}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <CallLink phone={h.boss_phone} name={h.boss_name} onCall={workerLogCall.bind(null, h.boss_id, h.id)} className="btn bg-white text-ink btn-sm w-full" />
            {!h.disputed_at && (
              <ConfirmButton action={disagree.bind(null, h.id)} className="btn bg-white text-ink btn-sm w-full" danger={false}
                title={`Tell ${first} you disagree?`}
                details={[
                  `${first} gets a message that you disagree with the ${Number(h.hours_approved)}h approved for ${fmtDay(h.day)}.`,
                  `Both numbers stay on record: you recorded ${Number(h.hours_worked)}h.`,
                  "Nothing is changed by itself — the two of you sort out the number.",
                ]}
                confirmLabel="Yes, tell them" cancelLabel="Not now">I disagree</ConfirmButton>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
