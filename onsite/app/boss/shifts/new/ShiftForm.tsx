"use client";
import { useState } from "react";
import { Minus, Plus, Timer } from "lucide-react";
import { createShift } from "@/actions/boss";
import { AWARD_CASUAL_FLOOR, TICKETS } from "@/lib/award";
import { otInWords, payForShift } from "@/lib/rules";
import { ROLES, MAX_LINES, MAX_SPOTS } from "@/lib/posts";
import { Field } from "@/components/ui";

const HOURS = [4, 6, 8, 10];
const STARTS = ["06:00", "06:30", "07:00", "07:30", "08:00", "13:00"];
const say = (t: string) => { const [h, m] = t.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`; };
const floor = (rate: number) => Math.max(rate || 0, AWARD_CASUAL_FLOOR);
const weekday = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-AU", { weekday: "short", timeZone: "UTC" });

/** One kind of worker in "Who do you need?". Becomes its own shift when posted. */
type Line = { key: number; role: string; spots: number; rate: number; tix: string[]; needLic: boolean };

export function ShiftForm({ projects, projectId, days, direct, crew }: {
  projects: { id: string; name: string }[]; projectId: string; days: { v: string; l: string }[];
  direct: { id: string; name: string; rate: number | null } | null; crew: { id: string; name: string; type: string; rate: number | null }[];
}) {
  const [who, setWho] = useState<string>(direct?.id ?? "new");
  const [rate, setRate] = useState(direct?.rate ?? AWARD_CASUAL_FLOOR);
  const [hours, setHours] = useState(8);
  const [day, setDay] = useState(days[1].v);
  const [pick, setPick] = useState(false);
  const [start, setStart] = useState("06:30");
  const [tix, setTix] = useState<string[]>([]);
  const [needLic, setNeedLic] = useState(false);
  const [lines, setLines] = useState<Line[]>([{ key: 0, role: ROLES[0], spots: 1, rate: AWARD_CASUAL_FLOOR, tix: [], needLic: false }]);
  const [otMode, setOtMode] = useState<"award" | "flat" | "custom">("award");
  const [otAfter, setOtAfter] = useState(8);
  const [otMult, setOtMult] = useState(1.5);
  const [otOpen, setOtOpen] = useState(false);
  const [allowOffers, setAllowOffers] = useState(true);
  const r = floor(rate);
  const chosen = crew.find((c) => c.id === who);
  const finding = who === "new";
  const terms = { ot_mode: otMode, ot_after_hours: otAfter, ot_multiplier: otMult };

  const edit = (key: number, change: Partial<Line>) => setLines(lines.map((l) => (l.key === key ? { ...l, ...change } : l)));
  // A new line starts at the pay of the line above — most of a crew is paid alike, and it's one tap to change.
  const addLine = () => setLines([...lines, { key: Math.max(...lines.map((l) => l.key)) + 1, role: ROLES[0], spots: 1, rate: lines[lines.length - 1].rate, tix: [], needLic: false }]);

  // What the worker reads about overtime quotes a dollar figure; with different rates per line, say it without one.
  const rates = finding ? [...new Set(lines.map((l) => floor(l.rate)))] : [r];
  const otWords = rates.length === 1 || otMode === "award" ? otInWords(terms, rates[0])
    : otMode === "flat" ? "Every hour at the rate for their kind of work, no overtime rate."
    : `After ${otAfter} hours, ${otMult}× the rate for their kind of work.`;
  const otShort = otMode === "award" ? "Award — 1.5× for 2 hours after 8, then 2×"
    : otMode === "flat" ? "Same rate all day, no overtime rate"
    : `${otMult}× after ${otAfter} hours`;

  // The running total in the bar at the bottom: what this job costs if everyone works the hours as posted.
  const allUp = lines.reduce((sum, l) => sum + l.spots * payForShift(hours, floor(l.rate), terms).gross, 0);
  const cost = finding ? allUp : payForShift(hours, r, terms).gross;
  const heads = finding ? lines.reduce((n, l) => n + l.spots, 0) : 1;
  const dayWord = day === days[0].v ? "Today" : weekday(day);
  const summary = `${finding ? `${heads} worker${heads > 1 ? "s" : ""}` : (chosen?.name ?? direct?.name ?? "").split(" ")[0]} · ${dayWord} ${say(start)} · ${hours}h`;

  return (
    <form action={createShift} className="space-y-6 pb-24">
      <input type="hidden" name="direct_worker_id" value={finding ? "" : who} />
      <input type="hidden" name="day" value={day} /><input type="hidden" name="start_time" value={start} />
      <input type="hidden" name="hours" value={hours} />
      <input type="hidden" name="ot_mode" value={otMode} /><input type="hidden" name="ot_after_hours" value={otAfter} />
      <input type="hidden" name="ot_multiplier" value={otMult} /><input type="hidden" name="allow_offers" value={allowOffers ? "1" : "0"} />

      <Field label="Which site?">
        <select name="project_id" defaultValue={projectId} className="input">{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </Field>

      {crew.length > 0 && (
        <Field label="Who?" hint={finding ? "We find workers near the site who are free that day." : "Goes straight to their phone. Nobody else is asked."}>
          <div className="flex flex-wrap gap-2">
            <Chip on={finding} onClick={() => setWho("new")}>Find new workers</Chip>
            {crew.map((c) => <Chip key={c.id} on={who === c.id} onClick={() => { setWho(c.id); if (c.rate) setRate(c.rate); }}>{c.name.split(" ")[0]}</Chip>)}
          </div>
        </Field>
      )}

      <Field label="Which day?">
        <div className="grid grid-cols-3 gap-2">
          {days.map((d) => <Chip key={d.v} on={day === d.v && !pick} onClick={() => { setDay(d.v); setPick(false); }}>{d.l}</Chip>)}
        </div>
        {pick ? <input type="date" value={day} min={days[0].v} onChange={(e) => setDay(e.target.value)} className="input mt-2" aria-label="Another day" />
              : <button type="button" className="text-steel underline text-base mt-2" onClick={() => setPick(true)}>Another day</button>}
      </Field>

      <Field label="Start time">
        <div className="grid grid-cols-3 gap-2">{STARTS.map((t) => <Chip key={t} on={start === t} onClick={() => setStart(t)}>{say(t)}</Chip>)}</div>
      </Field>

      <Field label="How many hours?">
        <div className="grid grid-cols-4 gap-2">{HOURS.map((h) => <Chip key={h} on={hours === h} onClick={() => setHours(h)}>{h}h</Chip>)}</div>
      </Field>

      {finding ? (
        <Field label="Who do you need?" hint={`Everyone needs a White Card. That's automatic. Lowest pay allowed is $${AWARD_CASUAL_FLOOR.toFixed(2)} an hour (the Award, casual). Super 12% is on top.`}>
          <div className="space-y-3">
            {lines.map((l, i) => (
              <div key={l.key} className="card space-y-3">
                <input type="hidden" name="line_spots" value={l.spots} />
                {l.tix.map((t) => <input key={t} type="hidden" name={`line_tickets_${i}`} value={t} />)}

                <select name="line_role" value={l.role} onChange={(e) => edit(l.key, { role: e.target.value })} className="input" aria-label="Doing what?">
                  {ROLES.map((x) => <option key={x}>{x}</option>)}
                </select>

                <div className="flex items-center justify-between gap-3">
                  <div className="text-base font-bold">How many?</div>
                  <div className="flex items-center gap-2">
                    <button type="button" className="btn-ghost w-14 px-0" aria-label="One fewer" onClick={() => edit(l.key, { spots: Math.max(1, l.spots - 1) })}>
                      <Minus size={24} strokeWidth={2.5} aria-hidden />
                    </button>
                    <div className="text-4xl font-extrabold w-12 text-center num">{l.spots}</div>
                    <button type="button" className="btn-ghost w-14 px-0" aria-label="One more" onClick={() => edit(l.key, { spots: Math.min(MAX_SPOTS, l.spots + 1) })}>
                      <Plus size={24} strokeWidth={2.5} aria-hidden />
                    </button>
                  </div>
                </div>

                {!l.needLic && l.tix.length === 0 ? (
                  <button type="button" className="text-steel underline text-base text-left" onClick={() => edit(l.key, { needLic: true })}>Needs a licence? (forklift, EWP, dogging, scaffold)</button>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(TICKETS).filter(([k]) => k !== "WC").map(([k, v]) => (
                      <Chip key={k} className="w-full text-sm" on={l.tix.includes(k)} onClick={() => edit(l.key, { tix: l.tix.includes(k) ? l.tix.filter((t) => t !== k) : [...l.tix, k] })}>{v}</Chip>
                    ))}
                  </div>
                )}

                <div>
                  <div className="text-base font-bold mb-1.5">Pay per hour</div>
                  <div className="flex items-center gap-2">
                    <span className="text-3xl font-extrabold">$</span>
                    <input type="number" name="line_rate" step="0.05" min={AWARD_CASUAL_FLOOR} value={l.rate} onChange={(e) => edit(l.key, { rate: Number(e.target.value) })}
                      className="input text-3xl font-extrabold num w-40 text-center" aria-label={`Pay per hour for ${l.role}`} />
                    <span className="text-lg text-steel">an hour</span>
                  </div>
                  {l.rate < AWARD_CASUAL_FLOOR && <div className="text-warn font-semibold mt-1">Too low — it'll go out at ${AWARD_CASUAL_FLOOR.toFixed(2)}.</div>}
                </div>

                {lines.length > 1 && (
                  <button type="button" className="btn-ghost btn-sm w-full text-warn" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>Remove {l.spots} × {l.role}</button>
                )}
              </div>
            ))}
            {lines.length < MAX_LINES
              ? <button type="button" className="btn-ghost" onClick={addLine}><Plus size={20} strokeWidth={2.5} aria-hidden />Add another kind of worker</button>
              : <div className="text-sm text-steel">That's {MAX_LINES} kinds of worker, the most for one job. Post another job for more.</div>}
          </div>
        </Field>
      ) : (
        <>
          <input type="hidden" name="spots" value={1} />
          {tix.map((t) => <input key={t} type="hidden" name="tickets" value={t} />)}
          <Field label="Doing what?" hint="Everyone needs a White Card. That's automatic.">
            <select name="role" className="input">{ROLES.map((x) => <option key={x}>{x}</option>)}</select>
            {!needLic ? <button type="button" className="text-steel underline text-base mt-2" onClick={() => setNeedLic(true)}>Needs a licence? (forklift, EWP, dogging, scaffold)</button> : (
              <div className="grid grid-cols-2 gap-2 mt-2">
                {Object.entries(TICKETS).filter(([k]) => k !== "WC").map(([k, v]) => (
                  <Chip key={k} className="w-full text-sm" on={tix.includes(k)} onClick={() => setTix(tix.includes(k) ? tix.filter((t) => t !== k) : [...tix, k])}>{v}</Chip>
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
        </>
      )}

      {/* Overtime is settled up front, but most posts keep the default — so it's one line until you want it. */}
      {!otOpen ? (
        <button type="button" onClick={() => setOtOpen(true)} aria-expanded={false}
          className="card w-full flex items-center gap-3 text-left">
          <Timer size={20} strokeWidth={2.25} aria-hidden className="shrink-0 text-steel" />
          <span className="flex-1 font-bold leading-tight">Overtime: {otShort}</span>
          <span className="text-steel underline shrink-0">Change</span>
        </button>
      ) : (
        <Field label="Overtime — settle it now, not on payday"
               hint="The worker sees this before he takes the shift. Agreeing it up front is what stops the argument on Friday.">
          <div className="space-y-2">
            {([["award", "Award overtime", "1.5× for two hours after 8, then 2×. The safe default."],
               ["flat", "Same rate all day", "Every hour at the posted rate. Only legal if it beats the Award."],
               ["custom", "My own deal", "Pick when overtime starts and what it pays."]] as const).map(([v, title, why]) => (
              <button key={v} type="button" onClick={() => setOtMode(v)} aria-pressed={otMode === v}
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
            <b>Worker will see:</b> {otWords}
            {otMode !== "award" && <div className="text-steel mt-0.5">We still top it up to the Award if the Award works out higher. You can pay more than the Award, never less.</div>}
          </div>
          <button type="button" className="btn-ghost btn-sm w-full mt-2" onClick={() => setOtOpen(false)}>Done with overtime</button>
        </Field>
      )}

      <Field label="Can workers ask for a different deal?" hint="Turn this off when you just need bodies at 6am and the rate is the rate.">
        <div className="seg grid-cols-2">
          <button type="button" onClick={() => setAllowOffers(true)} className={`seg-item ${allowOffers ? "seg-on" : ""}`}>Yes, let them ask</button>
          <button type="button" onClick={() => setAllowOffers(false)} className={`seg-item ${!allowOffers ? "seg-on" : ""}`}>No, fixed rate</button>
        </div>
      </Field>

      <Field label="One line for the crew (optional)"><input name="note" className="input" placeholder="Steel caps. Park on Smith St." maxLength={120} /></Field>

      {/* What it costs and the button to post it, in sight the whole way down the form. Sits above the tab bar. */}
      <div className="stickybar fixed inset-x-0 z-30 bg-white border-t-2 border-line" style={{ bottom: "calc(66px + env(safe-area-inset-bottom))" }}>
        <div className="max-w-md mx-auto px-4 py-3 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xl font-extrabold num leading-tight">
              ≈ ${Math.round(cost).toLocaleString("en-AU")}<span className="text-base font-semibold text-steel"> for the day</span>
            </div>
            <div className="text-sm text-steel leading-tight mt-0.5">{summary}</div>
          </div>
          <button className="btn-primary w-auto shrink-0 px-5">{finding ? "Find workers" : "Send it"}</button>
        </div>
      </div>
    </form>
  );
}
function Chip({ on, onClick, children, className = "" }: { on: boolean; onClick: () => void; children: React.ReactNode; className?: string }) {
  return <button type="button" onClick={onClick} aria-pressed={on} className={`chip justify-center ${on ? "chip-on" : ""} ${className}`}>{children}</button>;
}
