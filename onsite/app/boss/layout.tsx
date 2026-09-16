import { requireRole } from "@/lib/session";
import { TabBar } from "@/components/TabBar";
import { SessionRefresh } from "@/components/SessionRefresh";
export default async function BossLayout({ children }: { children: React.ReactNode }) {
  await requireRole("boss");
  return (
    <>
      {children}
      <SessionRefresh />
      <TabBar tabs={[
        { href: "/boss", label: "Jobs", icon: "jobs" },
        { href: "/boss/workers", label: "Workers", icon: "workers" },
        { href: "/boss/pay", label: "Pay", icon: "pay" },
        { href: "/boss/me", label: "Me", icon: "me" },
      ]} />
    </>
  );
}
