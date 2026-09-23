import Link from "next/link";
import { CalendarDays, MapPin, Plus } from "lucide-react";
import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { Avatar, BigMoney, Cell, Flag, Row, Section } from "@/components/ui";
import { HeroCell } from "@/components/HeroCell";
import { JobCard } from "@/components/JobCard";
import { bossToday } from "@/lib/bossToday";
import { fmtDay, fmtTime } from "@/lib/util";
import { fillWords, groupByPost } from "@/lib/posts";
export const dynamic = "force-dynamic";

/**
 * Today. One orange thing, then the money, then the work.
 *
 * What this screen used to do: every waiting thing came back tone "orange" from one `state()` and `Row`
 * drew them all the same, so "3 to approve", "a worker disagrees" and a hole at 6:30 tomorrow were the
 * same colour in the same list. The hole is the one that costs a day of concrete and a crane, and it is
 * the one that got scrolled past. Now lib/rank.ts orders them and only the top one is orange; the next
 * drops a volume step, and the rest become plain rows under "Also waiting". Nothing else here is orange.
 *
 * Every number comes from lib/bossToday.ts, which answers with nulls and a list of what it could not
 * reach rather than with zeroes. A zero and a failed query look identical on a tile and mean opposite
 * things to a boss deciding whether he can go home.
 *
 * THE SHAPE. The hero keeps its 2x2 and its orange — it is the one thing on the screen that needs the
 * boss now — and the four tiles under it interlock instead of stacking:
 *
 *    2x2  the one thing (orange, or green when there is nothing)
 *    2x1  the second-ranked thing, a volume step down, when there is one
 *    [ Need workers ]  the screen's one primary action, still directly under the hero
 *    1x2  Still to pay, tall, beside 1x1 Next invoice stacked over 1x1 who could take the next job
 *    2x1  Same crew again — four faces, which is a picture and wants the width
 *
 * "Still to pay" is the tall one because it is the only figure on this screen with a person waiting at
 * the other end of it. It drops back to a 1x1 when there is no shortlist to stack beside it, so the grid
 * never ends a row with a hole in it. The "Where the work is" heading that used to sit between two stacks
 * of full-width cards is gone: the tiles say what they are, and the sentence it carried is now the
 * shortlist tile's spoken line.
 */
