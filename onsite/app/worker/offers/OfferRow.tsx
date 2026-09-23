"use client";
import { useState, useTransition } from "react";
import { Check, CircleAlert, Hourglass, X } from "lucide-react";
import { withdrawOffer, acceptCounter } from "@/actions/worker";
import { money } from "@/lib/award";
import { Say } from "@/components/ui";
import { useT } from "@/components/Lang";

export type O = {
  id: string; status: string; from_role: string; message: string | null;
  rate: number | null; hours: number | null; start_time: string | null;
  shift_rate: number; shift_hours: number; shift_start: string;
  when: string; site: string; boss: string; dead: boolean;
};

export function OfferRow({ o }: { o: O }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const t = useT();
  const rate = o.rate ?? o.shift_rate, hours = o.hours ?? o.shift_hours;
  const isCounter = o.from_role === "boss";

  // Orange only for the boss's counter-offer: that one is sitting there waiting for this worker to answer.
  const head = {
    pending: isCounter ? { tone: "orange" as const, icon: CircleAlert, title: t("The boss came back with an offer") } : { tone: "grey" as const, icon: Hourglass, title: t("Waiting on the boss") },
    accepted: { tone: "green" as const, icon: Check, title: t("Agreed — you're booked") },
    declined: { tone: "red" as const, icon: X, title: t("Boss said no") },
    withdrawn: { tone: "grey" as const, icon: X, title: t("You pulled this one") },
    expired: { tone: "grey" as const, icon: Hourglass, title: t("Shift went before he answered") },
  }[o.status] ?? { tone: "grey" as const, icon: undefined, title: o.status };

  // The deal in one line. Two keys rather than one with an optional middle: a start time that is
  // there and one that is not are different sentences, and only the translation knows where it goes.
  const deal = { rate: money(rate), hours, total: money(rate * hours), time: o.start_time ?? "" };
  const sub = o.start_time
    ? t("{rate}/h · {hours}h from {time} · about {total} for the day", deal)
    : t("{rate}/h · {hours}h · about {total} for the day", deal);

  return (
    <div className="card space-y-3">
      <div>
        <div className="text-lg font-bold">{o.when}</div>
        <div className="text-steel">{o.site} · {o.boss}</div>
      </div>

      <Say tone={head.tone} icon={head.icon} title={head.title} sub={sub} />

      {o.message && <div className="text-sm bg-site rounded-xl p-3">“{o.message}”</div>}

      {o.status === "pending" && !o.dead && (
        isCounter ? (
          <div className="grid grid-cols-2 gap-2">
            <button disabled={pending} className="btn-ghost btn-sm w-full" onClick={() => start(() => withdrawOffer(o.id))}>{t("No thanks")}</button>
            <button disabled={pending} className="btn-primary btn-sm w-full"
              onClick={() => start(async () => { const r = await acceptCounter(o.id); if (r?.error) setErr(r.error); })}>{t("Take this deal")}</button>
          </div>
        ) : (
          <button disabled={pending} className="btn-ghost btn-sm w-full" onClick={() => start(() => withdrawOffer(o.id))}>{t("Pull my request")}</button>
        )
      )}
      {err && <div className="say-red"><div className="font-bold">{err}</div></div>}
    </div>
  );
}
