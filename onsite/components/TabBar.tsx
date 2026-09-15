"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function TabBar({ tabs }: { tabs: { href: string; label: string; icon: string; badge?: number }[] }) {
  const p = usePathname();
  return (
    <nav className="fixed bottom-0 inset-x-0 z-40 bg-white border-t-2 border-line" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="max-w-md mx-auto grid" style={{ gridTemplateColumns: `repeat(${tabs.length},1fr)` }}>
        {tabs.map((t) => {
          const on = t.href === p || (t.href !== "/boss" && t.href !== "/worker" && p.startsWith(t.href));
          return (
            <Link key={t.href} href={t.href} className={`relative flex flex-col items-center pt-2 pb-2 min-h-[64px] text-[13px] font-bold ${on ? "text-ink" : "text-steel"}`}>
              <span className={`text-2xl leading-none mb-1 ${on ? "" : "opacity-50"}`} aria-hidden>{t.icon}</span>
              {t.label}
              {on && <span className="absolute top-0 h-1 w-10 bg-hv rounded-b-full" />}
              {!!t.badge && <span className="absolute top-1 right-[18%] bg-hv text-ink text-xs font-extrabold rounded-full min-w-[22px] h-[22px] flex items-center justify-center px-1">{t.badge}</span>}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
