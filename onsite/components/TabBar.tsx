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

export function TabBar({ tabs }: { tabs: Tab[] }) {
  const p = usePathname();
  return (
    <nav className="fixed bottom-0 inset-x-0 z-40 bg-white border-t-2 border-line" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="max-w-md mx-auto grid" style={{ gridTemplateColumns: `repeat(${tabs.length},1fr)` }}>
        {tabs.map((t) => {
          const on = t.href === p || (t.href !== "/boss" && t.href !== "/worker" && p.startsWith(t.href));
          const Icon = ICONS[t.icon];
          return (
            <Link key={t.href} href={t.href} aria-current={on ? "page" : undefined}
              className={`relative flex flex-col items-center pt-2 pb-2 min-h-[64px] text-[13px] font-bold ${on ? "text-ink" : "text-steel"}`}>
              {/* Full contrast when it's not the tab you're on: a faded icon is unreadable in sunlight. */}
              <Icon size={26} strokeWidth={2.25} aria-hidden className="mb-1 shrink-0" />
              {t.label}
              {on && <span className="absolute top-0 h-1 w-10 bg-ink rounded-b-full" />}
              {!!t.badge && (
                <span className="absolute top-1 right-[18%] bg-hv text-ink text-xs font-extrabold rounded-full min-w-[22px] h-[22px] flex items-center justify-center px-1">
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
