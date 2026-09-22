"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, CircleAlert, CloudRain, Minus, Plus, TriangleAlert } from "lucide-react";
import { money, round2 } from "@/lib/award";
import { payForShift, type OtTerms } from "@/lib/rules";
import { approveMany } from "@/actions/boss";
import { Avatar, Cell } from "./ui";
import { ConfirmSheet } from "./ConfirmSheet";

/**
 * Every hour waiting on a yes, with a thumb on each number and one button that settles the lot.
 *
 * WHY THE BROWSER PRICES THE SHIFT. The figure on the hero moves as the steppers move, so something has to
 * do the arithmetic between taps, and the only arithmetic allowed here is payForShift() — the same function
 * actions/boss.ts approveMany calls before it writes the worker's notification. That is why each line
 * carries its shift's `terms` rather than a dollars-per-hour: `rate * hours` on this screen would quietly
 * drop every overtime hour out of the biggest number on it, and the boss would find out on the payslip.
 * lib/rules.ts is pure — it imports lib/award and nothing else — so shipping it to the phone costs a few
 * hundred bytes and buys one pay engine instead of two.
 *
 * WHY BOTH COMPONENTS LIVE IN ONE FILE. The hero figure and the rows are one piece of state: "about to
 * approve $1,412.40" is the sum of the steppers, and the confirm sheet has to list what those steppers say
 * at the moment it opens. Splitting them means a context or a second copy of the hours, and a second copy
 * of the hours on the screen that settles what people get paid is exactly the bug worth avoiding.
 *
 * WHAT IS ORANGE. One cell: the queue. Rained off is `.cell-warns` because it is nobody's fault, an
 * approved row is `.cell-gos` because it is done, and the $2 note is white. The moment the last row is
 * approved the queue cell turns green, because orange means "this needs you, now" and by then nothing does.
 */

export type ApproveLine = {
  bookingId: string;
  workerId: string;
  name: string;
  photo: string | null;
  site: string;
  /** "Rosehill · Thu 18 Sep · 6:30am (Perth time)" — built on the server, on the site's own clock. */
  where: string;
  /** What the worker recorded. Said out loud only once the boss has moved off it. */
  worked: number;
  /** Where the stepper starts: the weather suggestion on a rained-off day, otherwise what they recorded. */
  hours: number;
  rate: number;
  /** This shift's agreed overtime terms. The only thing the browser is allowed to price with. */
  terms: OtTerms;
  waitingHours: number | null;
  /** "19 h", "3 days". */
  waitingWords: string;
  /** True on the one line per worker that actually bills the $2 — lib/approveQueue's billOnlyOnce(). */
  unbilledIntroduction: boolean;
  weatherStop: string | null;
  /** weatherSuggestion()'s own sentence: why this row is pre-filled at something other than what they recorded. */
  weatherWhy: string | null;
  /** "Rained out — hail from 10am". Rides along with the approval so the worker's message explains itself. */
  payReason: string | null;
  /** Set on the first line of each rained-off shift: the words for the `.cell-warns` cell above its rows. */
  rainNote: string | null;
};

export type ApproveDay = { day: string; heading: string; lines: ApproveLine[] };

export type RowState = "waiting" | "saving" | "done" | "failed";

const first = (name: string) => name.split(" ")[0] || name;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const hoursWords = (h: number) => `${h} ${h === 1 ? "hour" : "hours"}`;

/**
 * The stepper's step, and why a typed number is snapped to it.
 *
 * The box can be typed into as well as tapped either side of, and half an hour is the granularity every
 * rate in the app is agreed at. 7.3 typed by a thumb on a phone is a slip rather than a decision, so it
 * becomes 7.5 — and the hours approved are always a number the worker can check against their own day.
 */
const STEP = 0.5;
const snap = (h: number) => Math.round(h / STEP) * STEP;

/**
 * One booking, one thumb. 2-wide, white, `.cell-gos` once it is approved.
 *
 * The control line is the point of the screen: 56x56 either side of the number and a 56-tall Approve,
 * because the boss does this standing on a slab, one-handed, and a mis-tap is the difference between what
 * someone worked and what they get paid. Nothing here is under the 44px floor, and nothing changes size
 * between states — the Approve button keeps its label while it saves, because a button that changes width
 * under a moving thumb is how the next row gets pressed by accident.
 */
