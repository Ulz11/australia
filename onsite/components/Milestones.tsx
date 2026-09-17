import { CalendarCheck, Clock, Footprints, MapPin, Repeat, type LucideIcon } from "lucide-react";

/**
 * Five things worth reaching, in one row. Quiet on purpose: an earned one is ink, one still coming is grey
 * with how far off it is. No badges, no confetti — this is a work record, not a game.
 */
const ICONS: Record<string, LucideIcon> = { first: Footprints, hours: Clock, sites: MapPin, rehires: Repeat, year: CalendarCheck };

export type Milestone = { key: keyof typeof ICONS & string; label: string; done: boolean; togo?: string };

export function Milestones({ items }: { items: Milestone[] }) {
  return (
    <div className="card">
      <div className="text-lg font-bold">Milestones</div>
      <div className="grid grid-cols-5 gap-1.5 mt-2">
        {items.map((m) => {
          const Icon = ICONS[m.key];
          return (
            <div key={m.key} className={`rounded-xl border p-2 text-center ${m.done ? "border-line bg-site text-ink" : "border-line text-steel"}`}>
              <Icon size={18} strokeWidth={2.25} aria-hidden className="mx-auto shrink-0" />
              <div className="text-[11px] font-bold leading-tight mt-1 text-balance">{m.label}</div>
              {!m.done && m.togo && <div className="text-[10px] leading-tight mt-0.5 num">{m.togo}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
