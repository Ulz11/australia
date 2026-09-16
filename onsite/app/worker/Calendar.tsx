"use client";
import { useMemo, useOptimistic, useState, useTransition } from "react";
import { BellRing, Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { setAvailability, setPattern, takeShift } from "@/actions/worker";
import { fmtDay, fmtTime, km, todayIso } from "@/lib/util";
import { TICKETS } from "@/lib/award";
import { otInWords } from "@/lib/rules";
import { Flag } from "@/components/ui";
import { OfferSheet } from "./OfferSheet";

export type S = { id: string; day: string; start_time: string; hours: number; rate: number; role: string; site: string; dist_m: number; boss: string; spots: number; taken: number; tickets_ok: boolean; notified: boolean; mine: boolean; tickets_required: string[]; approve_h: number | null; pay_d: number | null; ot_mode?: string; ot_after_hours?: number; ot_multiplier?: number | null; allow_offers?: boolean; offered?: boolean };
type B = { id: string; day: string; start_time: string; site: string; hours: number; status: string };
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function Calendar({ availability, shifts, bookings }: { availability: Record<string, string>; shifts: S[]; bookings: B[] }) {
  const today = todayIso();
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [sel, setSel] = useState<string>(today);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [showPattern, setShowPattern] = useState(false);
  // Free/Busy flips on screen the instant you tap; the server catches up.
  const [avail, setAvailOpt] = useOptimistic(availability, (cur, upd: { day: string; status: string }) => ({ ...cur, [upd.day]: upd.status }));

  const days = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
    const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const out: (string | null)[] = Array(lead).fill(null);
    for (let i = 1; i <= n; i++) out.push(iso(new Date(Date.UTC(y, m - 1, i))));
    return out;
  }, [month]);
  const byDay = useMemo(() => { const m: Record<string, S[]> = {}; for (const s of shifts) if (!s.mine) (m[s.day] ||= []).push(s); return m; }, [shifts]);
  const bookByDay = useMemo(() => Object.fromEntries(bookings.map((b) => [b.day, b])), [bookings]);
  const moveMonth = (n: number) => { const [y, m] = month.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); setMonth(iso(d).slice(0, 7)); };

  const selShifts = byDay[sel] ?? [];
  const selBook = bookByDay[sel];
  const status = selBook ? "working" : avail[sel] ?? "busy";
  const flip = (s: "free" | "busy") => start(async () => { setAvailOpt({ day: sel, status: s }); await setAvailability(sel, s); });

  return (
    <div className="space-y-3">
      <div className="card p-3">
        <div className="flex items-center justify-between mb-2">
          <button className="btn-ghost btn-sm" aria-label="Month before" onClick={() => moveMonth(-1)}><ChevronLeft size={22} strokeWidth={2.5} aria-hidden /></button>
          <div className="text-lg font-extrabold">{new Date(month + "-01T00:00:00Z").toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" })}</div>
          <button className="btn-ghost btn-sm" aria-label="Month after" onClick={() => moveMonth(1)}><ChevronRight size={22} strokeWidth={2.5} aria-hidden /></button>
        </div>
        <div className="grid grid-cols-7 text-center text-xs text-steel font-bold mb-1">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d}>{d}</div>)}</div>
        <div className="grid grid-cols-7 gap-1">
          {days.map((d, i) => {
            if (!d) return <div key={i} />;
            const past = d < today;
            const b = bookByDay[d];
            const st = b ? "working" : avail[d] ?? "busy";
            const n = (byDay[d] ?? []).length;
            const hot = (byDay[d] ?? []).some((s) => s.notified);
            const cls = st === "working" ? "bg-ink text-white" : st === "free" ? "bg-go text-white" : "bg-site text-steel";
            return (
              <button key={d} onClick={() => setSel(d)} disabled={past}
                className={`relative aspect-square rounded-xl text-base font-bold ${cls} ${past ? "opacity-30" : ""} ${sel === d ? "ring-[3px] ring-ink ring-offset-1" : ""}`}>
                {Number(d.slice(8))}
                {b && <span className="absolute bottom-0.5 inset-x-0 text-[10px] font-normal leading-none">{fmtTime(b.start_time).replace(":00", "")}</span>}
                {!b && n > 0 && <span className={`absolute top-1 right-1 w-2.5 h-2.5 rounded-full border border-white ${hot ? "bg-hv" : "bg-steel"}`} />}
              </button>
            );
          })}
        </div>
        <div className="flex gap-4 text-sm text-steel mt-3 flex-wrap font-semibold">
          <L c="bg-go" t="Free" /><L c="bg-site border border-line" t="Busy" /><L c="bg-ink" t="Working" /><span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-hv" />Offer for you</span>
        </div>
      </div>

      <div className="card space-y-3">
        <div className="text-xl font-extrabold">{sel === today ? "Today" : fmtDay(sel)}</div>

        {selBook ? (
          <div className="say-dark">
            <div className="say-sub">You're working</div>
            <div className="say-title">{selBook.site}</div>
            <div className="say-sub">{fmtTime(selBook.start_time)} · {selBook.hours} hours · <a href="/worker/shift" className="underline font-bold">open My shift</a></div>
          </div>
        ) : (
          <div>
            <div className="text-base font-bold mb-1.5">Can you work this day?</div>
            <div className="seg grid-cols-2">
              <button disabled={pending} onClick={() => flip("free")} className={`seg-item ${status === "free" ? "bg-go text-white" : ""}`}>Yes, I'm free</button>
              <button disabled={pending} onClick={() => flip("busy")} className={`seg-item ${status === "busy" ? "bg-slab text-white" : ""}`}>No, busy</button>
            </div>
            <div className="text-sm text-steel mt-1">{status === "free" ? "Bosses nearby can send you shifts for this day." : "You won't be asked about this day."}</div>
          </div>
        )}

        {selShifts.length === 0 ? (
          !selBook && <p className="text-steel">{status === "free" ? "Nothing near you for this day yet. Your phone will buzz when a boss posts." : "Nothing to show."}</p>
        ) : (
          <div className="space-y-2">
            <div className="text-base font-bold">Shifts near you this day</div>
            {selShifts.map((s) => <ShiftCard key={s.id} s={s} onTake={() => start(async () => { setErr(null); const r = await takeShift(s.id); if (r?.error) setErr(r.error); })} pending={pending} />)}
            {err && <div className="say-red"><div className="say-title">{err}</div></div>}
          </div>
        )}
      </div>

      <button className="text-steel underline text-base" onClick={() => setShowPattern(!showPattern)}>I'm free the same days every week</button>
      {showPattern && (
        <form action={setPattern} className="card space-y-3">
          <div className="text-lg font-bold">Tick the days you're usually free</div>
          <div className="grid grid-cols-4 gap-2">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => (
              <label key={d} className="cursor-pointer"><input type="checkbox" name="dow" value={(i + 1) % 7} className="peer sr-only" /><span className="chip justify-center w-full peer-checked:bg-go peer-checked:text-white peer-checked:border-go">{d}</span></label>
            ))}
          </div>
          <button className="btn-dark">Set for the next 8 weeks</button>
          <div className="text-sm text-steel">Days you already have a shift on stay as they are.</div>
        </form>
      )}
    </div>
  );
}
function L({ c, t }: { c: string; t: string }) { return <span className="flex items-center gap-1.5"><span className={`w-4 h-4 rounded ${c}`} />{t}</span>; }

