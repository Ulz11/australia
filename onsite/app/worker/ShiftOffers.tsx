"use client";
import { useState, useTransition } from "react";
import { BellRing, Check, MapPin, X } from "lucide-react";
import { takeShift } from "@/actions/worker";
import { TICKETS } from "@/lib/award";
import { otInWords, payForShift } from "@/lib/rules";
import { fmtDay, fmtTime, km, todayIso } from "@/lib/util";
import { Flag } from "@/components/ui";
import { OfferSheet } from "./OfferSheet";

export type O = {
  id: string; day: string; start_time: string; hours: number; spots: number; taken: number; role: string; rate: number;
  site: string; suburb: string; dist_m: number | null; boss: string; tickets_required: string[]; tickets_ok: boolean;
  missing: string[]; allow_offers: boolean; offered: boolean; direct: boolean; clash: boolean;
  ot_mode: string; ot_after_hours: number; ot_multiplier: number | null;
};

/**
 * What a boss has offered this worker. The first thing on their screen, because it's the only thing on it that
 * is waiting on them — hence the orange. "Take it" runs the same action as the calendar, and shows the same
 * answers back (licence missing, already working that day, spot gone).
 */
export function ShiftOffers({ offers }: { offers: O[] }) {
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const take = (id: string) => start(async () => {
    setBusy(id);
    setErr((e) => ({ ...e, [id]: "" }));
    const r = await takeShift(id);                  // redirects to My shift when it works
    setBusy(null);
    if (r?.error) setErr((e) => ({ ...e, [id]: r.error }));
  });
  return (
    <div className="space-y-3">
      {offers.map((o) => (
        <Card key={o.id} o={o} onTake={() => take(o.id)} pending={pending && busy === o.id} err={err[o.id]} />
      ))}
    </div>
  );
}

function Card({ o, onTake, pending, err }: { o: O; onTake: () => void; pending: boolean; err?: string }) {
  const [offering, setOffering] = useState(false);
  const today = todayIso();
  const left = o.spots - o.taken;
  const pay = payForShift(o.hours, o.rate, { ot_mode: o.ot_mode as never, ot_after_hours: o.ot_after_hours, ot_multiplier: o.ot_multiplier });
  const need = o.tickets_required.map((t) => TICKETS[t] ?? t).join(", ");
  const missing = o.missing.map((t) => TICKETS[t] ?? t).join(", ");
  return (
    <div className="rounded-2xl border-2 border-hv bg-hv-soft p-4">
      <div className="flex items-center justify-between gap-2">
        <Flag tone="orange" icon={BellRing}>{o.direct ? "Booked for you" : "Offered to you"}</Flag>
        {left === 1 && o.spots > 1 && <span className="text-sm font-bold text-steel">Last spot</span>}
      </div>

      <div className="text-2xl font-extrabold mt-2 leading-tight">
        {o.day === today ? "Today" : fmtDay(o.day)} · {fmtTime(o.start_time)}
      </div>
      <div className="text-lg font-bold">{o.site}</div>
      <div className="text-steel flex items-center gap-1.5">
        <MapPin size={16} strokeWidth={2.25} aria-hidden className="shrink-0" />
        {o.suburb}{o.dist_m != null ? ` · ${km(o.dist_m)} from home` : ""}
      </div>

      <div className="mt-2 text-lg">{o.role} · {o.hours} hours</div>
      <div className="num"><b>${o.rate.toFixed(2)} an hour</b> <span className="text-steel">· about ${Math.round(pay.gross).toLocaleString("en-AU")} for the day</span></div>
      <div className="text-sm text-steel">{o.boss} · overtime: {otInWords({ ot_mode: o.ot_mode as never, ot_after_hours: o.ot_after_hours, ot_multiplier: o.ot_multiplier }, o.rate)}</div>

      <div className={`mt-2 font-semibold flex items-start gap-1.5 ${o.tickets_ok ? "text-go" : "text-warn"}`}>
        {o.tickets_ok
          ? <><Check size={20} strokeWidth={2.5} aria-hidden className="shrink-0" />You have what it needs: {need}</>
          : <><X size={20} strokeWidth={2.5} aria-hidden className="shrink-0" />Needs {missing} — that one isn't on your cards</>}
      </div>
      {o.clash && <div className="text-sm font-semibold text-warn mt-1">You already have a shift that day.</div>}

      <button className="btn-primary mt-3" onClick={onTake} disabled={pending}>{pending ? "Taking it…" : "Take it"}</button>
      {err && <div className="say-red mt-2"><div className="font-bold">{err}</div></div>}

      {o.allow_offers && !offering && (
        o.offered
          ? <div className="text-center text-sm text-steel mt-2 font-semibold">You've asked for a different deal — waiting on the boss.</div>
          : <button className="btn-ghost btn-sm w-full mt-2" onClick={() => setOffering(true)}>Ask for a different deal</button>
      )}
      {offering && <OfferSheet shift={{ id: o.id, rate: o.rate, hours: o.hours, start_time: o.start_time, site: o.site }} onClose={() => setOffering(false)} />}
    </div>
  );
}
