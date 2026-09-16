"use client";
import { useState, useTransition } from "react";
import { Check, CircleAlert, Hourglass, X } from "lucide-react";
import { withdrawOffer, acceptCounter } from "@/actions/worker";
import { money } from "@/lib/award";
import { Say } from "@/components/ui";

export type O = {
  id: string; status: string; from_role: string; message: string | null;
  rate: number | null; hours: number | null; start_time: string | null;
  shift_rate: number; shift_hours: number; shift_start: string;
  when: string; site: string; boss: string; dead: boolean;
};

export function OfferRow({ o }: { o: O }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const rate = o.rate ?? o.shift_rate, hours = o.hours ?? o.shift_hours;
  const isCounter = o.from_role === "boss";

  // Orange only for the boss's counter-offer: that one is sitting there waiting for this worker to answer.
  const head = {
    pending: isCounter ? { tone: "orange" as const, icon: CircleAlert, title: "The boss came back with an offer" } : { tone: "grey" as const, icon: Hourglass, title: "Waiting on the boss" },
    accepted: { tone: "green" as const, icon: Check, title: "Agreed — you're booked" },
    declined: { tone: "red" as const, icon: X, title: "Boss said no" },
    withdrawn: { tone: "grey" as const, icon: X, title: "You pulled this one" },
    expired: { tone: "grey" as const, icon: Hourglass, title: "Shift went before he answered" },
  }[o.status] ?? { tone: "grey" as const, icon: undefined, title: o.status };

  return (
    <div className="card space-y-3">
      <div>
        <div className="text-lg font-bold">{o.when}</div>
        <div className="text-steel">{o.site} · {o.boss}</div>
      </div>

      <Say tone={head.tone} icon={head.icon} title={head.title}
        sub={`${money(rate)}/h · ${hours}h${o.start_time ? ` from ${o.start_time}` : ""} · about ${money(rate * hours)} for the day`} />

      {o.message && <div className="text-sm bg-site rounded-xl p-3">“{o.message}”</div>}

      {o.status === "pending" && !o.dead && (
        isCounter ? (
          <div className="grid grid-cols-2 gap-2">
            <button disabled={pending} className="btn-ghost btn-sm w-full" onClick={() => start(() => withdrawOffer(o.id))}>No thanks</button>
            <button disabled={pending} className="btn-primary btn-sm w-full"
              onClick={() => start(async () => { const r = await acceptCounter(o.id); if (r?.error) setErr(r.error); })}>Take this deal</button>
          </div>
        ) : (
          <button disabled={pending} className="btn-ghost btn-sm w-full" onClick={() => start(() => withdrawOffer(o.id))}>Pull my request</button>
        )
      )}
      {err && <div className="say-red"><div className="font-bold">{err}</div></div>}
    </div>
  );
}
