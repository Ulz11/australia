/**
 * A year of hours as twelve bars. CSS heights, no library, no script — the shape is the point, so only the
 * first and last month are named and the tallest month carries its number.
 */
export function MonthBars({ title, months }: { title: string; months: { key: string; label: string; hours: number }[] }) {
  const peak = Math.max(...months.map((m) => m.hours), 1);
  const best = months.reduce((a, m) => (m.hours > a.hours ? m : a), months[0]);
  return (
    <div className="card space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-lg font-bold">{title}</div>
        <div className="text-sm text-steel num">most: {best.hours}h in {best.label}</div>
      </div>
      {/* No track behind the bars: an empty month is a hairline, so the shape of the year is the only thing drawn. */}
      <div className="flex items-end gap-1.5 h-24 border-b border-line" aria-hidden>
        {months.map((m) => (
          <div key={m.key} className="flex-1 bg-ink rounded-t-md"
            style={{ height: `${Math.max(2, Math.round((m.hours / peak) * 100))}%`, opacity: m.hours > 0 ? 1 : 0.15 }} />
        ))}
      </div>
      <div className="flex justify-between text-sm text-steel">
        <span>{months[0].label}</span><span>{months[months.length - 1].label}</span>
      </div>
      <p className="sr-only num">
        {months.map((m) => `${m.label} ${m.hours} hours`).join(", ")}.
      </p>
    </div>
  );
}
