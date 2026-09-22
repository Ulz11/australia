"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BriefcaseBusiness, CalendarDays, CircleUser, Clock, IdCard, Map, Users, Wallet, type LucideIcon } from "lucide-react";

/**
 * The layouts are Server Components, so a tab sends a name, not a component: an icon can't be
 * serialised across that line. One place maps the name to the drawing.
 */
const ICONS = {
  jobs: BriefcaseBusiness,
  workers: Users,
  pay: Wallet,
  me: CircleUser,
  calendar: CalendarDays,
  map: Map,
  shift: Clock,
  card: IdCard,
} satisfies Record<string, LucideIcon>;

export type TabIcon = keyof typeof ICONS;
export type Tab = { href: string; label: string; icon: TabIcon; badge?: number };

/**
 * The bar along the bottom, as a material: 86% canvas under a 20px blur (globals.css `.mat-strong`),
 * with a solid fallback where backdrop-filter is missing.
 *
 * 86% and not the header's 72% because this bar carries a *secondary* label. Over the worst thing that
 * can scroll under it — a full-width `.cell-ink` — a 72% bar put the inactive label at 2.57:1. At 86%
 * with `--on-mat-2` it measures 4.90:1, and the active ink label measures 12.52:1.
 *
 * Which tab you are on is said three ways, because no one of them clears 3:1 on its own: the ink mark at
 * the top edge does (12.52:1 over the bar), and the tinted pill behind the icon and the ink/700 label
 * against the others' secondary weight back it up. `aria-current` carries it for a screen reader.
 */
export function TabBar({ tabs }: { tabs: Tab[] }) {
  const p = usePathname();
  return (
    <nav className="mat-strong fixed bottom-0 inset-x-0 z-40" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="max-w-md mx-auto grid" style={{ gridTemplateColumns: `repeat(${tabs.length},1fr)` }}>
        {tabs.map((t) => {
          const on = t.href === p || (t.href !== "/boss" && t.href !== "/worker" && p.startsWith(t.href));
          const Icon = ICONS[t.icon];
          return (
            <Link key={t.href} href={t.href} aria-current={on ? "page" : undefined} className="tab">
              {on && <span aria-hidden className="tab-mark" />}
              {/* Full contrast whether or not it's the tab you're on: a faded icon is unreadable in sunlight. */}
              <span className="tab-pill">
                <Icon size={25} strokeWidth={on ? 2.5 : 2.1} aria-hidden className="shrink-0" />
              </span>
              {/* 14px, which is the floor the rest of the app keeps. Five tabs still fit: at 375px each
                  column is 75px and the longest label ("Money") sets about 45px at 14/700 Archivo. */}
              {t.label}
              {!!t.badge && (
                <span className="tab-badge">
                  {t.badge}<span className="sr-only"> waiting for you</span>
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
