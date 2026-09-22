import type { Week } from "@/lib/profileStats";

/**
 * DAYS ON THE TOOLS — and it IS the tile now, not a strip wedged under a heading.
 *
 * It used to render a `.card` with its own 18px title, the grid at native size, and a legend: three
 * stacked objects, the middle one of which was the point. Inside a bento that reads as a footnote. So the
 * component draws its own cell — `.cell .b-w2 .b-h2` by default, which is the 2x2 the mark was designed
 * for — with the title as the cell's 16/700 label and the grid taking every pixel underneath (`.cell-fill`).
 *
 * `span`/`rows` are props rather than a fixed shape because the two boss screens that draw this
 * (app/boss/me, app/boss/workers/[id]) render it OUTSIDE a `.bento`, where `b-w2`/`b-h2` are inert and the
 * cell is simply a full-width white card — the same thing they had before, at the same size.
 *
 * No script anywhere in it. A run short enough that a day stays a legible mark (`FIT_WEEKS`) is drawn to
 * the tile's own width, so the grid fills the tile edge to edge instead of leaving a grey margin. A longer
 * one — 52 weeks is 777px and never fitted a phone — keeps the old trick: a plain overflow box turned
 * around (`dir="rtl"` on the scroller, `dir="ltr"` on the grid) so it opens at this week, the end anyone
 * cares about, and you push it along with a thumb.
 *
 * Shades are ONE ink at four steps (globals.css `.hm-*`), never four colours, and the ink is `currentColor`
 * so a heatmap that lands on a filled cell comes out light-on-dark with no second code path. Orange never
 * appears here: a dark day is a long day, not a problem.
 */
const CELL = 12, GAP = 3, PITCH = CELL + GAP, TOP = 19;   // TOP leaves room for a 14px month name; nothing in the app is smaller
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Above this the grid is scrolled rather than scaled. 26 weeks at a 15px pitch is 387px, which a 2-wide
 * cell (311px inside its padding on a 375px phone) shrinks to an 11.6px day — still a square you can pick
 * out. A year would come down to 4.8px, which is a texture and not a record, so a year scrolls.
 */
const FIT_WEEKS = 26;

export function Heatmap({ weeks, title, sub, label, span = 2, rows = 2 }: {
  weeks: Week[]; title: string; sub?: string; label: string;
  span?: 1 | 2; rows?: 1 | 2 | 3;
}) {
  const w = weeks.length * PITCH - GAP, h = TOP + 7 * PITCH - GAP;
  const fit = weeks.length <= FIT_WEEKS;

  // A month gets its name where its first Monday lands, and only if the last name is three columns behind.
  const marks: { x: number; text: string }[] = [];
  let seen = -1, lastX = -99;
  weeks.forEach((wk, i) => {
    const m = Number(wk.start.slice(5, 7)) - 1;
    if (m !== seen && i * PITCH - lastX >= 3 * PITCH) { marks.push({ x: i * PITCH, text: MONTHS[m] }); lastX = i * PITCH; }
    seen = m;
  });

  /* No `text-ink`: the grid inherits the cell's own colour, which is what lets one set of `.hm-*` rules
     serve a white cell and a filled one. `aria-label` is this chart's sentence and it is never dropped. */
  const grid = (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className="block"
      {...(fit ? { style: { width: "100%", height: "auto" }, preserveAspectRatio: "xMidYMid meet" } : { width: w, height: h })}>
      {marks.map((m) => <text key={m.x} x={m.x} y={14} className="hm-label">{m.text}</text>)}
      {weeks.map((wk, x) => (
        <g key={wk.start}>
          {wk.days.map((d, y) => d && (
            <rect key={d.day} x={x * PITCH} y={TOP + y * PITCH} width={CELL} height={CELL} rx={2.5} className={`hm-${d.level}`} />
          ))}
        </g>
      ))}
    </svg>
  );

  const cls = ["cell", span === 2 ? "b-w2" : "", rows === 2 ? "b-h2" : rows === 3 ? "b-h3" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      {/* The tile's label, not a card heading: 16/700, with the one-line aside on the same baseline so the
          drawing keeps the whole of what is left. */}
      {/* flex-wrap, not shrink: when the aside is a sentence rather than a figure it takes its own line
          at full width instead of truncating the title beside it. */}
      <div className="c-label flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <span className="min-w-0 truncate">{title}</span>
        {sub && <span className="text-[15px] leading-[1.25] font-medium c-prose shrink-0 max-w-full num">{sub}</span>}
      </div>
      <div className="cell-fill mt-2">
        {fit ? grid : (
          <div dir="rtl" className="overflow-x-auto">
            <div dir="ltr" className="inline-block">{grid}</div>
          </div>
        )}
      </div>
      {/* The key. 14px is the app's floor and a chart legend is one of the two places allowed to sit on it.
          The swatches are the same four steps as a day on the grid — if they drift, the key stops being one. */}
      <div className="flex items-center gap-1.5 text-sm font-medium mt-2">
        {/* `c-prose` goes on the words and never on the row: the swatches have to keep the CELL's own
            colour, or the key is drawn in grey and stops being a key for an ink grid. */}
        <span className="c-prose">less</span>
        <span className="flex items-center gap-1">
          {[0, 1, 2, 3].map((l) => <span key={l} className={`hm-key hm-key-${l}`} />)}
        </span>
        <span className="c-prose">more</span>
      </div>
    </div>
  );
}
