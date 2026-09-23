import { CalendarCheck, Clock, Footprints, MapPin, Repeat, type LucideIcon } from "lucide-react";

/**
 * FIVE THINGS WORTH REACHING — a 2x2 tile, five full-width rows, and room to read them.
 *
 * It used to be five boxes side by side across a card: at 279px of usable width that is 51px a box, which
 * is why the label had been squeezed to 14px and still wrapped to three lines. Five ROWS instead — the
 * label gets the whole width at the app's 16px cell size, and how far off it is sits on the same line,
 * right-aligned, where a column of them lines up.
 *
 * Quiet on purpose. An earned one is a filled ink chip with the mark reversed out of it; one still coming
 * is the same chip at the heatmap's `empty` step. No badges, no confetti, no colour: this is a work record
 * and not a game, and orange in here would be five things all claiming to be the one that needs you.
 *
 * CONTRAST. A not-yet label is `--label-2` (5.30:1 on white) and never the 1.74:1 tertiary — the tertiary
 * ramp is for a gridline, never for a word. Done labels are full ink at 17.96:1, and the reversed mark is
 * white on ink at 92% opacity, about 15:1.
 *
 * SPOKEN. Every visual mark of "earned" here is aria-hidden or is a font weight, so a screen reader used
 * to hear the same five rows whether you had earned none or all of them — the absence of a `togo` was the
 * only hint, and it is not a sentence. `earnedLabel` puts the word in the row.
 *
 * Every word on it arrives as a prop, `title` included. This is shared with boss screens, which stay
 * English (lib/i18n/index.ts: getLang() answers "en" for a boss whatever the cookie says), so the
 * component must not hold an opinion about language.
 */
const ICONS: Record<string, LucideIcon> = { first: Footprints, hours: Clock, sites: MapPin, rehires: Repeat, year: CalendarCheck };
const INK_FULL = 0.92, INK_EMPTY = 0.16;

export type Milestone = { key: keyof typeof ICONS & string; label: string; done: boolean; togo?: string };

export function Milestones({ title, items, earnedLabel, span = 2, rows = 2 }: {
  title: string; items: Milestone[]; earnedLabel?: string; span?: 1 | 2; rows?: 1 | 2 | 3;
}) {
  const cls = ["cell", span === 2 ? "b-w2" : "", rows === 2 ? "b-h2" : rows === 3 ? "b-h3" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <div className="c-label">{title}</div>
      <ul className="cell-fill mt-2.5 gap-[5px] justify-start">
        {items.map((m) => {
          const Icon = ICONS[m.key];
          return (
            <li key={m.key} className="flex items-center gap-2.5 min-w-0">
              {/* The chip is a box of currentColor at an opacity, so the mark inside it has to be a
                  separate, un-faded layer — otherwise the icon inherits 0.16 and disappears. */}
              <span className="relative shrink-0 w-[26px] h-[26px] rounded-lg flex items-center justify-center">
                <span className="absolute inset-0 rounded-lg" aria-hidden
                  style={{ background: "currentColor", opacity: m.done ? INK_FULL : INK_EMPTY }} />
                <Icon size={15} strokeWidth={2.5} aria-hidden className="relative"
                  style={m.done ? { color: "var(--surface)" } : { opacity: 0.72 }} />
              </span>
              <span className={`min-w-0 flex-1 truncate text-[16px] leading-[1.2] ${m.done ? "font-bold" : "font-semibold c-prose"}`}>
                {m.label}
              </span>
              {/* Earned was said in three silent ways — a filled chip, a reversed mark and a heavier
                  weight — and all three are aria-hidden or are a font weight, so a reader heard the same
                  five rows whether you had earned none or all of them. The word is the fourth way, and
                  the only one that survives being listened to. It sits outside the label span because
                  that span truncates, and it arrives already translated like every other word here. */}
              {m.done && earnedLabel && <span className="sr-only">{` — ${earnedLabel}`}</span>}
              {!m.done && m.togo && (
                <span className="shrink-0 text-[15px] leading-[1.2] font-medium num c-prose">{m.togo}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
