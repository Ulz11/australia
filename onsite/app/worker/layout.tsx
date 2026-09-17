import { Suspense } from "react";
import { requireRole } from "@/lib/session";
import { sql } from "@/lib/db";
import { TabBar, type Tab } from "@/components/TabBar";
import { SessionRefresh } from "@/components/SessionRefresh";
import { PasskeyOfferGate } from "@/components/PasskeyOfferGate";

const tabs = (matches = 0, live = 0): Tab[] => [
  { href: "/worker", label: "Calendar", icon: "calendar", badge: matches },
  { href: "/worker/explore", label: "Map", icon: "map" },
  { href: "/worker/shift", label: "My shift", icon: "shift", badge: live },
  { href: "/worker/me", label: "Me", icon: "card" },
];

/** Badge counts stream in after the page — the layout never blocks the page's own query. */
async function Tabs({ userId }: { userId: string }) {
  const [n] = await sql`SELECT
    (SELECT COUNT(*) FROM notifications WHERE user_id = ${userId} AND read_at IS NULL AND kind = 'shift_match')::int AS matches,
    (SELECT COUNT(*) FROM bookings b JOIN shifts s ON s.id = b.shift_id WHERE b.worker_id = ${userId} AND b.status IN ('accepted','clocked_in') AND s.day >= CURRENT_DATE)::int AS live`;
  return <TabBar tabs={tabs(n.matches, n.live)} />;
}

export default async function WorkerLayout({ children }: { children: React.ReactNode }) {
  const u = await requireRole("worker"); // cookie only, no DB
  return (
    <>
      {children}
      <SessionRefresh />
      <Suspense fallback={<TabBar tabs={tabs()} />}><Tabs userId={u.id} /></Suspense>
      <Suspense fallback={null}><PasskeyOfferGate userId={u.id} /></Suspense>
    </>
  );
}
