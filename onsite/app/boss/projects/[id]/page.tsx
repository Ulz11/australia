import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { Row, Section } from "@/components/ui";
import { StatusPill } from "@/components/StatusPill";
import { LazyMap } from "@/components/LazyMap";
import { ConfirmButton } from "@/components/ConfirmButton";
import { archiveProject } from "@/actions/boss";
import { CrewTarget } from "../CrewTarget";
import { crewStatus } from "@/lib/rules";
import { fmtDay, fmtTime, todayIso } from "@/lib/util";
import { Say } from "@/components/ui";
export const dynamic = "force-dynamic";

export default async function Project({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const u = await requireRole("boss");
  const { id } = await params;
  const { err } = await searchParams;
  const [[p], shifts, [crew]] = await Promise.all([
    sql`SELECT id, name, address, crew_target, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM projects WHERE id = ${id} AND boss_id = ${u.id}`,
    sql`SELECT s.id, s.day, s.start_time, s.hours, s.spots, s.role, s.status,
          (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled'))::int AS taken
        FROM shifts s WHERE s.project_id = ${id} ORDER BY s.day DESC, s.start_time LIMIT 60`,
    // "own crew" means full-timers who actually work THIS site — a boss with three
    // sites doesn't have all his blokes standing on each one.
    sql`SELECT
          (SELECT COUNT(DISTINCT c.worker_id) FROM crew c
             WHERE c.boss_id = ${u.id} AND c.type = 'fulltime'
               AND EXISTS (SELECT 1 FROM bookings b JOIN shifts s2 ON s2.id = b.shift_id
                           WHERE b.worker_id = c.worker_id AND s2.project_id = ${id}
                             AND s2.day >= CURRENT_DATE - 30 AND b.status NOT IN ('removed','cancelled')))::int AS own_crew,
          (SELECT COUNT(DISTINCT b.worker_id) FROM bookings b JOIN shifts s ON s.id = b.shift_id
             WHERE s.project_id = ${id} AND s.day >= CURRENT_DATE AND b.status NOT IN ('removed','cancelled')
               AND NOT EXISTS (SELECT 1 FROM crew c2 WHERE c2.boss_id = ${u.id} AND c2.worker_id = b.worker_id AND c2.type = 'fulltime'))::int AS booked_ahead`,
  ]);
  if (!p) notFound();
  return (
    <>
      <Header title={p.name} back="/boss" />
      <Page>
        <LazyMap center={[p.lng, p.lat]} zoom={14} pins={[{ id: p.id, lat: p.lat, lng: p.lng, kind: "hot", label: p.name }]} className="h-44" />
        <div className="text-steel">{p.address}</div>
        <CrewTarget projectId={p.id} ownCrew={crew.own_crew}
          status={crewStatus({ crew_target: p.crew_target, own_crew: crew.own_crew, booked_ahead: crew.booked_ahead })} />
        <Link href={`/boss/shifts/new?project=${p.id}`} className="btn-primary text-xl">Need workers here</Link>
        <Section title="Shifts at this site" />
        {shifts.length === 0 ? <Empty>No shifts yet.</Empty> : (
          <div className="space-y-2">
            {shifts.map((s) => (
              <Row key={s.id} href={`/boss/shifts/${s.id}`} title={`${fmtDay(s.day)} · ${fmtTime(s.start_time)}`} sub={`${s.spots} × ${s.role} · ${Number(s.hours)}h · ${s.taken} of ${s.spots} came`}
                right={<StatusPill s={s.status === "cancelled" ? "cancelled" : s.day < todayIso() ? "closed" : s.taken >= s.spots ? "filled" : s.status} />} />
            ))}
          </div>
        )}
        {err && <Say tone="red" title={`Can't hide this site yet — ${err} shift${err === "1" ? "" : "s"} still coming up.`} sub="Cancel them, or wait until they're done." />}
        <ConfirmButton action={archiveProject.bind(null, p.id)} className="btn-ghost" msg="Hide this site? Past records are kept.">Job finished — hide this site</ConfirmButton>
      </Page>
    </>
  );
}
