import Link from "next/link";
import { UserPlus } from "lucide-react";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { Avatar, Cell, Section } from "@/components/ui";
import { Pips } from "@/components/cells";
import { InvitedCrew, type InviteRow } from "./InvitedCrew";
import { money } from "@/lib/award";
import { crewJoinUrl } from "@/lib/crew";
import { crewBoard, CARD_HORIZON_DAYS, type CrewMember } from "@/lib/crewBoard";
import { SMALL_N, share } from "@/lib/profileStats";
export const dynamic = "force-dynamic";

/**
 * CREW — the two things a boss cannot keep in his head about his own people.
 *
 * It was a list of names, a rate and "60 hours with you". Hours are the figure a boss already knows; the
 * two he does not are whether somebody has ever left him a man short, and whether a ticket has run out.
 * Both were already in the database and neither was on the screen — the query even SELECTed `w.tickets`
 * and dropped it on the floor, so an expired card could only be found by opening every worker in turn.
 *
 * THE SHAPE. Seven full-width cards down a page, then a list of four-line rows. It is a mosaic now:
 *
 *    2x2  Who actually turns up — the figure at 48px, because it is the answer the screen exists for
 *    2x1  Cards — a date, never a verdict
 *    1x1  one PERSON TILE per crew member: a face, a first name, and their turn-up figure
 *
 * A PERSON IS A TILE, NOT A ROW. The rate, the hours, the turn-up sentence and every card badge used to
 * sit in one four-line row, which meant eight crew members were eight screens of scrolling and none of
 * them was comparable with the next. A tile is a face and one figure, so a grid of them is read the way a
 * boss actually reads his crew — all at once, looking for the low one. Everything the row said is in the
 * tile's `sr` sentence, word for word, and the one thing that cannot wait — a card that has ALREADY run
 * out — takes the tile's sub line off the turn-up figure, because a dead ticket outranks a statistic.
 *
 * NO ORANGE ON THIS SCREEN, AND THAT IS A DECISION. `tone="soft"` appears in exactly one condition: a card
 * that has ALREADY run out, under somebody who is on a shift the boss has already booked. A White Card
 * that expires in six weeks is real and is drawn white with its date in words, because spending the
 * screen's one warm tone on a renewal that is a month and a half away is how a colour stops meaning
 * anything. lib/crewBoard.ts decides that, not this file.
 *
 * THE CARDS ARE THE WORKER'S WORD, AND THE SCREEN SAYS SO. There is no national White Card register — see
 * lib/verify.ts — so most cards sit unchecked forever and a screen that drew unchecked as a fault would be
 * warm for most of the country on day one. Every badge's words come from `licenceWords()` through
 * lib/crewBoard, never from here, so a card cannot read one way on this list and another on the worker's
 * own page. Card numbers and visa types are not selected by `licencesForBoss()`, so they cannot reach the
 * payload this page ships to a phone.
 *
 * EVERY FIGURE IS COUNTED IN lib/crewBoard.ts AND NULL WHEN IT COULD NOT BE. Nothing here counts anything,
 * and nothing here turns a failed statement into a zero: on a tile "no cards expiring" and "the licence
 * query timed out" are the same six pixels and opposite facts.
 */
