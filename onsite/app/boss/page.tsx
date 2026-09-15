import Link from "next/link";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { Row, Say, Section } from "@/components/ui";
import { fmtDay, fmtTime, todayIso } from "@/lib/util";
export const dynamic = "force-dynamic";

export default async function Sites() {
  const u = await requireRole("boss");
  // All three queries go out together → one round trip.
  const [projects, shifts, [pending]] = await Promise.all([
    sql`SELECT p.id, p.name, p.address,
          (SELECT COUNT(*) FROM shifts s WHERE s.project_id = p.id AND s.day >= CURRENT_DATE AND s.status IN ('open','filled'))::int AS upcoming
        FROM projects p WHERE p.boss_id = ${u.id} AND NOT p.archived ORDER BY p.created_at DESC`,
    sql`SELECT s.id, s.day, s.start_time, s.hours, s.spots, s.role, s.status, p.name AS site,
          (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled'))::int AS taken,
          (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status = 'clocked_out')::int AS to_approve,
          (SELECT string_agg(split_part(us.name,' ',1), ', ') FROM bookings b JOIN users us ON us.id = b.worker_id WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled')) AS names
        FROM shifts s JOIN projects p ON p.id = s.project_id
        WHERE s.boss_id = ${u.id} AND s.status IN ('open','filled') AND s.day >= CURRENT_DATE - 1
        ORDER BY s.day, s.start_time LIMIT 30`,
    sql`SELECT
          (SELECT COUNT(*) FROM bookings b JOIN shifts s ON s.id = b.shift_id WHERE s.boss_id = ${u.id} AND b.status = 'clocked_out')::int AS n,
          (SELECT COUNT(*) FROM offers o JOIN shifts s ON s.id = o.shift_id WHERE s.boss_id = ${u.id} AND o.from_role = 'worker' AND o.status = 'pending')::int AS offers`,
  ]);
  const today = todayIso();
  const first = projects[0];

  return (
    <>
      <Header title="Sites" />
      <Page>
        {pending.n > 0 && (
          <Say tone="orange" title={`${pending.n} worker${pending.n > 1 ? "s" : ""} finished — approve their hours`} sub="Tap the shift below. It takes one tap per worker." />
        )}
        {pending.offers > 0 && (
          <Link href="/boss/offers" className="block">
            <Say tone="dark" title={`${pending.offers} worker${pending.offers > 1 ? "s want" : " wants"} to talk terms`} sub="Tap to see what they're asking. Answer fast — they're looking at other jobs." />
          </Link>
        )}

        {first ? (
          <Link href={`/boss/shifts/new?project=${first.id}`} className="btn-primary text-xl">Need workers</Link>
        ) : (
          <Empty>
            <div className="text-ink font-extrabold text-xl mb-1">Start with a site</div>
            <div className="mb-4">Put a pin where the job is. Shifts and workers hang off it.</div>
            <Link href="/boss/projects/new" className="btn-primary">Add my first site</Link>
          </Empty>
        )}

        {shifts.length > 0 && (
          <>
            <Section title="Shifts" hint="Today and coming up." />
            <div className="space-y-2">
              {shifts.map((s) => {
                const when = s.day === today ? "Today" : fmtDay(s.day);
                const state = s.to_approve > 0 ? `${s.to_approve} to approve` : s.taken >= s.spots ? "All spots taken" : s.taken === 0 ? "Looking for workers…" : `${s.taken} of ${s.spots} said yes`;
                return (
                  <Row key={s.id} href={`/boss/shifts/${s.id}`} tone={s.to_approve > 0 ? "orange" : s.taken >= s.spots ? "green" : undefined}
                    title={`${when} · ${fmtTime(s.start_time)}`}
                    sub={<>{s.site} · {s.spots} × {s.role}<br /><b className="text-ink">{state}</b>{s.names ? ` — ${s.names}` : ""}</>} />
                );
              })}
            </div>
          </>
        )}

        {pending.offers === 0 && projects.length > 0 && (
          <Link href="/boss/offers" className="text-steel underline text-base">Past requests from workers</Link>
        )}

        {projects.length > 0 && (
          <>
            <Section title="My sites" hint="Tap a site to post a shift there or see its history." />
            <div className="space-y-2">
              {projects.map((p) => (
                <Row key={p.id} href={`/boss/projects/${p.id}`} title={p.name} sub={p.address || "No address"} right={<span className="text-steel text-sm">{p.upcoming} coming up</span>} />
              ))}
            </div>
            <Link href="/boss/projects/new" className="btn-ghost">+ Add another site</Link>
          </>
        )}
      </Page>
    </>
  );
}
