import { money } from "@/lib/award";
import { SMALL_N } from "@/lib/profileStats";

/**
 * The small marks that go inside a cell — the chart half of the bento.
 *
 * Every one of them is drawn on the server out of plain SVG and CSS boxes, the same way
 * components/Heatmap.tsx and components/MonthBars.tsx already draw. No chart library, no script: a site
 * phone on 3G in a lunch shed should not download 90kB of plotting code to show four dots.
 *
 * One device, ink at four opacities, and it always encodes an *amount*. Never a category — which is why
 * SiteBars below is five labelled rows rather than one stacked bar. Stacked, Marrickville would be drawn
 * at 0.30 and Zetland at 0.92 and the eye would read Zetland as three times the money, when the only
 * difference between them is which suburb they are. Orange appears in none of these: orange means "this
 * needs you, now", and a chart is never a job to do.
 *
 * The ink is `currentColor`, not a hex, so a mark that lands on `.cell-ink` comes out white on black with
 * no second code path — the trick the heatmap already uses.
 *
 * Small numbers are drawn honestly or not drawn. A 3-of-4 arc *is* the 75% claim whatever the caption
 * says, so under SMALL_N there is no arc: `Pips` draws one dot per actual sample, and `RangeBar` refuses
 * and lists the raw figures instead.
 *
 * These are server components. SMALL_N comes from lib/profileStats, which opens lib/db's pool behind it,
 * so this file must never be imported from a "use client" component. Nothing in here has an interaction,
 * so that should never come up — and the alternative, a second copy of the number 5, is how the app ended
 * up calling the same clock-in "on time" on one screen and "late" on the other.
 */

/** The heatmap's four steps, as inline style, so a CSS box uses the identical device an SVG rect does. */
const INK = { empty: 0.16, light: 0.3, mid: 0.6, full: 0.92 } as const;
const ink = (step: keyof typeof INK) => ({ background: "currentColor", opacity: INK[step] });

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ────────────────────────────────────────────────────────────────────────── pips

/**
 * One dot per actual sample: the honest mark when there are too few of anything to talk in percentages.
 *
 * `max` caps the row and the remainder is carried as "+16" rather than by shrinking the dots, because the
 * promise of this mark is that you can count it. Above the cap the filled dots are drawn first, so "40 of
 * 46" reads as a solid row and never as a near-empty one.
 */