export default async function Jobs() {
  const u = await requireRole("boss");
  const t = await bossToday(u.id);
  const [top = null, second = null, ...demoted] = t.urgency.items;
  const failed = t.urgency.state === "unknown";
  const firstSite = t.projects[0];

  // A boss with no site has nothing to rank and nothing to pay. The first-run screen is the best one in
  // the app and it is kept exactly as it was.
  if (!firstSite) {
    return (
      <>
        <Header title="Jobs" />
        <Page>
          <Empty>
            <div className="text-ink font-extrabold text-xl mb-1">Start with a site</div>
            <div className="mb-4">Put a pin where the job is. Shifts and workers hang off it.</div>
            <Link href="/boss/projects/new" className="btn-primary">Add my first site</Link>
          </Empty>
        </Page>
      </>
    );
  }

  const full = (l: { taken: number; spots: number }) => l.taken >= l.spots;

  return (
    <>
      <Header title="Jobs" />
      <Page>
        <div className="bento">
          {/* The ink action goes to /boss/approve, which prices every waiting lot of hours together. The
              ghost is the single oldest job for a boss who only wants to settle that one — `shiftId`, not
              `href`, because `href` is now the queue and the two buttons would otherwise be one button. */}
          <HeroCell item={top} failed={failed}
            ghost={top?.key === "approve" && top.shiftId
              ? { label: "One by one", href: `/boss/shifts/${top.shiftId}` } : null} />
          {/* Second-highest, a volume step down. Absent when only one thing is live, and the grid closes up. */}
          {second && (
            <Cell span={2} tone="soft" href={second.href ?? undefined} label={second.label}
              sub={<><b className="num">{second.figure}</b> · {second.sub}</>} />
          )}
        </div>

        {/* One primary action per screen, directly under the hero so the thumb finds it without scrolling. */}
        <Link href={`/boss/shifts/new?project=${firstSite.id}`} className="btn-primary text-xl">
          <Plus size={22} strokeWidth={2.5} aria-hidden />Need workers
        </Link>

        {/* THE MOSAIC. The money and the work used to be two stacks of full-width cards under a heading —
            four cards, four identical shapes, and nothing among them looking more important than the next.
            They interlock now: "Still to pay" is the tall one, because it is the only figure here with a
            person waiting at the other end of it, and the invoice and the shortlist stack beside it.
            It drops to a plain 1x1 when there is no shortlist to stack, so the grid never has a hole. */}
        <div className="bento">
          {/* Ink means press me everywhere else in the app, so an ink cell always goes somewhere. */}
          {t.owed
            ? <BigMoney n={t.owed.dollars} rows={t.near ? 2 : 1}
                tone={t.owed.dollars > 0 ? "ink" : "white"} href="/boss/pay"
                label="Still to pay" sr={t.owed.sr}
                sub={t.owed.dollars === 0 ? "Everyone is square."
                  : t.owed.oldest == null ? `${t.owed.workers} waiting`
                  : `${t.owed.workers} waiting · oldest ${t.owed.oldest} ${t.owed.oldest === 1 ? "day" : "days"}`} />
            : <Cell rows={t.near ? 2 : 1} label="Still to pay"
                sub={<span className="c-prose">Couldn&apos;t check just now.</span>} />}

          {t.invoice?.kind === "open"
            ? <BigMoney n={t.invoice.dollars} href="/boss/money" sr={t.invoice.sr}
                tone={t.invoice.days <= 3 ? "soft" : "white"} label="Next invoice"
                sub={`due ${fmtDay(t.invoice.dueDay)}${t.invoice.more ? ` + ${t.invoice.more} more` : ""}`} />
            : t.invoice?.kind === "building"
            ? <BigMoney n={t.invoice.dollars} href="/boss/money" sr={t.invoice.sr}
                label="Next invoice" sub={`${t.invoice.matches} so far this fortnight`} />
            : <Cell label="Next invoice"
                sub={<span className="c-prose">{t.invoice ? "No introductions this fortnight." : "Couldn't check just now."}</span>} />}

          {/* Counts and a histogram, never a worker row: a boss may not browse people he has not booked.
              A 1x1 holds the count and the site; lib/bossToday's whole sentence — ready, already booked,
              wrong cards, too far — is the tile's spoken version, which is where the prose belongs. */}
          {t.near && (
            <Cell tone={t.near.ready === 0 ? "soft" : "white"} href={`/boss/shifts/${t.near.shiftId}`}
              label={t.near.ready === 0 ? "Nobody near this job" : `${t.near.ready} could take it`}
              sub={<span className="c-prose truncate block">{t.near.site}</span>}
              sr={`${t.near.ready === 0 ? "Nobody near this job." : `${t.near.ready} could take it.`} ${t.near.sentence} Opens the job.`} />
          )}

          {t.crew && (
            <Cell span={2} href={`/boss/shifts/new?project=${firstSite.id}`} label="Same crew again"
              sub={<span className="c-prose">{t.crew.site} · {fmtTime(t.crew.start)} start</span>}>
              <div className="flex items-center gap-2 min-w-0">
                {t.crew.people.map((p) => <Avatar key={p.bookingId} name={p.name} photo={p.photo} size={40} />)}
                {t.crew.more > 0 && <span className="c-sub num shrink-0">+{t.crew.more}</span>}
              </div>
            </Cell>
          )}
        </div>

        {/* Everything else that is live. Plain rows: five orange-bordered cells would be the old flattening
            one level down, and the whole point of ranking was to stop saying "all of this, equally, now". */}
        {demoted.length > 0 && (
          <>
            <Section title="Also waiting" hint="None of it is today." />
            <div className="space-y-2">
              {demoted.map((d) => (
                <Row key={d.key} href={d.href ?? undefined} title={d.label}
                  sub={<><b className="text-ink num">{d.figure}</b> · {d.sub}</>} />
              ))}
            </div>
          </>
        )}

        {/* The jobs themselves, below the ranking and quiet — the one thing worth colour is already at the
            top. /boss/week (spec 2.3) is now built and is where the same jobs are laid out day by day with
            the short ones marked; this stays as the list of what is next, with a way through to it. */}
        {t.shifts === null ? (
          <Section title="Coming up" hint="We couldn&apos;t load your jobs just now. Pull to refresh." />
        ) : t.shifts.length > 0 ? (
          <>
            <Section title="Coming up" hint="Tap one to see who is on it." />
            <div className="space-y-2">
              {groupByPost(t.shifts).map(({ key, lines }) => {
                const s = lines[0];
                const when = fmtDay(s.day);
                if (lines.length === 1) {
                  return (
                    <Row key={key} href={`/boss/shifts/${s.id}`} title={`${when} · ${fmtTime(s.start_time)}`}
                      sub={<>{s.site} · {s.spots} × {s.role}<br />
                        <Flag tone={full(s) ? "green" : "grey"} className="mt-1 align-middle">
                          {full(s) ? "All spots taken" : fillWords(s.taken, s.spots)}
                        </Flag>
                        {s.names && <span className="ml-1.5 align-middle">{s.names} booked</span>}</>} />
                  );
                }
                return (
                  <JobCard key={key} title={`${when} · ${fmtTime(s.start_time)} · ${Number(s.hours)}h`} sub={s.site}
                    tone={lines.every(full) ? "green" : undefined}
                    lines={lines.map((l) => ({
                      id: l.id, title: `${l.spots} × ${l.role}`, tone: full(l) ? "green" : undefined,
                      sub: <>{l.names ? `${l.names} · ` : ""}{fillWords(l.taken, l.spots)}</>,
                    }))} />
                );
              })}
            </div>
            {/* A labelled way in to the calendar. The fortnight, day by day, with the short days marked —
                this list only says what is next, and never which day has a hole in it. */}
            <Link href="/boss/week" className="btn-ghost">
              <CalendarDays size={20} strokeWidth={2.5} aria-hidden />The fortnight, day by day
            </Link>
          </>
        ) : null}

        <Section title="Your sites" hint="Tap a site to post a job there or see its history." />
        <div className="space-y-2">
          {t.projects.map((p) => (
            <Row key={p.id} href={`/boss/projects/${p.id}`} title={p.name}
              sub={<span className="flex items-center gap-1.5">
                <MapPin size={16} strokeWidth={2.25} aria-hidden className="shrink-0" />{p.address || "No address"}
              </span>}
              right={<span className="text-steel text-sm">{p.upcoming} coming up</span>} />
          ))}
        </div>
        <Link href="/boss/projects/new" className="btn-ghost">
          <Plus size={20} strokeWidth={2.5} aria-hidden />Add another site
        </Link>

        {/* Said out loud, at the bottom, in lib/bossToday's own words. A screen that quietly drops a number
            it could not fetch is a screen that lies by omission. */}
        {t.couldNotCheck.length > 0 && (
          <p className="text-steel text-base">Couldn&apos;t check {t.couldNotCheck.join(", ")} just now.</p>
        )}
      </Page>
    </>
  );
}
