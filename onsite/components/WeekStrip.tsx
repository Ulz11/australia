"use client";

import { useEffect, useRef, useState } from "react";

/**
 * THE FORTNIGHT, FOURTEEN COLUMNS WIDE — the strip at the top of /boss/week.
 *
 * ONE TAP, ONE THING. Pressing a column selects that day and does nothing else. app/worker/Calendar.tsx
 * learned this the expensive way: one tap there was `setSel(d)` AND `set(d, nextDayState(...))` on a cell
 * that computes to about 45px on a 375px phone, so a gloved mis-tap aimed at Thursday also flipped whether
 * every boss in radius could see that worker on Wednesday — silently, with nothing on screen to say it had
 * happened. A column in here is 48px at its narrowest and it selects. Posting a job is a separate button,
 * labelled with the day it will post for, under that day's own panel.
 *
 * FOURTEEN COLUMNS DO NOT FIT ON A PHONE, SO THE STRIP SCROLLS SIDEWAYS. 14 x 48px is 724px against the
 * 416px a max-w-md page has to give. The seven-column version of this strip solved a near-miss (seven
 * columns compute to 42.4px at 375, just under the floor) by dropping to a chart with no targets at all
 * below 390px. At fourteen there is no width where that arithmetic comes out, so the columns keep their
 * 48px and the row scrolls. Nothing in here is laid out under the touch floor and then excused.
 *
 * WHAT THE INK MEANS. The bar is the hole, and the three cases are ordered by ink AND by height, which
 * they were not before:
 *
 *   - a day that is short is a solid ink bar at .hm-3 (0.92, 14.8:1), at least 18px tall, scaled from
 *     there against the worst day in the window, with the number of spots printed under it;
 *   - a day with work on it and nothing short is a 5px hairline at .hm-2 (0.60, 4.77:1);
 *   - a day with no jobs at all is the faint 2px baseline at .hm-0 (0.16).
 *
 * The shade used to step with the shortfall — .hm-1 for a small hole, .hm-3 for the worst — while the
 * covered hairline was drawn at .hm-2. So a level-1 hole was painted at 0.30 (1.97:1, all but invisible
 * on a phone at half brightness) UNDER a covered day drawn at 0.60: the day with nothing wrong with it
 * was the more prominent mark. The shortfall is carried by height and by the printed figure now, and ink
 * carries only which of the three cases a column is.
 *
 * Blank has to keep meaning "nothing booked". A boss who cannot tell "covered" from "nothing booked" at
 * arm's length has been told nothing by fourteen columns, and the day he reads as covered is the day
 * nobody turns up to.
 *
 * ORANGE APPEARS NOWHERE IN HERE. Orange means "this needs you, now", there is one of it per screen, and
 * on /boss/week it is spent on the cell above this strip. Fourteen orange underlines would mean nothing.
 *
 * The panels arrive already rendered on the server and are picked by index, so selecting a day costs no
 * round trip — a boss checking Thursday in a lunch shed on 3G is not waiting on a fetch to find out
 * whether Thursday is covered.
 */

/** One column. Everything the strip draws, and not one thing more — no shift rows, no dollars, no clock. */
export type StripDay = {
  /** "2026-09-25". The site's day, off lib/weekGaps' statement — never what this browser thinks today is. */
  day: string;
  /** "Thu". The axis label, and the only 14px text in here. */
  short: string;
  /** "today", "tomorrow", "Thursday", "Thu 2 Oct" — how a boss says the day out loud. */
  when: string;
  isToday: boolean;
  /** Spots still to fill. This is what the bar is. */
  gap: number;
  /** Job lines on the day. Zero jobs and zero gap are different columns, which is the whole point. */
  jobs: number;
  /** The whole sentence for the column's aria-label. The pieces above are drawn; this one is spoken. */
  sr: string;
};

/**
 * The drawn height of a column's bar area, in both viewBox units and CSS pixels — they are 1:1 here.
 *
 * 80, not 56. The strip is this screen's hero and it is a full 2x2 now, so the bars get the room: a
 * fortnight's worth of holes drawn 56px tall under a heading was a chart being used as a caption. The
 * cell it sits in comes out around 214px, which is a 2x2 (188px) plus the extra the columns ask for —
 * .bento's rows are `minmax(88px, auto)` precisely so a tile may grow and never shrink.
 */
