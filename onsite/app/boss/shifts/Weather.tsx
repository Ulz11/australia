"use client";
import { useState, useTransition } from "react";
import { markWeather, clearWeather } from "@/actions/boss";
import { Field } from "@/components/ui";

const KINDS: [string, string, string][] = [
  ["rain", "🌧️", "Rain"], ["wind", "💨", "Wind"], ["heat", "🥵", "Heat"], ["storm", "⛈️", "Storm"], ["other", "⚠️", "Something else"],
];

/**
 * Weather stopped work. The app doesn't decide the money — it records that the day
 * was cut short and why, so the hours the boss approves have a reason next to them.
 */
export function Weather({ shiftId, stop, note }: { shiftId: string; stop: string | null; note: string | null }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("rain");
  const [pending, start] = useTransition();

  if (stop) {
    const k = KINDS.find((x) => x[0] === stop);
    return (
      <div className="say-dark">
        <div className="say-sub">Work stopped</div>
        <div className="say-title">{k?.[1]} {k?.[2]} {note ? `— ${note}` : ""}</div>
        <div className="say-sub">Everyone on this shift was told. Set each worker's hours below — you decide the number, we write it down.</div>
        <button disabled={pending} className="btn bg-white text-ink btn-sm w-full mt-3" onClick={() => start(() => clearWeather(shiftId))}>
          Work went ahead after all
        </button>
      </div>
    );
  }
  if (!open)
    return <button className="btn-ghost" onClick={() => setOpen(true)}>🌧️ Weather stopped work</button>;

  return (
    <form action={markWeather} className="card space-y-3 border-2 border-ink">
      <input type="hidden" name="shift_id" value={shiftId} />
      <input type="hidden" name="weather_stop" value={kind} />
      <div className="text-xl font-extrabold">What stopped the job?</div>
      <div className="grid grid-cols-3 gap-2">
        {KINDS.map(([v, icon, label]) => (
          <button key={v} type="button" onClick={() => setKind(v)} className={`chip justify-center w-full text-sm ${kind === v ? "chip-on" : ""}`}>
            {icon} {label}
          </button>
        ))}
      </div>
      <Field label="A line for the crew (optional)"><input name="weather_note" maxLength={200} className="input" placeholder="Called it at 10am, too wet to pour." /></Field>
      <div className="say-grey text-sm">
        Everyone booked gets a message. Then you set what you'll pay each of them — we suggest a number based on whether they turned up.
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn-ghost btn-sm w-full" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn-dark btn-sm w-full">Tell the crew</button>
      </div>
    </form>
  );
}
