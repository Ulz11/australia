import Link from "next/link";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { Row } from "@/components/ui";
import { addCrewByPhone } from "@/actions/boss";
export const dynamic = "force-dynamic";

export default async function Workers({ searchParams }: { searchParams: Promise<{ tab?: string; notfound?: string }> }) {
  const u = await requireRole("boss");
  const { tab = "casual", notfound } = await searchParams;
  const crew = await sql`
    SELECT c.worker_id, c.type, c.rate, us.name, w.tickets,
      COALESCE((SELECT SUM(b.hours_approved) FROM bookings b JOIN shifts s ON s.id = b.shift_id WHERE b.worker_id = c.worker_id AND s.boss_id = ${u.id} AND b.status IN ('approved','paid')),0) AS hours
    FROM crew c JOIN users us ON us.id = c.worker_id JOIN workers w ON w.user_id = c.worker_id
    WHERE c.boss_id = ${u.id} ORDER BY us.name`;
  const list = crew.filter((c) => c.type === tab);
  return (
    <>
      <Header title="My workers" />
      <Page>
        <div className="seg grid-cols-2">
          {[["fulltime", "Full-time"], ["casual", "Casual"]].map(([k, l]) => (
            <Link key={k} href={`/boss/workers?tab=${k}`} className={`seg-item ${tab === k ? "seg-on" : ""}`}>{l} · {crew.filter((c) => c.type === k).length}</Link>
          ))}
        </div>
        {list.length === 0 ? <Empty>{tab === "casual" ? "When you approve someone's hours, they land here." : "Open a worker and switch them to Full-time."}</Empty> : (
          <div className="space-y-2">
            {list.map((c) => (
              <Row key={c.worker_id} href={`/boss/workers/${c.worker_id}`} title={c.name}
                sub={`$${Number(c.rate ?? 0).toFixed(2)} an hour · ${Number(c.hours)} hours with you`} />
            ))}
          </div>
        )}
        <form action={addCrewByPhone} className="card space-y-2">
          <div className="text-lg font-bold">Add someone you already know</div>
          <div className="text-steel">Type their mobile. They need the app first.</div>
          <div className="flex gap-2"><input name="phone" type="tel" className="input" placeholder="0412 345 678" required /><button className="btn-dark btn-sm">Add</button></div>
          {notfound && <div className="text-warn font-semibold">No worker with that number yet. Ask them to sign up, then try again.</div>}
        </form>
      </Page>
    </>
  );
}
