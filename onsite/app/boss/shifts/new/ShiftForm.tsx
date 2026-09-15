"use client";
import { useState } from "react";
import { createShift } from "@/actions/boss";
import { AWARD_CASUAL_FLOOR, TICKETS } from "@/lib/award";
import { otInWords } from "@/lib/rules";
import { Field } from "@/components/ui";

const ROLES = ["General labourer", "Formworker", "Concreter", "Carpenter", "Steel fixer", "Forklift driver", "Scaffolder", "Dogman / rigger", "Cleaner / demo"];
const HOURS = [4, 6, 8, 10];
const STARTS = ["06:00", "06:30", "07:00", "07:30", "08:00", "13:00"];
const say = (t: string) => { const [h, m] = t.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`; };

export function ShiftForm({ projects, projectId, days, direct, crew }: {
  projects: { id: string; name: string }[]; projectId: string; days: { v: string; l: string }[];
  direct: { id: string; name: string; rate: number | null } | null; crew: { id: string; name: string; type: string; rate: number | null }[];
}) {
  const [who, setWho] = useState<string>(direct?.id ?? "new");
  const [rate, setRate] = useState(direct?.rate ?? AWARD_CASUAL_FLOOR);
  const [hours, setHours] = useState(8);
  const [spots, setSpots] = useState(1);
  const [day, setDay] = useState(days[1].v);
  const [pick, setPick] = useState(false);
  const [start, setStart] = useState("06:30");
  const [tix, setTix] = useState<string[]>([]);
  const [needLic, setNeedLic] = useState(false);
  const [otMode, setOtMode] = useState<"award" | "flat" | "custom">("award");
  const [otAfter, setOtAfter] = useState(8);
  const [otMult, setOtMult] = useState(1.5);
  const [allowOffers, setAllowOffers] = useState(true);
  const r = Math.max(rate || 0, AWARD_CASUAL_FLOOR);
  const chosen = crew.find((c) => c.id === who);

  return (
    <form action={createShift} className="space-y-6">
      <input type="hidden" name="direct_worker_id" value={who === "new" ? "" : who} />
      <input type="hidden" name="day" value={day} /><input type="hidden" name="start_time" value={start} />
      <input type="hidden" name="hours" value={hours} /><input type="hidden" name="spots" value={who === "new" ? spots : 1} />
      {tix.map((t) => <input key={t} type="hidden" name="tickets" value={t} />)}
      <input type="hidden" name="ot_mode" value={otMode} /><input type="hidden" name="ot_after_hours" value={otAfter} />
      <input type="hidden" name="ot_multiplier" value={otMult} /><input type="hidden" name="allow_offers" value={allowOffers ? "1" : "0"} />

      <Field label="Which site?">
        <select name="project_id" defaultValue={projectId} className="input">{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </Field>

      {crew.length > 0 && (
        <Field label="Who?" hint={who === "new" ? "We find workers near the site who are free that day." : "Goes straight to their phone. Nobody else is asked."}>
          <div className="flex flex-wrap gap-2">
            <Chip on={who === "new"} onClick={() => setWho("new")}>Find new workers</Chip>
            {crew.map((c) => <Chip key={c.id} on={who === c.id} onClick={() => { setWho(c.id); if (c.rate) setRate(c.rate); }}>{c.name.split(" ")[0]}</Chip>)}
          </div>
        </Field>
      )}

      <Field label="Which day?">
        <div className="grid grid-cols-3 gap-2">
          {days.map((d) => <Chip key={d.v} on={day === d.v && !pick} onClick={() => { setDay(d.v); setPick(false); }}>{d.l}</Chip>)}
        </div>
        {pick ? <input type="date" value={day} min={days[0].v} onChange={(e) => setDay(e.target.value)} className="input mt-2" />
              : <button type="button" className="text-steel underline text-base mt-2" onClick={() => setPick(true)}>Another day</button>}
      </Field>

      <Field label="Start time">
        <div className="grid grid-cols-3 gap-2">{STARTS.map((t) => <Chip key={t} on={start === t} onClick={() => setStart(t)}>{say(t)}</Chip>)}</div>
      </Field>

      <Field label="How many hours?">
        <div className="grid grid-cols-4 gap-2">{HOURS.map((h) => <Chip key={h} on={hours === h} onClick={() => setHours(h)}>{h}h</Chip>)}</div>
      </Field>

      {who === "new" && (
        <Field label="How many workers?">
          <div className="flex items-center gap-3">
            <button type="button" className="btn-ghost w-16 text-3xl" onClick={() => setSpots(Math.max(1, spots - 1))}>−</button>
            <div className="text-5xl font-extrabold w-16 text-center num">{spots}</div>
            <button type="button" className="btn-ghost w-16 text-3xl" onClick={() => setSpots(Math.min(20, spots + 1))}>+</button>
          </div>
        </Field>
      )}

      <Field label="Doing what?" hint="Everyone needs a White Card. That's automatic.">
        <select name="role" className="input">{ROLES.map((x) => <option key={x}>{x}</option>)}</select>
        {!needLic ? <button type="button" className="text-steel underline text-base mt-2" onClick={() => setNeedLic(true)}>Needs a licence? (forklift, EWP, dogging, scaffold)</button> : (
          <div className="flex flex-wrap gap-2 mt-2">
            {Object.entries(TICKETS).filter(([k]) => k !== "WC").map(([k, v]) => (
              <Chip key={k} on={tix.includes(k)} onClick={() => setTix(tix.includes(k) ? tix.filter((t) => t !== k) : [...tix, k])}>{v}</Chip>
            ))}
          </div>
        )}
      </Field>

      <Field label="Pay per hour" hint={`Lowest allowed is $${AWARD_CASUAL_FLOOR.toFixed(2)} (the Award, casual). Super 12% is on top of this.`}>
        <div className="flex items-center gap-2">
          <span className="text-3xl font-extrabold">$</span>
          <input type="number" name="rate" step="0.05" min={AWARD_CASUAL_FLOOR} value={rate} onChange={(e) => setRate(Number(e.target.value))} className="input text-3xl font-extrabold num w-40 text-center" />
          <span className="text-lg text-steel">an hour</span>
        </div>
        {rate < AWARD_CASUAL_FLOOR && <div className="text-warn font-semibold mt-1">Too low — it'll go out at ${AWARD_CASUAL_FLOOR.toFixed(2)}.</div>}
      </Field>

      <Field label="Overtime — settle it now, not on payday"
             hint="The worker sees this before he takes the shift. Agreeing it up front is what stops the argument on Friday.">
        <div className="space-y-2">
          {([["award", "Award overtime", "1.5× for two hours after 8, then 2×. The safe default."],
             ["flat", "Same rate all day", "Every hour at the posted rate. Only legal if it beats the Award."],
             ["custom", "My own deal", "Pick when overtime starts and what it pays."]] as const).map(([v, title, why]) => (
            <button key={v} type="button" onClick={() => setOtMode(v)}
              className={`w-full text-left rounded-2xl border-2 p-3 ${otMode === v ? "border-ink bg-ink text-white" : "border-line bg-white"}`}>
              <div className="font-bold">{title}</div>
              <div className={`text-sm ${otMode === v ? "text-white/70" : "text-steel"}`}>{why}</div>
            </button>
          ))}
        </div>
        {otMode === "custom" && (
          <div className="grid grid-cols-2 gap-2 mt-2">
            <div><div className="text-sm font-bold mb-1">Overtime starts after</div>
              <input type="number" min={1} max={14} step={0.5} value={otAfter} onChange={(e) => setOtAfter(Number(e.target.value))} className="input num text-xl font-bold text-center" /></div>
            <div><div className="text-sm font-bold mb-1">Then times</div>
              <input type="number" min={1} max={3} step={0.25} value={otMult} onChange={(e) => setOtMult(Number(e.target.value))} className="input num text-xl font-bold text-center" /></div>
          </div>
        )}
        <div className="text-sm mt-2 rounded-xl bg-site px-3 py-2">
          <b>Worker will see:</b> {otInWords({ ot_mode: otMode, ot_after_hours: otAfter, ot_multiplier: otMult }, r)}
          {otMode !== "award" && <div className="text-steel mt-0.5">We still top it up to the Award if the Award works out higher. You can pay more than the Award, never less.</div>}
        </div>
      </Field>

      <Field label="Can workers ask for a different deal?" hint="Turn this off when you just need bodies at 6am and the rate is the rate.">
        <div className="seg grid-cols-2">
          <button type="button" onClick={() => setAllowOffers(true)} className={`seg-item ${allowOffers ? "seg-on" : ""}`}>Yes, let them ask</button>
          <button type="button" onClick={() => setAllowOffers(false)} className={`seg-item ${!allowOffers ? "seg-on" : ""}`}>No, fixed rate</button>
        </div>
      </Field>

      <Field label="One line for the crew (optional)"><input name="note" className="input" placeholder="Steel caps. Park on Smith St." maxLength={120} /></Field>

      <div className="say-dark">
        <div className="say-sub">You're posting</div>
        <div className="say-title">{who === "new" ? `${spots} × ` : `${chosen?.name.split(" ")[0] ?? direct?.name.split(" ")[0]} · `}{hours}h from {say(start)} · ≈ ${(r * hours).toFixed(0)} each for the day</div>
      </div>
      <button className="btn-primary text-xl">{who === "new" ? "Find workers" : "Send it"}</button>
    </form>
  );
}
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={`chip justify-center ${on ? "chip-on" : ""}`}>{children}</button>;
}