export function ApproveRow({ line, hours, state, msg, max, onHours, onApprove }: {
  line: ApproveLine;
  hours: number;
  state: RowState;
  msg?: string;
  max: number;
  onHours: (h: number) => void;
  onApprove: () => void;
}) {
  const who = first(line.name);
  const pay = payForShift(hours, line.rate, line.terms);
  const busy = state === "saving" || state === "done";
  const edited = hours !== line.worked;

  return (
    <Cell span={2} tone={state === "done" ? "gos" : "white"}>
      <div className="flex items-center gap-3 min-w-0">
        <Avatar name={line.name} photo={line.photo} size={40} />
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-extrabold leading-tight truncate">{who}</div>
          <div className="text-[15px] leading-[1.25] font-medium text-steel truncate">{line.where}</div>
        </div>
        <div className="shrink-0 text-right">
          {/* 15px, and it is payForShift's gross — never the stepper times the rate. */}
          <div className="text-[15px] leading-[1.25] font-extrabold num">{money(pay.gross)}</div>
          {state !== "done" && line.waitingWords && (
            <div className="text-[15px] leading-[1.25] font-medium text-steel num">waiting {line.waitingWords}</div>
          )}
        </div>
      </div>

      {state === "done" ? (
        <div className="flex items-center gap-2 text-[16px] font-bold leading-tight">
          <Check size={20} strokeWidth={2.5} aria-hidden className="shrink-0" />
          <span className="num">Approved · {hoursWords(hours)} · {money(pay.gross)}</span>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <button type="button" className="step shrink-0 disabled:opacity-40" disabled={busy}
              onClick={() => onHours(Math.max(0, snap(hours - STEP)))}
              aria-label={`Half an hour less for ${who}`}>
              <Minus size={22} strokeWidth={3} aria-hidden />
            </button>
            <input type="number" inputMode="decimal" step={STEP} min={0} max={max} value={String(hours)}
              disabled={busy}
              onChange={(e) => onHours(Math.min(max, Math.max(0, snap(Number(e.target.value) || 0))))}
              className="input num flex-1 min-w-0 px-0 text-center text-[34px] font-extrabold disabled:opacity-40"
              aria-label={`Hours to approve for ${line.name}`} />
            <button type="button" className="step shrink-0 disabled:opacity-40" disabled={busy}
              onClick={() => onHours(Math.min(max, snap(hours + STEP)))}
              aria-label={`Half an hour more for ${who}`}>
              <Plus size={22} strokeWidth={3} aria-hidden />
            </button>
            <button type="button" onClick={onApprove} disabled={busy}
              className="shrink-0 rounded-xl bg-ink text-white font-bold text-[16px] px-3 min-h-[56px] active:scale-[0.98] transition disabled:opacity-40">
              Approve
            </button>
          </div>

          <div className="text-[15px] leading-[1.25] font-medium text-steel">
            {/* The terms as payForShift words them at THIS number, so the split re-reads itself as the
                stepper moves. A sentence describing eight hours sitting under a stepper showing four is
                worse than no sentence at all. */}
            <span className="num">{pay.words}</span>
            {edited && <span className="num"> · they recorded {hoursWords(line.worked)}</span>}
            {line.weatherWhy && <> · {line.weatherWhy}</>}
          </div>
        </>
      )}

      {state === "saving" && <div className="text-[15px] font-bold leading-[1.25]">Approving…</div>}

      {/* Loud, and the stepper keeps the number the boss left in it. These hours are never queued to send
          later: an approval that silently never went is a worse pay dispute than the one this screen ends. */}
      {state === "failed" && (
        <div className="flex items-start gap-2 text-[15px] leading-[1.25] font-bold text-warn">
          <TriangleAlert size={18} strokeWidth={2.5} aria-hidden className="shrink-0 mt-0.5" />
          <span>{msg ?? "That didn't go through. Nothing was approved — try again."}</span>
        </div>
      )}
    </Cell>
  );
}

/**
 * The fee as a number, read back out of the words the server sent.
 *
 * The screen is handed "$2" rather than 200 cents on purpose — lib/subscription counts in cents and
 * `money()` here takes dollars, and confusing the two shipped a $3,300 charge for a $33 one (commit
 * 8f912ee). So nothing here multiplies cents: the dollars are parsed back out of the one string the server
 * formatted, and there is no second copy of the price anywhere on this screen.
 */
const fee = (words: string) => Number(words.replace(/[^0-9.]/g, "")) || 0;

/** "Sam's and Tui's hours", "Sam's, Tui's and Jo's hours" — the workers the $2 is actually for. */
function names(list: ApproveLine[]): string {
  const who = list.map((l) => `${first(l.name)}'s`);
  const last = who.pop()!;
  return `${who.join(", ")} and ${last} hours`;
}

