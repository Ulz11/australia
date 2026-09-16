"use client";
import { useState, useTransition } from "react";
import { CloudLightning, CloudRain, Sun, Thermometer, TriangleAlert, Wind, type LucideIcon } from "lucide-react";
import { markWeather, clearWeather } from "@/actions/boss";
import { Field } from "@/components/ui";

export const KINDS: { v: string; icon: LucideIcon; label: string }[] = [
  { v: "rain", icon: CloudRain, label: "Rain" },
  { v: "wind", icon: Wind, label: "Wind" },
  { v: "heat", icon: Thermometer, label: "Heat" },
  { v: "storm", icon: CloudLightning, label: "Storm" },
  { v: "other", icon: TriangleAlert, label: "Something else" },
];
export const weatherKind = (stop: string | null) => KINDS.find((k) => k.v === stop) ?? KINDS[4];

/**
 * Weather stopped work. The app doesn't decide the money — it records that the day
 * was cut short and why, so the hours the boss approves have a reason next to them.
 *
 * Two pieces: the note that says what happened (up with the shift's state), and the row
 * down in the quiet list of things you rarely press.
 */
export function WeatherRow({ shiftId, stop }: { shiftId: string; stop: string | null }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("rain");
  const [pending, start] = useTransition();

  if (stop)
    return (
      <button disabled={pending} className="act" onClick={() => start(() => clearWeather(shiftId))}>
        <Sun size={20} strokeWidth={2.25} aria-hidden className="shrink-0 text-steel" />
        <span className="flex-1">Work went ahead after all<span className="block text-sm font-normal text-steel">Takes the weather note off this shift.</span></span>
      </button>
    );

  if (!open)
    return (
      <button className="act" onClick={() => setOpen(true)}>
        <CloudRain size={20} strokeWidth={2.25} aria-hidden className="shrink-0 text-steel" />
        <span className="flex-1">Weather stopped work<span className="block text-sm font-normal text-steel">Tells the crew and helps you set the hours.</span></span>
      </button>
    );

  return (
    <form action={markWeather} className="p-4 space-y-3">
      <input type="hidden" name="shift_id" value={shiftId} />
      <input type="hidden" name="weather_stop" value={kind} />
      <div className="text-xl font-extrabold">What stopped the job?</div>
      <div className="grid grid-cols-3 gap-2">
        {KINDS.map(({ v, icon: Icon, label }) => (
          <button key={v} type="button" onClick={() => setKind(v)} className={`chip justify-center gap-1.5 w-full text-sm ${kind === v ? "chip-on" : ""}`}>
            <Icon size={18} strokeWidth={2.25} aria-hidden className="shrink-0" />{label}
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
