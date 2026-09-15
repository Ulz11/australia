"use client";
import { useState, useTransition } from "react";
import { withdrawOffer, acceptCounter } from "@/actions/worker";
import { money } from "@/lib/award";

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

  const head = {
    pending: isCounter ? { tone: "orange", title: "The boss came back with an offer" } : { tone: "grey", title: "Waiting on the boss" },
    accepted: { tone: "green", title: "Agreed — you're booked" },
    declined: { tone: "red", title: "Boss said no" },
    withdrawn: { tone: "grey", title: "You pulled this one" },
    expired: { tone: "grey", title: "Shift went before he answered" },
  }[o.status] ?? { tone: "grey", title: o.status };

  return (
    <div className="card space-y-3">
      <div>
        <div className="text-lg font-bold">{o.when}</div>
        <div className="text-steel">{o.site} · {o.boss}</div>
      </div>

      <div className={`say-${head.tone}`}>
        <div className="say-title">{head.title}</div>
        <div className="say-sub num">{money(rate)}/h · {hours}h{o.start_time ? ` from ${o.start_time}` : ""} · about {money(rate * hours)} for the day</div>
      </div>

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