/** The queue: the 2x2 that adds it all up, the rows under their days, the rained-off notes and the $2. */
export function ApproveBoard({ days: served, max, feeWords }: {
  days: ApproveDay[];
  /** lib/approveQueue's MAX_APPROVE_HOURS, handed down rather than spelled a second time here. */
  max: number;
  /** "$2" — priceWords(matchFeeCents()) read on the server, so a price change never leaves this screen lying. */
  feeWords: string;
}) {
  /*
   * Read once, deliberately.
   *
   * approveMany revalidates /boss/approve, so a moment after a row is approved the server hands this
   * component a queue with that row MISSING. Following the new props would blank the row the instant the
   * boss pressed it: a shorter list and no confirmation that the thing he just did happened. So the rows
   * stay put and turn green, and fresh data is picked up the next time the screen is opened. The cost is
   * that a worker who clocks out while this page is open does not appear until then — a row appearing
   * under a moving thumb, on a screen where the row above is a payment, is the worse of the two.
   */
  const [days] = useState(served);
  const lines = days.flatMap((d) => d.lines);

  const [hours, setHours] = useState<Record<string, number>>(
    () => Object.fromEntries(lines.map((l) => [l.bookingId, l.hours])));
  const [rows, setRows] = useState<Record<string, { state: RowState; msg?: string }>>({});
  const [ask, setAsk] = useState(false);
  const [, start] = useTransition();

  const at = (l: ApproveLine) => hours[l.bookingId] ?? l.hours;
  const stateOf = (l: ApproveLine): RowState => rows[l.bookingId]?.state ?? "waiting";
  const grossOf = (l: ApproveLine) => payForShift(at(l), l.rate, l.terms).gross;

  const left = lines.filter((l) => stateOf(l) !== "done");
  const busy = lines.some((l) => stateOf(l) === "saving");

  // Everything the hero says, recomputed on every tap of a stepper. `billing` mirrors approveMany's own
  // guard — the $2 is billed by an approval of more than zero hours — so a rained-off row stepped down to 0
  // costs nothing and must not be counted. A sheet that promises $2 and invoices $6 ends the pricing story
  // this whole product is sold on.
  const totalHours = round2(left.reduce((a, l) => a + at(l), 0));
  const totalDollars = round2(left.reduce((a, l) => a + grossOf(l), 0));
  const workers = new Set(left.map((l) => l.workerId)).size;
  const sites = new Set(left.map((l) => l.site)).size;
  const billing = left.filter((l) => l.unbilledIntroduction && at(l) > 0);
  const introDollars = round2(billing.length * fee(feeWords));
  const oldest = left.reduce<ApproveLine | null>(
    (w, l) => (l.waitingHours != null && (!w || l.waitingHours > (w.waitingHours ?? 0)) ? l : w), null);

  const mark = (list: ApproveLine[], row: { state: RowState; msg?: string }) =>
    setRows((prev) => ({ ...prev, ...Object.fromEntries(list.map((l) => [l.bookingId, row])) }));

  /**
   * Send them. The hours go exactly as the steppers read, with the rained-off reason attached, so the
   * message the worker gets says the same thing whether six people were approved in one tap or one at a
   * time. A booking approveMany reports as skipped was won by another tab, and its row says so out loud
   * rather than sitting there looking approved.
   */
  const send = (list: ApproveLine[]) => {
    if (!list.length) return;
    const items = list.map((l) => ({ bookingId: l.bookingId, hours: at(l), reason: l.payReason }));
    mark(list, { state: "saving" });
    start(async () => {
      try {
        const r = await approveMany(items);
        const missed = new Set(r.skipped);
        setRows((prev) => ({
          ...prev,
          ...Object.fromEntries(list.map((l) => [l.bookingId, missed.has(l.bookingId)
            ? { state: "failed" as const, msg: "This one changed while you were looking — open the job to see where it landed." }
            : { state: "done" as const }])),
        }));
      } catch {
        // approveMany runs in one transaction: if it threw, nothing was written. Every row goes back with
        // its number intact, rather than half the list claiming to have been paid.
        mark(list, { state: "failed", msg: "That didn't go through. Nothing was approved — try again." });
      }
    });
  };

  return (
    <>
      <div className="bento">
        {left.length === 0 ? (
          <Cell span={2} rows={2} tone="go">
            <div className="min-w-0">
              <div className="c-label flex items-start gap-2">
                <Check size={24} strokeWidth={2.5} aria-hidden className="shrink-0" />
                <span className="min-w-0">That is everyone</span>
              </div>
              <div className="c-sub">Nothing is waiting on you. They can see their hours now.</div>
            </div>
          </Cell>
        ) : (
          <Cell span={2} rows={2} tone="needs">
            <div className="min-w-0">
              <div className="c-label flex items-start gap-2">
                <CircleAlert size={24} strokeWidth={2.5} aria-hidden className="shrink-0" />
                <span className="min-w-0">About to approve</span>
              </div>
              <div className="mt-1 flex items-baseline gap-2 min-w-0">
                <span className="c-fig-2 shrink-0">{totalHours.toFixed(1)}<span className="c-unit"> h</span></span>
                <span className="c-fig-2 opacity-40 shrink-0" aria-hidden>·</span>
                <span className="c-fig truncate">{money(totalDollars)}</span>
              </div>
              <div className="c-sub line-clamp-2">
                {plural(workers, "worker")}, {plural(sites, "site")}
                {oldest ? `, oldest waiting ${oldest.waitingWords}` : ""}
              </div>
            </div>
            <div className="cell-bar">
              <button type="button" className="cell-act disabled:opacity-40" disabled={busy}
                onClick={() => setAsk(true)}>
                {busy ? "Approving…" : "Approve all at the hours we agreed"}
              </button>
              {/* Not a reset — the way out. Nothing on this screen is written until a button says it is. */}
              <Link href="/boss" className="cell-act-ghost">Not yet</Link>
            </div>
          </Cell>
        )}
      </div>

      {days.map((d) => (
        <div key={d.day} className="space-y-2">
          <h2 className="text-[20px] font-extrabold leading-tight">{d.heading}</h2>
          <div className="bento">
            {d.lines.map((l) => (
              // `contents` so the rain note and its rows stay direct children of the grid: a wrapper with a
              // box of its own would break the 2-wide span and put a white gutter down the middle of the day.
              <div key={l.bookingId} className="contents">
                {/* Above its own shift's rows, not at the foot of the screen. It is the reason those
                    steppers are pre-filled at something other than what the worker recorded, and a reason
                    eleven rows below the thing it explains is a reason nobody reads. */}
                {l.rainNote && (
                  <Cell span={2} tone="warns" icon={l.weatherStop === "rain" ? CloudRain : TriangleAlert}
                    label={l.rainNote}
                    sub="They turned up and got sent home. Rained off never counts as a no-show. We have put in the hours each of them is usually owed — change any of them." />
                )}
                <ApproveRow line={l} max={max} hours={at(l)} state={stateOf(l)} msg={rows[l.bookingId]?.msg}
                  onHours={(h) => setHours((prev) => ({ ...prev, [l.bookingId]: h }))}
                  onApprove={() => send([l])} />
              </div>
            ))}
          </div>
        </div>
      ))}

      {/*
       * The whole pricing story, said where it is incurred, and said in ONE place. It replaced a 14px grey
       * line under the single-worker Approve button (components/IntroFeeNote.tsx, now deleted): this is the
       * only charge OnSite makes, and two screens telling the same pricing story is how the two of them
       * come to disagree. Named workers only: someone already billed is not an introduction a
       * second time, and a row stepped to 0 hours bills nothing, so both drop out of this sentence the
       * moment they stop being true.
       */}
      {billing.length > 0 && (
        <div className="bento">
          <Cell span={2}
            label={billing.length === 1
              ? `Approving ${first(billing[0].name)}'s hours introduces you — ${feeWords}, once, ever.`
              : `Approving ${names(billing)} introduces you — ${feeWords} each, ${money(introDollars)} in total, once, ever.`}
            sub={<span className="c-prose">Invoiced every 14 days. Nothing else.</span>} />
        </div>
      )}

      <ConfirmSheet open={ask} onClose={() => setAsk(false)} danger={false} icon={null}
        title={`Approve ${plural(left.length, "lot")} of hours?`}
        msg={`${totalHours.toFixed(1)} hours, ${money(totalDollars)}${billing.length ? `, and ${money(introDollars)} in introductions` : ""}.`}
        details={left.flatMap((l) => {
          const said = [`${first(l.name)} — ${hoursWords(at(l))} — ${money(grossOf(l))}`];
          // On its own line, under the worker it belongs to, in the order approveMany performs them.
          if (l.unbilledIntroduction && at(l) > 0) said.push(`${feeWords} — first time with ${first(l.name)}`);
          return said;
        })}
        confirmLabel="Approve them all" cancelLabel="Not yet"
        onConfirm={() => send(left)} />
    </>
  );
}