export function ShiftCard({ s, onTake, pending }: { s: S; onTake: () => void; pending: boolean }) {
  const [offering, setOffering] = useState(false);
  const left = s.spots - s.taken;
  const need = s.tickets_required.filter((t) => t !== "WC");
  const canTake = s.tickets_ok && left > 0;
  return (
    <div className={`rounded-2xl border-2 p-4 ${s.notified ? "border-hv bg-hv-soft" : "border-line bg-white"}`}>
      {s.notified && <Flag tone="orange" icon={BellRing} className="mb-2">Offered to you</Flag>}
      <div className="text-2xl font-extrabold num">${Math.round(s.rate * s.hours)} <span className="text-base font-semibold text-steel">for the day</span></div>
      <div className="text-lg font-bold mt-1">{s.role} · {s.site}</div>
      <div className="text-steel">{fmtTime(s.start_time)} start · {s.hours} hours · ${s.rate.toFixed(2)} an hour</div>
      <div className="text-steel">{km(s.dist_m)} from home · {s.boss}{left > 1 ? ` · ${left} spots` : left === 1 && s.spots > 1 ? " · last spot" : ""}</div>
      {need.length > 0 && (
        <div className={`mt-1 font-semibold flex items-start gap-1.5 ${s.tickets_ok ? "text-go" : "text-warn"}`}>
          {s.tickets_ok
            ? <><Check size={20} strokeWidth={2.5} aria-hidden className="shrink-0" />You have the {need.map((t) => TICKETS[t] ?? t).join(", ")} licence</>
            : <><X size={20} strokeWidth={2.5} aria-hidden className="shrink-0" />Needs {need.map((t) => TICKETS[t] ?? t).join(", ")} licence — you don't</>}
        </div>
      )}
      {s.ot_mode && (
        <div className="text-sm mt-1.5 rounded-lg bg-site px-2.5 py-1.5">
          <b>Overtime agreed up front:</b> {otInWords({ ot_mode: s.ot_mode as never, ot_after_hours: s.ot_after_hours ?? 8, ot_multiplier: s.ot_multiplier ?? null }, s.rate)}
        </div>
      )}
      {(s.approve_h != null || s.pay_d != null) && <div className="text-sm text-steel mt-1">This boss {s.approve_h != null ? `approves hours in ~${s.approve_h}h` : ""}{s.approve_h != null && s.pay_d != null ? ", " : ""}{s.pay_d != null ? `pays in ~${s.pay_d} days` : ""}.</div>}
      <button className="btn-primary mt-3" onClick={onTake} disabled={pending || !canTake}>{!s.tickets_ok ? "Can't take — licence needed" : left <= 0 ? "Filled" : "Take it"}</button>
      {canTake && s.allow_offers !== false && !offering && (
        s.offered
          ? <div className="text-center text-sm text-steel mt-2 font-semibold">You've asked for a different deal — waiting on the boss.</div>
          : <button className="btn-ghost btn-sm w-full mt-2" onClick={() => setOffering(true)}>Ask for a different deal</button>
      )}
      {offering && <OfferSheet shift={{ id: s.id, rate: s.rate, hours: s.hours, start_time: s.start_time, site: s.site }} onClose={() => setOffering(false)} />}
    </div>
  );
}
