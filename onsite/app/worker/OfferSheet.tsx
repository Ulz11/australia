"use client";
import { useState } from "react";
import { makeOffer } from "@/actions/worker";
import { money, AWARD_CASUAL_FLOOR } from "@/lib/award";
import { Field } from "@/components/ui";

/**
 * The deal request. Three numbers and a note — everything the app can hold the
 * two sides to later. "Take it" is still the main button; this is the side door.
 */
export function OfferSheet({ shift, onClose }: {
  shift: { id: string; rate: number; hours: number; start_time: string; site: string };
  onClose: () => void;
}) {
  const [rate, setRate] = useState(shift.rate);
  const [hours, setHours] = useState(shift.hours);
  const [start, setStart] = useState(shift.start_time.slice(0, 5));
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const changed = rate !== shift.rate || hours !== shift.hours || start !== shift.start_time.slice(0, 5);

  if (sent)
    return (
      <div className="say-green mt-3">
        <div className="say-title">Sent to the boss</div>
        <div className="say-sub">He'll say yes, no, or come back with a different number. You'll get a message either way.</div>
        <button className="btn bg-white text-ink btn-sm w-full mt-3" onClick={onClose}>Close</button>
      </div>
    );

  return (
    <form className="mt-3 rounded-2xl border-2 border-ink p-4 space-y-4"
      action={async (fd) => { const r = await makeOffer(fd); if (r?.error) setErr(r.error); else setSent(true); }}>
      <input type="hidden" name="shift_id" value={shift.id} />
      <div>
        <div className="text-xl font-extrabold">Ask for a different deal</div>
        <div className="text-steel">Change what you want and say why. Nothing is booked until the boss agrees.</div>
      </div>

      <Field label="Pay per hour" hint={`The shift says ${money(shift.rate)}. You can't ask below ${money(AWARD_CASUAL_FLOOR)}.`}>
        <div className="flex items-center gap-2">
          <span className="text-2xl font-extrabold">$</span>
          <input name="rate" type="number" step="0.05" min={AWARD_CASUAL_FLOOR} value={rate} onChange={(e) => setRate(Number(e.target.value))}
            className="input w-36 num text-2xl font-extrabold text-center" />
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Hours">
          <input name="hours" type="number" step="0.5" min={1} max={14} value={hours} onChange={(e) => setHours(Number(e.target.value))}
            className="input num text-xl font-bold text-center" />
        </Field>
        <Field label="Start">
          <input name="start_time" type="time" value={start} onChange={(e) => setStart(e.target.value)} className="input text-xl font-bold text-center" />
        </Field>
      </div>

      <Field label="Say why (optional)" hint="One line. Bosses answer a reason faster than a number on its own.">
        <textarea name="message" rows={2} maxLength={300} className="input py-3 min-h-[80px]"
          placeholder="I've got 8 years formwork and my own tools." />
      </Field>

      {changed && (
        <div className="say-dark">
          <div className="say-sub">You're asking for</div>
          <div className="say-title num">{money(rate)}/h · {hours}h from {start} · about {money(rate * hours)} for the day</div>
        </div>
      )}
      {err && <div className="say-red"><div className="font-bold">{err}</div></div>}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn-ghost btn-sm w-full" onClick={onClose}>Cancel</button>
        <button className="btn-dark btn-sm w-full">Send request</button>
      </div>
    </form>
  );
}
