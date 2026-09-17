import { Suspense } from "react";
import { requireRole } from "@/lib/session";
import { TabBar } from "@/components/TabBar";
import { SessionRefresh } from "@/components/SessionRefresh";
import { PasskeyOfferGate } from "@/components/PasskeyOfferGate";
export default async function BossLayout({ children }: { children: React.ReactNode }) {
  const u = await requireRole("boss");
  return (
    <>
      {children}
      <SessionRefresh />
      <Suspense fallback={null}><PasskeyOfferGate userId={u.id} /></Suspense>
      <TabBar tabs={[
        { href: "/boss", label: "Jobs", icon: "jobs" },
        { href: "/boss/workers", label: "Workers", icon: "workers" },
        { href: "/boss/pay", label: "Pay", icon: "pay" },
        { href: "/boss/me", label: "Me", icon: "me" },
      ]} />
    </>
  );
}
