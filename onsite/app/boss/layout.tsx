import { requireRole } from "@/lib/session";
import { TabBar } from "@/components/TabBar";
export default async function BossLayout({ children }: { children: React.ReactNode }) {
  await requireRole("boss");
  return (
    <>
      {children}
      <TabBar tabs={[
        { href: "/boss", label: "Sites", icon: "📍" },
        { href: "/boss/workers", label: "Workers", icon: "👷" },
        { href: "/boss/pay", label: "Pay", icon: "💵" },
        { href: "/boss/me", label: "Me", icon: "⚙️" },
      ]} />
    </>
  );
}
