"use client";
import { useState, useTransition } from "react";
import { acceptOffer, declineOffer, counterOffer } from "@/actions/boss";
import { money, AWARD_CASUAL_FLOOR } from "@/lib/award";
import { Avatar, Field, Flag, type Tone } from "@/components/ui";

export type BO = {
  id: string; status: string; message: string | null;
  rate: number | null; hours: number | null; start_time: string | null;
  shift_rate: number; shift_hours: number; shift_start: string;
  when: string; site: string; role: string;
  worker: string; photo: string | null; years: number | null; trades: string[];
  score: number | null; done: number; full: boolean;
};

export function OfferCard({ o }: { o: BO }) {
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"none" | "counter" | "decline">("none");
  const [err, setErr] = useState<string | null>(null);
  const [rate, setRate] = useState(o.rate ?? o.shift_rate);

  const asked = o.rate ?? o.shift_rate, hours = o.hours ?? o.shift_hours;
  const dayNow = o.shift_rate * o.shift_hours, dayAsk = asked * hours;
  const extra = dayAsk - dayNow;

  const label = { pending: null, accepted: ["Agreed", "green"], declined: ["You said no", "grey"],
    withdrawn: ["Pulled out", "grey"], countered: ["You countered", "dark"], expired: ["Too late", "grey"] }[o.status] as [string, Tone] | null | undefined;

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-3">
        <Avatar name={o.worker} photo={o.photo} />
        <div className="flex-1 min-w-0">
          <div className="text-lg font-bold truncate">{o.worker}</div>
          <div className="text-sm text-steel truncate">
            {o.score != null ? `Turns up ${o.score}% · ${o.done} shifts` : "New — first shift"}{o.years ? ` · ${o.years}y on the tools` : ""}
          </div>
        </div>
        {label && <Flag tone={label[1]} className="shrink-0">{label[0]}</Flag>}
      </div>

      <div className="text-steel">{o.when} · {o.site} · {o.role}</div>
      {o.trades.length > 0 && <div className="text-sm text-steel">Can do: {o.trades.slice(0, 4).join(", ")}</div>}

      <div className="say-dark">
        <div className="say-sub">He's asking for</div>
        <div className="say-title num">{money(asked)}/h · {hours}h{o.start_time ? ` from ${o.start_time}` : ""}</div>
        <div className="say-sub num">
          {money(dayAsk)} for the day{extra !== 0 && <> — {extra > 0 ? `${money(extra)} more` : `${money(-extra)} less`} than you posted</>}
        </div>
      </div>

      {o.message && <div className="bg-site rounded-xl p-3">“{o.message}”</div>}

      {o.status === "pending" && !o.full && mode === "none" && (
        <div className="space-y-2">
          <button disabled={pending} className="btn-primary"
            onClick={() => start(async () => { const r = await acceptOffer(o.id); if (r?.error) setErr(r.error); })}>
            Yes — book him at {money(asked)}
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button className="btn-ghost btn-sm w-full" onClick={() => setMode("counter")}>Offer my own price</button>
            <button className="btn-danger btn-sm w-full" onClick={() => setMode("decline")}>No thanks</button>
          </div>
        </div>
      )}
      {o.status === "pending" && o.full && <div className="say-grey"><div className="font-bold">Shift is full now.</div></div>}

      {mode === "counter" && (
        <form className="space-y-3 border-t border-line pt-3"
          action={async (fd) => { const r = await counterOffer(fd); if (r?.error) setErr(r.error); else setMode("none"); }}>
          <input type="hidden" name="offer_id" value={o.id} />
          <Field label="What you'll actually pay" hint={`He asked ${money(asked)}. Award floor is ${money(AWARD_CASUAL_FLOOR)}.`}>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-extrabold">$</span>
              <input name="rate" type="number" step="0.05" min={AWARD_CASUAL_FLOOR} value={rate} onChange={(e) => setRate(Number(e.target.value))}
                className="input w-36 num text-2xl font-extrabold text-center" />
            </div>
          </Field>
          <Field label="A line back to him (optional)">
            <input name="message" maxLength={200} className="input" placeholder="Best I can do on this job." />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="btn-ghost btn-sm w-full" onClick={() => setMode("none")}>Cancel</button>
            <button className="btn-dark btn-sm w-full">Send my price</button>
          </div>
        </form>
      )}

      {mode === "decline" && (
        <form className="space-y-3 border-t border-line pt-3" action={async (fd) => { await declineOffer(fd); setMode("none"); }}>
          <input type="hidden" name="offer_id" value={o.id} />
          <Field label="Why? (optional)" hint="He keeps the shift on his list at the posted rate.">
            <input name="why" maxLength={200} className="input" placeholder="Rate's fixed on this job." />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="btn-ghost btn-sm w-full" onClick={() => setMode("none")}>Cancel</button>
            <button className="btn-danger btn-sm w-full">Send no</button>
          </div>
        </form>
      )}

      {err && <div className="say-red"><div className="font-bold">{err}</div></div>}
    </div>
  );
}
