import { Suspense } from "react";
import { siteToday } from "@/lib/siteClock";
import { requireRole } from "@/lib/session";
import { sql } from "@/lib/db";
import { TabBar, type Tab } from "@/components/TabBar";
import { SessionRefresh } from "@/components/SessionRefresh";
import { PasskeyOfferGate } from "@/components/PasskeyOfferGate";
import { LangProvider } from "@/components/Lang";
import { dictionary, getLang, getT } from "@/lib/i18n/server";
import type { T } from "@/lib/i18n";

const tabs = (t: T, matches = 0, live = 0): Tab[] => [
  { href: "/worker", label: t("Calendar"), icon: "calendar", badge: matches },
  { href: "/worker/explore", label: t("Map"), icon: "map" },
  { href: "/worker/shift", label: t("My shift"), icon: "shift", badge: live },
  { href: "/worker/me", label: t("Me"), icon: "card" },
];

/** Badge counts stream in after the page — the layout never blocks the page's own query. */
async function Tabs({ userId, t }: { userId: string; t: T }) {
  const [n] = await sql`SELECT
    (SELECT COUNT(*) FROM notifications WHERE user_id = ${userId} AND read_at IS NULL AND kind = 'shift_match')::int AS matches,
    (SELECT COUNT(*) FROM bookings b JOIN shifts s ON s.id = b.shift_id JOIN projects p ON p.id = s.project_id
       WHERE b.worker_id = ${userId} AND b.status IN ('accepted','clocked_in')
         AND s.day >= ${siteToday(sql`p.tz`)})::int AS live`;
  return <TabBar tabs={tabs(t, n.matches, n.live)} />;
}

export default async function WorkerLayout({ children }: { children: React.ReactNode }) {
  const u = await requireRole("worker");
  // The worker side reads in the worker's language. The dictionary is handed to the client components here,
  // so only the language being read crosses the wire (components/Lang.tsx).
  const [lang, t] = await Promise.all([getLang(), getT()]);
  const dict = await dictionary(lang);
  return (
    <LangProvider lang={lang} dict={dict}>
      {children}
      <SessionRefresh />
      <Suspense fallback={<TabBar tabs={tabs(t)} />}><Tabs userId={u.id} t={t} /></Suspense>
      <Suspense fallback={null}><PasskeyOfferGate userId={u.id} /></Suspense>
    </LangProvider>
  );
}