const BAR_H = 80;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function WeekStrip({ days, panels, worstGap, initial = 0 }: {
  days: StripDay[];
  /** Index-aligned with `days`: server-rendered nodes, one per day, handed in whole. */
  panels: React.ReactNode[];
  /** The biggest hole in the window — bar heights are a share of it, never of an absolute scale. */
  worstGap: number;
  /**
   * Which day opens. The page passes the day with the biggest hole in it, because this screen exists to
   * get holes filled and opening on an empty Tuesday makes the boss do the finding twice. Today is always
   * marked and the panel heading names the day it is showing, so there is no guessing what is on screen.
   */
  initial?: number;
}) {
  const [sel, setSel] = useState(() => Math.min(Math.max(0, initial), Math.max(0, days.length - 1)));
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  // On mount only. After this the scroller belongs to the boss's thumb: re-centring it on every selection
  // would yank the strip out from under a finger that is mid-swipe looking for next Tuesday.
  useEffect(() => {
    tabs.current[sel]?.scrollIntoView({ inline: "center", block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Keyboard selection takes focus with it — a roving tabindex, so 14 columns are one tab stop, not 14. */
  const pick = (i: number) => {
    const n = Math.min(Math.max(0, i), days.length - 1);
    setSel(n);
    const el = tabs.current[n];
    el?.focus();
    el?.scrollIntoView({ inline: "nearest", block: "nearest" });
  };

  const onKey = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowRight": case "ArrowDown": pick(sel + 1); break;
      case "ArrowLeft": case "ArrowUp": pick(sel - 1); break;
      case "Home": pick(0); break;
      case "End": pick(days.length - 1); break;
      default: return;
    }
    e.preventDefault();
  };

  // After the hooks, never before them. The page draws its own empty state rather than an empty fortnight.
  if (days.length === 0) return null;
  const cur = days[Math.min(sel, days.length - 1)];
  const short = days.filter((d) => d.gap > 0);

  return (
    <section className="space-y-2">
      {/* A full 2x2, in the same grid every other tile on the screen is laid out in, so the strip is the
          hero rather than a wide card with a chart in it. The row floor is 88px and the ceiling is auto,
          so the columns take the height they need and the seam stays 12px either side. */}
      <div className="bento">
        <div className="cell b-w2 b-h2">
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <span className="c-label">The fortnight</span>
            {/* Which column is selected, in words. The ring says where; this says what it is called. */}
            <span className="text-[15px] leading-[1.25] font-bold shrink-0">{cur.when}</span>
          </div>

          {/* Bleeds to the cell's own edge and pads its contents back in, so the fourteenth column can be
              scrolled all the way over instead of sitting permanently half under the cell's padding. */}
          <div role="tablist" aria-label="The fortnight ahead, one column a day" onKeyDown={onKey}
            className="-mx-4 px-4 flex gap-1 overflow-x-auto overscroll-x-contain">
            {days.map((d, i) => {
              const on = i === sel;
              // Height is the hole against the worst hole; a covered day is a hairline and an empty day is a
              // baseline. See the file comment — the three cases have to be three different marks, and they
              // have to be ordered the same way by ink as they are by height.
              const h = d.gap > 0
                ? Math.max(18, Math.round((BAR_H - 6) * (d.gap / Math.max(1, worstGap))))
                : d.jobs > 0 ? 5 : 2;
              const shade = d.gap > 0 ? "hm-3" : d.jobs > 0 ? "hm-2" : "hm-0";
              return (
                <button key={d.day} type="button" role="tab" id={`wd-${d.day}`}
                  ref={(el) => { tabs.current[i] = el; }}
                  aria-selected={on} tabIndex={on ? 0 : -1}
                  aria-controls={on ? `wp-${d.day}` : undefined}
                  aria-label={d.sr}
                  onClick={() => setSel(i)}
                  // 1 0 48px: grows if there is ever room, never shrinks under the 48px floor, scrolls instead.
                  // The today tint is --fill-1, not `bg-site`: the canvas colour sitting on a white cell is
                  // a 1.1:1 ghost, so the column that was supposed to be marked was not marked at all.
                  style={{ flex: "1 0 48px", ...(d.isToday ? { background: "var(--fill-1)" } : null) }}
                  className={`rounded-xl px-1 pt-2 pb-1.5 flex flex-col items-center gap-1 ${on ? "ring-[3px] ring-ink ring-offset-1" : ""}`}>
                  {/* 14px is the app's text floor and it is for chart axis letters only. This is the axis.
                      0.70, not 0.55: ink at 0.55 on white measures 4.04:1 and axis letters are still text. */}
                  {/* Today's letters stay full ink. The tint behind the column measures 1.08:1 against the
                      cell and cannot be the only thing saying which of fourteen columns is today. */}
                  <span className={`text-[14px] font-bold leading-none ${d.isToday ? "" : "opacity-70"}`}
                    aria-hidden>{d.short}</span>
                  {/* A short day's date is full ink; every other day's steps back to the axis weight, so the
                      columns worth looking at are the dark ones all the way up. */}
                  <span className={`text-[17px] font-extrabold leading-none num ${d.gap > 0 ? "" : "opacity-70"}`}
                    aria-hidden>{Number(d.day.slice(8))}</span>
                  <svg viewBox={`0 0 48 ${BAR_H}`} height={BAR_H} preserveAspectRatio="none" aria-hidden
                    className="block w-full">
                    <rect x={0} y={BAR_H - h} width={48} height={h} rx={2} className={shade} />
                  </svg>
                  {/* A fixed-height line whether or not there is a figure in it, so fourteen columns keep one
                      baseline. A bar 48px wide is a coarse ruler; the number is what gets read off it. */}
                  <span className="text-[15px] font-extrabold leading-none num h-[18px]" aria-hidden>
                    {d.gap > 0 ? d.gap : ""}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Every short day, named, for someone who will never see the bars. */}
          <p className="sr-only">
            {short.length === 0
              ? "No day in the fortnight is short."
              : `Short: ${short.map((d) => `${d.when}, ${plural(d.gap, "spot")}`).join("; ")}.`}
          </p>
        </div>
      </div>

      <div role="tabpanel" id={`wp-${cur.day}`} aria-labelledby={`wd-${cur.day}`} tabIndex={-1} className="space-y-2">
        {panels[Math.min(sel, panels.length - 1)]}
      </div>
    </section>
  );
}
