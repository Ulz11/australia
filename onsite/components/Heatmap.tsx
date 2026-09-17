import type { Week } from "@/lib/profileStats";

/**
 * A year of days, seven rows deep, drawn on the server. No script anywhere in it: the strip is a plain
 * overflow box turned around (`dir="rtl"` on the scroller, `dir="ltr"` on the grid inside) so a phone opens
 * it already at this week, which is the end anyone cares about. 52 weeks is 777px — it never fits a phone,
 * and it isn't meant to; it is a thing you push along with your thumb.
 *
 * Shades are ink at four steps (globals.css .hm-*), not four colours. Orange never appears here: a dark day
 * is a long day, not a problem.
 */
const CELL = 12, GAP = 3, PITCH = CELL + GAP, TOP = 15;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function Heatmap({ weeks, title, sub, label }: { weeks: Week[]; title: string; sub?: string; label: string }) {
  const w = weeks.length * PITCH - GAP, h = TOP + 7 * PITCH - GAP;

  // A month gets its name where its first Monday lands, and only if the last name is three columns behind.
  const marks: { x: number; text: string }[] = [];
  let seen = -1, lastX = -99;
  weeks.forEach((wk, i) => {
    const m = Number(wk.start.slice(5, 7)) - 1;
    if (m !== seen && i * PITCH - lastX >= 3 * PITCH) { marks.push({ x: i * PITCH, text: MONTHS[m] }); lastX = i * PITCH; }
    seen = m;
  });

  return (
    <div className="card space-y-2">
      <div>
        <div className="text-lg font-bold">{title}</div>
        {sub && <div className="text-base text-steel">{sub}</div>}
      </div>
      <div dir="rtl" className="overflow-x-auto">
        <div dir="ltr" className="inline-block">
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className="block text-ink">
            {marks.map((m) => <text key={m.x} x={m.x} y={10} className="hm-label">{m.text}</text>)}
            {weeks.map((wk, x) => (
              <g key={wk.start}>
                {wk.days.map((d, y) => d && (
                  <rect key={d.day} x={x * PITCH} y={TOP + y * PITCH} width={CELL} height={CELL} rx={2.5} className={`hm-${d.level}`} />
                ))}
              </g>
            ))}
          </svg>
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-sm text-steel">
        less
        <span className="flex items-center gap-1 text-ink">
          {[0, 1, 2, 3].map((l) => <span key={l} className={`hm-key hm-key-${l}`} />)}
        </span>
        more
      </div>
    </div>
  );
}
