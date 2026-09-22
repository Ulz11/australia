/**
 * A year of hours as twelve bars — the whole content of a 2x1 tile, not a chart under a card heading.
 *
 * CSS boxes, no library, no script: the shape is the point, so only the first and last month are named
 * and the peak month is carried as one aside on the label's own baseline.
 *
 * The bars are `currentColor` at the heatmap's own four steps rather than `bg-ink`, which is what lets one
 * component serve a white tile and a filled one — and it keeps ink-opacity as the single chart device in
 * the app. An empty month is drawn at the `empty` step, so a quiet month is visibly a quiet month and not
 * a gap where the drawing failed.
 *
 * `title` and `most` are words, not sentences this component writes: it is shared with boss screens, which
 * stay English, so the caller decides the language. The worker caller hands it t("most: {n}h in {month}",
 * …) already filled in, and a boss caller would hand it plain English. `hoursLabel` is the same thing for
 * the screen-reader line under the bars, which is never dropped.
 */
const INK_FULL = 0.92, INK_EMPTY = 0.16;

export function MonthBars({ title, months, most, hoursLabel, span = 2, rows = 1 }: {
  title: string;
  months: { key: string; label: string; hours: number }[];
  /** "most: 33h in Sept" — already worked out by the caller, because only the caller knows the language. */
  most: string;
  /** How one month reads to a screen reader: "{month} {n} hours". */
  hoursLabel: (month: string, hours: number) => string;
  span?: 1 | 2;
  rows?: 1 | 2 | 3;
}) {
  const peak = Math.max(...months.map((m) => m.hours), 1);
  const cls = ["cell", span === 2 ? "b-w2" : "", rows === 2 ? "b-h2" : rows === 3 ? "b-h3" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      {/* flex-wrap, not shrink: when the aside is a sentence rather than a figure it takes its own line
          at full width instead of truncating the title beside it. */}
      <div className="c-label flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <span className="min-w-0 truncate">{title}</span>
        {/* 15px, not the old 14: 14px is the floor and it belongs to chart axes. This is a sentence. */}
        <span className="text-[15px] leading-[1.25] font-medium c-prose num shrink-0 max-w-full">{most}</span>
      </div>

      <div className="cell-fill mt-2 justify-end">
        {/* No track behind the bars — an empty track invites the eye to read each bar as a share of a total
            it is not a share of. The baseline under them is the axis, drawn in the same ink at the same
            `empty` step the quiet months are, so the whole drawing is one device. */}
        <div className="flex items-end gap-1.5 h-10 min-h-[40px]" aria-hidden>
          {months.map((m) => (
            <div key={m.key} className="flex-1 rounded-t-md"
              style={{
                height: `${Math.max(3, Math.round((m.hours / peak) * 100))}%`,
                background: "currentColor",
                opacity: m.hours > 0 ? INK_FULL : INK_EMPTY,
              }} />
          ))}
        </div>
        <div className="h-px w-full mt-px" style={{ background: "currentColor", opacity: INK_EMPTY }} aria-hidden />
      </div>

      {/* The axis. 14px is the floor and a chart axis is one of the two places allowed to sit on it. */}
      <div className="flex justify-between text-sm font-medium c-prose mt-1.5">
        <span>{months[0].label}</span><span>{months[months.length - 1].label}</span>
      </div>
      <p className="sr-only num">
        {months.map((m) => hoursLabel(m.label, m.hours)).join(", ")}.
      </p>
    </div>
  );
}

/** The tallest month, for the caller that has to put it into words. */
export const bestMonth = (months: { label: string; hours: number }[]) =>
  months.reduce((a, m) => (m.hours > a.hours ? m : a), months[0]);
