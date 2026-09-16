import Link from "next/link";
import { Handshake, MapPin, Plus } from "lucide-react";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { Flag, Row, Say, Section } from "@/components/ui";
import { JobCard } from "@/components/JobCard";
import { fmtDay, fmtTime, todayIso } from "@/lib/util";
import { fillWords, groupByPost } from "@/lib/posts";
export const dynamic = "force-dynamic";

export default async function Jobs() {
  const u = await requireRole("boss");
  // All three queries go out together → one round trip.
  const [projects, shifts, [pending]] = await Promise.all([
    sql`SELECT p.id, p.name, p.address,
          (SELECT COUNT(*) FROM shifts s WHERE s.project_id = p.id AND s.day >= CURRENT_DATE AND s.status IN ('open','filled'))::int AS upcoming
        FROM projects p WHERE p.boss_id = ${u.id} AND NOT p.archived ORDER BY p.created_at DESC`,
    // The first 30 jobs, with every line of each: a job posted for three kinds of worker is three shifts.
    sql<{ id: string; post_id: string | null; day: string; start_time: string; hours: string; spots: number; role: string; status: string;
          site: string; taken: number; to_approve: number; disputed: number; direct: boolean; names: string | null }[]>`WITH j AS (
          SELECT id, dense_rank() OVER (ORDER BY day, start_time, COALESCE(post_id, id)) AS job
          FROM shifts WHERE boss_id = ${u.id} AND status IN ('open','filled') AND day >= CURRENT_DATE - 1
        )
        SELECT s.id, s.post_id, s.day, s.start_time, s.hours, s.spots, s.role, s.status, p.name AS site,
          s.direct_worker_id IS NOT NULL AS direct,
          (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled'))::int AS taken,
          (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status = 'clocked_out')::int AS to_approve,
          (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.disputed_at IS NOT NULL AND b.status IN ('approved','paid'))::int AS disputed,
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
  /** What this line is waiting on. Orange is only for the ones waiting on the boss. */
  const state = (x: (typeof shifts)[number]) => {
    const short = x.spots - x.taken;
    if (x.to_approve > 0) return { tone: "orange" as const, words: `${x.to_approve} to approve` };
    if (x.disputed > 0) return { tone: "orange" as const, words: `${x.disputed > 1 ? `${x.disputed} workers disagree` : "A worker disagrees"} with the hours` };
    if (short <= 0) return { tone: "green" as const, words: "All spots taken" };
    if (x.direct) return { tone: undefined, words: "Sent — waiting for a yes" };
    return { tone: "orange" as const, words: x.taken === 0 ? `Needs ${short} ${short > 1 ? "workers" : "worker"}` : `Needs ${short} more` };
  };

  return (
    <>
      <Header title="Jobs" />
      <Page>
        {pending.n > 0 && (
          <Say tone="orange" title={`${pending.n} worker${pending.n > 1 ? "s" : ""} finished — approve their hours`} sub="Tap the job below. It takes one tap per worker." />
        )}
        {pending.offers > 0 && (
          <Link href="/boss/offers" className="block">
            <Say tone="orange" icon={Handshake} title={`${pending.offers} worker${pending.offers > 1 ? "s want" : " wants"} to talk terms`} sub="Tap to see what they're asking. Answer fast — they're looking at other jobs." />
          </Link>
        )}

        {first ? (
          <Link href={`/boss/shifts/new?project=${first.id}`} className="btn-primary text-xl">
            <Plus size={22} strokeWidth={2.5} aria-hidden />Need workers
          </Link>
        ) : (
          <Empty>
            <div className="text-ink font-extrabold text-xl mb-1">Start with a site</div>
            <div className="mb-4">Put a pin where the job is. Shifts and workers hang off it.</div>
            <Link href="/boss/projects/new" className="btn-primary">Add my first site</Link>
          </Empty>
        )}

        {shifts.length > 0 && (
          <>
            <Section title="Coming up" hint="Today and the days ahead. Tap one to see who's on it." />
            <div className="space-y-2">
              {groupByPost(shifts).map(({ key, lines }) => {
                const s = lines[0];
                const when = s.day === today ? "Today" : fmtDay(s.day);
                if (lines.length === 1) {
                  const st = state(s);
                  return (
                    <Row key={key} href={`/boss/shifts/${s.id}`} tone={st.tone}
                      title={`${when} · ${fmtTime(s.start_time)}`}
                      sub={<>{s.site} · {s.spots} × {s.role}<br />
                        <Flag tone={st.tone ?? "grey"} className="mt-1 align-middle">{st.words}</Flag>
                        {s.names && <span className="ml-1.5 align-middle">{s.names} booked</span>}</>} />
                  );
                }
                const tones = lines.map(state);
                return (
                  <JobCard key={key} title={`${when} · ${fmtTime(s.start_time)} · ${Number(s.hours)}h`} sub={s.site}
                    tone={tones.some((t) => t.tone === "orange") ? "orange" : tones.every((t) => t.tone === "green") ? "green" : undefined}
                    lines={lines.map((l, i) => ({
                      id: l.id, title: `${l.spots} × ${l.role}`, tone: tones[i].tone,
                      sub: <><b className="text-ink">{tones[i].words}</b>{l.names ? ` — ${l.names}` : ""} · {fillWords(l.taken, l.spots)}</>,
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
            <Section title="My sites" hint="Tap a site to post a job there or see its history." />
            <div className="space-y-2">
              {projects.map((p) => (
                <Row key={p.id} href={`/boss/projects/${p.id}`} title={p.name}
                  sub={<span className="flex items-center gap-1.5"><MapPin size={16} strokeWidth={2.25} aria-hidden className="shrink-0" />{p.address || "No address"}</span>}
                  right={<span className="text-steel text-sm">{p.upcoming} coming up</span>} />
              ))}
            </div>
            <Link href="/boss/projects/new" className="btn-ghost"><Plus size={20} strokeWidth={2.5} aria-hidden />Add another site</Link>
          </>
        )}
      </Page>
    </>
  );
}