export function Pips({ n, of, max = 30, sr, className = "" }: {
  n: number; of: number; max?: number; sr?: string; className?: string;
}) {
  const total = Math.max(0, Math.round(of));
  const done = Math.min(Math.max(0, Math.round(n)), total);
  if (total === 0) {
    return (
      <div className={className}>
        <span className="c-sub">—</span>
        <p className="sr-only">{sr ?? "Nothing on the record yet."}</p>
      </div>
    );
  }
  const shown = Math.min(total, max);
  const filled = Math.min(done, shown);
  const over = total - shown;
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-[3px]" aria-hidden>
        {Array.from({ length: shown }, (_, i) => (
          <span key={i} className="rounded-full" style={{ width: 10, height: 10, ...ink(i < filled ? "full" : "empty") }} />
        ))}
        {over > 0 && <span className="text-[15px] font-bold num ml-1">+{over}</span>}
      </div>
      <p className="sr-only num">{sr ?? `${done} of ${total}.`}</p>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────── the money bar

/**
 * States, not categories — which is the entire reason this bar is allowed to be one bar.
 *
 * `paid` is the app's green, because paid is done and green still reads when it is drawn on ink. The
 * other two are currentColor, so on the worker's ink money cell "waiting on payment" comes out white on
 * black and "not approved yet" comes out a dim white, instead of an ink segment vanishing into an ink cell.
 */
export type SegmentTone = "paid" | "owed" | "unapproved";
const SEG: Record<SegmentTone, { cls: string; style?: React.CSSProperties }> = {
  paid: { cls: "bg-go" },
  owed: { cls: "", style: ink("full") },
  unapproved: { cls: "", style: ink("light") },
};

/**
 * `dollars`, not cents.
 *
 * [DEVIATION] The spec writes this prop as `cents`, but every number that feeds this bar comes out of
 * `payForShift().gross`, which is dollars, and `money()` in lib/award takes dollars. A prop named `cents`
 * holding a dollars figure is the 100x bug that shipped a $3,300 subscription (commit 8f912ee), with a
 * label on it. Cents live in lib/subscription and print through `moneyCents`; nothing on this bar does.
 */
export type Segment = { label: string; dollars: number; tone: SegmentTone };

/**
 * A money bar in three states, each one named in words underneath with its own figure. The words are not
 * a caption on the colour — they are the message, and the bar is the shape of it.
 *
 * Widths are flex-grow rather than percentages so the browser divides the bar exactly and there is never
 * a rounding seam at the end. A segment worth $12 out of $4,000 would be a third of a pixel, so anything
 * above zero is floored at 3px: present, with its real figure underneath.
 */
export function SegmentBar({ segments, sr, className = "" }: {
  segments: Segment[]; sr?: string; className?: string;
}) {
  const total = segments.reduce((t, s) => t + Math.max(0, s.dollars), 0);
  const said = segments.filter((s) => s.dollars > 0);
  return (
    <div className={className}>
      <div className="flex h-3.5 rounded-full overflow-hidden" aria-hidden>
        {total > 0
          ? segments.map((s) => (
            <span key={s.label} className={SEG[s.tone].cls}
              style={{ flexGrow: Math.max(0, s.dollars), flexBasis: 0, minWidth: s.dollars > 0 ? 3 : 0, ...SEG[s.tone].style }} />
          ))
          : <span className="w-full" style={ink("empty")} />}
      </div>
      <ul className="mt-2 space-y-0.5">
        {said.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-[15px] leading-[1.25] font-medium">
            {/* Drawn exactly as the segment above it. If the two ever drift, the key stops being a key. */}
            <span className={`shrink-0 rounded-[3px] ${SEG[s.tone].cls}`.trim()}
              style={{ width: 10, height: 10, ...SEG[s.tone].style }} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            <span className="shrink-0 num font-bold">{money(s.dollars)}</span>
          </li>
        ))}
      </ul>
      <p className="sr-only num">
        {sr ?? `${money(total)} in total. ${segments.map((s) => `${s.label}: ${money(s.dollars)}`).join(". ")}.`}
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── labelled rows

/**
 * Money by site, as labelled rows. Deliberately not a stacked bar: opacity is an amount here, and a site
 * is not an amount, so each site gets its own row with its name and its figure spelled out.
 *
 * Bars are scaled to the biggest row, the way MonthBars scales to its best month, so the shape answers
 * "which site is eating the fortnight" and the figures answer "how much". There is no track behind them —
 * an empty track invites the eye to read each bar as a share of a total it is not a share of. A single
 * row draws no bar at all: one full-width bar is a comparison with nothing.
 *
 * The rows are sorted here rather than trusted from the caller, because "and 2 more" has to be the two
 * smallest. `dollars` for the same reason as SegmentBar: lib/award's `money()` takes dollars.
 */
export function SiteBars({ rows, max = 5, sr, className = "" }: {
  rows: { name: string; dollars: number }[]; max?: number; sr?: string; className?: string;
}) {
  const sorted = [...rows].sort((a, b) => b.dollars - a.dollars);
  const shown = sorted.slice(0, max);
  const rest = sorted.slice(max);
  const restTotal = rest.reduce((t, r) => t + r.dollars, 0);
  const peak = Math.max(...sorted.map((r) => r.dollars), 1);
  const alone = sorted.length === 1;
  return (
    <div className={className}>
      <ul className="space-y-1">
        {shown.map((r) => (
          <li key={r.name} className="flex items-center gap-2 text-[15px] leading-[1.25] font-medium">
            <span className="truncate shrink-0" style={{ flexBasis: "38%" }}>{r.name}</span>
            {!alone && (
              <span className="flex-1 min-w-0" aria-hidden>
                <span className="block h-2.5 rounded-full"
                  style={{ width: `${Math.max(2, Math.round((r.dollars / peak) * 100))}%`, ...ink("mid") }} />
              </span>
            )}
            <span className={`shrink-0 num font-bold ${alone ? "ml-auto" : ""}`.trim()}>{money(r.dollars)}</span>
          </li>
        ))}
        {rest.length > 0 && (
          <li className="c-sub c-prose num">and {plural(rest.length, "more site", "more sites")}, {money(restTotal)}</li>
        )}
      </ul>
      <p className="sr-only num">{sr ?? `${sorted.map((r) => `${r.name}: ${money(r.dollars)}`).join(". ")}.`}</p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────── how long

/**
 * How long something has been waiting, 100x8. The shade steps up as it goes — light, then mid, then full
 * ink once it is past the threshold — so a row that has gone bad is darker than one that has not.
 *
 * Ink, never orange, even past the threshold. Orange belongs to the cell around it, and that is the thing
 * with a budget of one per screen; if every ageing bar in a list of three bosses went orange, the screen
 * would hold three "this needs you, now" and none of them would mean it.
 */
export function AgeBar({ days, threshold, sr, className = "" }: {
  days: number; threshold: number; sr?: string; className?: string;
}) {
  const th = threshold > 0 ? threshold : 1;
  const frac = Math.min(1, Math.max(0, days / th));
  const step = days >= th ? "hm-3" : days >= th / 2 ? "hm-2" : "hm-1";
  const whole = Math.round(days);
  return (
    <span className={`inline-flex items-center ${className}`.trim()}>
      <svg width={100} height={8} viewBox="0 0 100 8" aria-hidden className="block">
        <rect x={0} y={0} width={100} height={8} rx={4} className="hm-0" />
        {frac > 0 && <rect x={0} y={0} width={Math.max(4, frac * 100)} height={8} rx={4} className={step} />}
      </svg>
      <span className="sr-only num">
        {sr ?? (whole === 0 ? "Waiting less than a day." : `Waiting ${plural(whole, "day", "days")}${days >= th ? `, past the ${th}-day mark.` : "."}`)}
      </span>
    </span>
  );
}

// ───────────────────────────────────────────────────────────────── you vs the market

/**
 * A rate against the range being paid around it. The Award floor is the left anchor, not a dotted line
 * inside the track: `clampRate()` makes $35.55 a hard minimum for every posted rate and every worker's
 * ask, so a floor line could only ever sit at or left of the edge and would never once fire. Anchored,
 * the whole bar reads as distance above the floor, which is the only informative version of it.
 *
 * Under SMALL_N nothing is drawn. Four accepted rates cannot carry a band and a median — the band would
 * be two numbers wide and the median would be one of them — so the four numbers are listed instead.
 *
 * The median tick is information and never advice. A cell using this must not phrase it as what to ask
 * for: quietly pulling every worker toward the middle is the worst thing this screen could do to them.
 */
export function RangeBar({ low, med, high, you, floor, n, samples, sr, className = "" }: {
  low: number; med: number; high: number; you: number; floor: number;
  n: number; samples?: number[]; sr?: string; className?: string;
}) {
  if (n < SMALL_N) {
    const list = [...(samples ?? [])].sort((a, b) => a - b).map(money);
    const words = n === 0 ? "No jobs like yours near you yet."
      : list.length ? `${plural(n, "job", "jobs")} near you: ${list.join(", ")}`
        : `Only ${plural(n, "job", "jobs")} near you — too few to draw a range.`;
    return (
      <div className={className}>
        <span className="c-sub num">{words}</span>
        <p className="sr-only num">{sr ?? words}</p>
      </div>
    );
  }
  const top = Math.max(high, you, floor + 1);
  const at = (v: number) => Math.min(100, Math.max(0, ((v - floor) / (top - floor)) * 100));
  return (
    <div className={className}>
      <div className="py-1.5" aria-hidden>
        <div className="relative h-3.5">
          <div className="absolute inset-0 rounded-full" style={ink("empty")} />
          <div className="absolute inset-y-0 rounded-full"
            style={{ left: `${at(low)}%`, width: `${Math.max(2, at(high) - at(low))}%`, ...ink("light") }} />
          <div className="absolute inset-y-0" style={{ left: `calc(${at(med)}% - 1px)`, width: 2, ...ink("mid") }} />
          {/* You, overhanging the track top and bottom, so the one mark that is yours is the one you find. */}
          <div className="absolute top-1/2 -translate-y-1/2 rounded-full"
            style={{ left: `calc(${at(you)}% - 2px)`, width: 4, height: 28, borderRadius: 2, background: "currentColor" }} />
        </div>
      </div>
      {/* 14px is the app's text floor and it applies to chart axis letters only — these two are the axis. */}
      <div className="flex justify-between gap-2 text-sm font-medium opacity-70 num" aria-hidden>
        <span>Award floor {money(floor)}</span><span>{money(top)}</span>
      </div>
      <p className="sr-only num">
        {sr ?? `You ask ${money(you)} an hour. ${plural(n, "job", "jobs")} like yours near you were paid ${money(low)} to ${money(high)}; half were above ${money(med)}.`}
      </p>
    </div>
  );
}
