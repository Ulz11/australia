import Link from "next/link";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { Row, Say, Section } from "@/components/ui";
import { JobCard } from "@/components/JobCard";
import { fmtDay, fmtTime, todayIso } from "@/lib/util";
import { fillWords, groupByPost } from "@/lib/posts";
export const dynamic = "force-dynamic";

export default async function Sites() {
  const u = await requireRole("boss");
  // All three queries go out together → one round trip.
  const [projects, shifts, [pending]] = await Promise.all([
    sql`SELECT p.id, p.name, p.address,
          (SELECT COUNT(*) FROM shifts s WHERE s.project_id = p.id AND s.day >= CURRENT_DATE AND s.status IN ('open','filled'))::int AS upcoming
        FROM projects p WHERE p.boss_id = ${u.id} AND NOT p.archived ORDER BY p.created_at DESC`,
    // The first 30 jobs, with every line of each: a job posted for three kinds of worker is three shifts.
    sql<{ id: string; post_id: string | null; day: string; start_time: string; hours: string; spots: number; role: string; status: string;
          site: string; taken: number; to_approve: number; names: string | null }[]>`WITH j AS (
          SELECT id, dense_rank() OVER (ORDER BY day, start_time, COALESCE(post_id, id)) AS job
          FROM shifts WHERE boss_id = ${u.id} AND status IN ('open','filled') AND day >= CURRENT_DATE - 1
        )
        SELECT s.id, s.post_id, s.day, s.start_time, s.hours, s.spots, s.role, s.status, p.name AS site,
          (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled'))::int AS taken,
          (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status = 'clocked_out')::int AS to_approve,
          (SELECT string_agg(split_part(us.name,' ',1), ', ') FROM bookings b JOIN users us ON us.id = b.worker_id WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled')) AS names
        FROM j JOIN shifts s ON s.id = j.id JOIN projects p ON p.id = s.project_id
        WHERE j.job <= 30
        ORDER BY j.job, s.created_at`,
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
              {groupByPost(shifts).map(({ key, lines }) => {
                const s = lines[0];
                const when = s.day === today ? "Today" : fmtDay(s.day);
                const tone = (x: typeof s) => (x.to_approve > 0 ? "orange" as const : x.taken >= x.spots ? "green" as const : undefined);
                if (lines.length === 1) {
                  const state = s.to_approve > 0 ? `${s.to_approve} to approve` : s.taken >= s.spots ? "All spots taken" : s.taken === 0 ? "Looking for workers…" : `${s.taken} of ${s.spots} said yes`;
                  return (
                    <Row key={key} href={`/boss/shifts/${s.id}`} tone={tone(s)}
                      title={`${when} · ${fmtTime(s.start_time)}`}
                      sub={<>{s.site} · {s.spots} × {s.role}<br /><b className="text-ink">{state}</b>{s.names ? ` — ${s.names}` : ""}</>} />
                  );
                }
                return (
                  <JobCard key={key} title={`${when} · ${fmtTime(s.start_time)} · ${Number(s.hours)}h`} sub={s.site}
                    tone={lines.some((l) => l.to_approve > 0) ? "orange" : lines.every((l) => l.taken >= l.spots) ? "green" : undefined}
                    lines={lines.map((l) => ({
                      id: l.id, title: `${l.spots} × ${l.role}`, tone: tone(l),
                      sub: <><b className="text-ink">{l.to_approve > 0 ? `${l.to_approve} to approve` : fillWords(l.taken, l.spots)}</b>{l.names ? ` — ${l.names}` : ""}</>,
                    }))} />
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
