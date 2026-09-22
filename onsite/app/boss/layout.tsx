import { Suspense } from "react";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { TabBar, type Tab } from "@/components/TabBar";
import { SessionRefresh } from "@/components/SessionRefresh";
import { PasskeyOfferGate } from "@/components/PasskeyOfferGate";

/**
 * Five tabs, and why it is five rather than the four the redesign drew.
 *
 * Today · Week · Crew · Money are the four screens a boss works from. Me was going to become an avatar in the
 * header, but it is where passkeys, sessions and sign-out live: a boss setting up a new phone who cannot reach
 * it is locked out of their own account, and that is a worse outcome than a tab bar one column busier. At
 * 390px five columns are 78px each, comfortably over the 64px a tab needs.
 *
 * Money replaces both Pay and Billing — it is the same fortnight the invoice runs on, so the pay run and the
 * invoices finally sit on one window instead of a week-locked screen beside a separate one.
 */
const tabs = (waiting: number): Tab[] => [
  // The badge is the approve queue. /boss/approve is not a tab of its own — it is one job, reached from the
  // hero when it is the most urgent thing and from here when it is not.
  { href: "/boss", label: "Today", icon: "jobs", badge: waiting },
  { href: "/boss/week", label: "Week", icon: "calendar" },
  { href: "/boss/workers", label: "Crew", icon: "workers" },
  { href: "/boss/money", label: "Money", icon: "pay" },
  { href: "/boss/me", label: "Me", icon: "me" },
];

/** Streams in after the page: a badge is never worth making a boss wait for the screen behind it. */
async function BossTabs({ bossId }: { bossId: string }) {
  const [n] = await sql<{ waiting: number }[]>`
    SELECT (SELECT COUNT(*) FROM bookings b JOIN shifts s ON s.id = b.shift_id
            WHERE s.boss_id = ${bossId} AND b.status = 'clocked_out')::int AS waiting`;
  return <TabBar tabs={tabs(n?.waiting ?? 0)} />;
}

export default async function BossLayout({ children }: { children: React.ReactNode }) {
  const u = await requireRole("boss");
  return (
    <>
      {children}
      <SessionRefresh />
      <Suspense fallback={null}><PasskeyOfferGate userId={u.id} /></Suspense>
      {/* The bar itself is drawn straight away with no badge, so it never pops in under a thumb already
          on its way down: only the number waits for the count. */}
      <Suspense fallback={<TabBar tabs={tabs(0)} />}><BossTabs bossId={u.id} /></Suspense>
    </>
  );
}