export default async function Crew({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const u = await requireRole("boss");
  const { tab = "casual" } = await searchParams;
  const [board, invites, [me]] = await Promise.all([
    crewBoard(u.id),
    // Numbers this boss typed in. Scoped to them and shown nowhere else — no other boss ever sees them.
    sql<InviteRow[]>`
      SELECT id, phone, name, invited_at FROM crew_invites
      WHERE boss_id = ${u.id} AND joined_at IS NULL AND expires_at > now() ORDER BY invited_at DESC`,
    sql<{ company: string; invite_code: string | null }[]>`SELECT company, invite_code FROM bosses WHERE user_id = ${u.id}`,
  ]);
  const crew = board.crew;
  const list = crew?.filter((c) => c.type === tab) ?? [];
  const t = board.turnUp;
  const cards = board.cards;
  const base = (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const link = base && me?.invite_code ? crewJoinUrl(base, me.invite_code) : null;

  return (
    <>
      {/* The tab says Crew. It said "My workers" here, which is the same people under a second name. */}
      <Header title="Crew" />
      <Page>
        {crew && crew.length > 0 && (
          <div className="bento">
            {/* WHO ACTUALLY TURNS UP — this boss's own bookings, all time, rained-off days out.
                No percentage under five shifts: a 3-of-4 arc *is* the 75% claim whatever the caption says,
                and a boss talked out of booking somebody on three data points is the concrete harm. */}
            {t == null ? (
              <Cell span={2} rows={2} label="Who actually turns up"
                sub={<span className="c-prose">Couldn&apos;t check just now.</span>} />
            ) : t.shifts === 0 ? (
              <Cell span={2} rows={2} label="Who actually turns up"
                sub={<span className="c-prose">{t.sentence}</span>} sr={t.sr} />
            ) : t.small ? (
              <Cell span={2} rows={2} label="Who actually turns up" sub={t.sentence} sr={t.sr}>
                <Pips n={t.showed} of={t.shifts} />
              </Cell>
            ) : (
              // 48px, not 34px. This is the one number the screen was built to answer and it is read from
              // arm's length, one-handed, at the gate.
              <Cell span={2} rows={2} label="Who actually turns up" sub={t.sentence} sr={t.sr}>
                <div className="c-hero flex items-baseline gap-2 min-w-0">
                  <span className="truncate">{Math.round((100 * t.showed) / t.shifts)}%</span>
                  <span className="c-unit shrink-0">of the time</span>
                </div>
              </Cell>
            )}

            {/* CARDS — a date, never a verdict on the worker. It links to whoever is worst off, because the
                card block that can actually be read in full lives on their page. */}
            {cards == null ? (
              <Cell span={2} label="Cards"
                sub={<span className="c-prose">Couldn&apos;t check just now.</span>} />
            ) : cards.due.length === 0 ? (
              <Cell span={2} label={cards.onFile === 0 ? "No cards on file" : `Cards · next ${CARD_HORIZON_DAYS} days`}
                sub={<span className="c-prose">{cards.sentence}</span>} sr={cards.sr} />
            ) : (
              <Cell span={2} tone={cards.liveRisk ? "soft" : "white"}
                href={`/boss/workers/${cards.due[0].workerId}`}
                label={cards.expired > 0 ? "Cards out of date" : "Cards expiring"}
                sub={<><b className="num">{cards.due.length}</b> · {cards.sentence}</>} sr={cards.sr} />
            )}
          </div>
        )}

        <Link href="/boss/workers/add" className="btn-dark flex items-center justify-center gap-2">
          <UserPlus size={22} strokeWidth={2.25} aria-hidden />Add your crew
        </Link>

        {crew == null ? (
          <Empty>We couldn&apos;t load your crew just now. Pull to refresh.</Empty>
        ) : (
          <>
            <div className="seg grid-cols-2">
              {[["fulltime", "Full-time"], ["casual", "Casual"]].map(([k, l]) => (
                <Link key={k} href={`/boss/workers?tab=${k}`} className={`seg-item ${tab === k ? "seg-on" : ""}`}>{l} · {crew.filter((c) => c.type === k).length}</Link>
              ))}
            </div>

            {list.length === 0 ? <Empty>{tab === "casual" ? "Add your crew above, or approve someone's hours and they land here." : "Open a worker and switch them to Full-time."}</Empty> : (
              <>
                {/* Said once, above the grid, rather than on every tile: what a figure is, and what the
                    dates on the cards do and do not mean. Without it a tile reads as OnSite's verdict. */}
                <p className="text-steel text-base">
                  They see their own turn-up figures too. Cards are what the worker entered — there is no
                  national White Card register, so what we can show you is the date they gave, never a check
                  of it. Tap anyone for their rate, their hours and every card they hold.
                </p>
                {/* An odd crew member out is left in a half-width slot with the row unfinished beside him,
                    the way any grid of faces ends. He is NOT widened to close the row: a person tile at
                    double width reads as the featured one, and the only thing that picked him was being
                    last in the list. (The money screen widens its odd tile out, because the things in
                    that grid are different objects and a lone small one there reads as broken.) */}
                <div className="bento">
                  {list.map((c) => <PersonTile key={c.id} c={c} />)}
                </div>
              </>
            )}
          </>
        )}

        {invites.length > 0 && (
          <>
            <Section title={`Invited · ${invites.length}`} hint="Waiting to sign up. Only you can see these numbers." />
            <InvitedCrew invites={invites} link={link} company={me?.company ?? ""} firstName={(u.name ?? "").split(" ")[0]} />
          </>
        )}

        {/* Said out loud, at the bottom, the way /boss says it. A screen that quietly drops a number it
            could not fetch is a screen that lies by omission. */}
        {crew != null && board.couldNotCheck.length > 0 && (
          <p className="text-steel text-base">Couldn&apos;t check {board.couldNotCheck.join(", ")} just now.</p>
        )}
      </Page>
    </>
  );
}

/**
 * ONE PERSON, ONE TILE: a face, a first name, and how often they turn up for this boss.
 *
 * The figure obeys the same floor as every other count in the app — `share()` carries it — so five shifts
 * or more is a percentage and anything under is drawn as `Pips`, one dot per actual shift. A 3-of-4 arc
 * *is* the 75% claim however it is captioned, and a boss talked out of booking somebody on three data
 * points is the concrete harm here. No record at all is an em dash, never a 0%.
 *
 * WHAT THE TILE DROPS IT STILL SAYS. The rate, the hours, the full turn-up sentence and every card the
 * worker holds are in `sr`, in lib/crewBoard's own words. The tile is the way in; the worker's own page is
 * where a card can be read in full.
 */
function PersonTile({ c }: { c: CrewMember }) {
  const first = c.name.split(" ")[0] || c.name;
  const r = c.record;

  // Written out rather than picked with a boolean, so the narrowing is the code's own and `r.showed`
  // cannot be read off a record that is null.
  const figure = r == null || r.shifts === 0
    ? <div className="c-fig truncate">—</div>
    : r.shifts < SMALL_N
      ? <Pips n={r.showed} of={r.shifts} />
      : <div className="c-fig truncate">{share(r.showed, r.shifts)}</div>;

  // Spoken in full, so nothing the row used to carry is lost — rate, hours, record, cards.
  const cardWords = c.cards == null ? "We couldn't check their cards just now."
    : c.cards.length === 0 ? "No cards on file — ask to see them on site."
    : `Cards: ${c.cards.map((k) => k.flag).join("; ")}.`;
  const sr = [
    `${c.name}.`,
    `${c.turnsUp}.`,
    c.rate == null ? "No rate set yet." : `${money(c.rate)} an hour.`,
    c.hours > 0 ? `${c.hours} hours with you.` : "",
    cardWords,
    "Opens their page.",
  ].filter(Boolean).join(" ");

  // A card that has already run out takes the one sub line off the turn-up figure. Full ink rather than
  // the quiet prose colour, because it is the only thing on this tile a boss may have to act on today.
  const dead = c.cards?.find((k) => k.state === "expired") ?? null;
  const sub = dead
    ? <span className="line-clamp-2">{dead.flag}</span>
    : <span className="c-prose line-clamp-2">{
        r == null ? "Couldn't check their record"
          : r.shifts === 0 ? "No shifts with you yet"
            : `${share(r.showed, r.shifts)} of ${r.shifts === 1 ? "1 shift" : `${r.shifts} shifts`} with you`
      }</span>;

  return (
    <Cell href={`/boss/workers/${c.id}`} sr={sr} label={first} sub={sub}>
      <Avatar name={c.name} size={40} />
      {figure}
    </Cell>
  );
}
