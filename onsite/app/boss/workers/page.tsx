import Link from "next/link";
import { UserPlus } from "lucide-react";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { Row, Section } from "@/components/ui";
import { InvitedCrew, type InviteRow } from "./InvitedCrew";
import { crewJoinUrl } from "@/lib/crew";
export const dynamic = "force-dynamic";

export default async function Workers({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const u = await requireRole("boss");
  const { tab = "casual" } = await searchParams;
  const [crew, invites, [me]] = await Promise.all([
    sql`
      SELECT c.worker_id, c.type, c.rate, us.name, w.tickets,
        COALESCE((SELECT SUM(b.hours_approved) FROM bookings b JOIN shifts s ON s.id = b.shift_id WHERE b.worker_id = c.worker_id AND s.boss_id = ${u.id} AND b.status IN ('approved','paid')),0) AS hours
      FROM crew c JOIN users us ON us.id = c.worker_id JOIN workers w ON w.user_id = c.worker_id
      WHERE c.boss_id = ${u.id} ORDER BY us.name`,
    // Numbers this boss typed in. Scoped to them and shown nowhere else — no other boss ever sees them.
    sql<InviteRow[]>`
      SELECT id, phone, name, invited_at FROM crew_invites
      WHERE boss_id = ${u.id} AND joined_at IS NULL AND expires_at > now() ORDER BY invited_at DESC`,
    sql<{ company: string; invite_code: string | null }[]>`SELECT company, invite_code FROM bosses WHERE user_id = ${u.id}`,
  ]);
  const list = crew.filter((c) => c.type === tab);
  const base = (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const link = base && me?.invite_code ? crewJoinUrl(base, me.invite_code) : null;

  return (
    <>
      <Header title="My workers" />
      <Page>
        <Link href="/boss/workers/add" className="btn-dark flex items-center justify-center gap-2">
          <UserPlus size={22} strokeWidth={2.25} aria-hidden />Add your crew
        </Link>
        <div className="seg grid-cols-2">
          {[["fulltime", "Full-time"], ["casual", "Casual"]].map(([k, l]) => (
            <Link key={k} href={`/boss/workers?tab=${k}`} className={`seg-item ${tab === k ? "seg-on" : ""}`}>{l} · {crew.filter((c) => c.type === k).length}</Link>
          ))}
        </div>
        {list.length === 0 ? <Empty>{tab === "casual" ? "Add your crew above, or approve someone's hours and they land here." : "Open a worker and switch them to Full-time."}</Empty> : (
          <div className="space-y-2">
            {list.map((c) => (
              <Row key={c.worker_id} href={`/boss/workers/${c.worker_id}`} title={c.name}
                sub={`$${Number(c.rate ?? 0).toFixed(2)} an hour · ${Number(c.hours)} hours with you`} />
            ))}
          </div>
        )}

        {invites.length > 0 && (
          <>
            <Section title={`Invited · ${invites.length}`} hint="Waiting to sign up. Only you can see these numbers." />
            <InvitedCrew invites={invites} link={link} company={me?.company ?? ""} firstName={(u.name ?? "").split(" ")[0]} />
          </>
        )}
      </Page>
    </>
  );
}
