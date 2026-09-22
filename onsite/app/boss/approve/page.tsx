import { Check } from "lucide-react";
import { requireRole } from "@/lib/session";
import { sql } from "@/lib/db";
import { Header, Page } from "@/components/Header";
import { Cell } from "@/components/ui";
import { ApproveBoard, type ApproveDay, type ApproveLine } from "@/components/ApproveRow";
import { approveQueue, MAX_APPROVE_HOURS, type QueueLine } from "@/lib/approveQueue";
import { matchFeeCents, priceWords } from "@/lib/subscription";
import type { OtTerms } from "@/lib/rules";
import { fmtDay, fmtTime } from "@/lib/util";
export const dynamic = "force-dynamic";

/**
 * Approve hours. Everyone who has clocked out, across every site, on one screen.
 *
 * The screen it replaces is the per-job form in app/boss/shifts/[id]/page.tsx: to pay six people the boss
 * opened six jobs, scrolled past six status blocks and posted six forms, so the hours sat there another
 * day. A day of waiting is a day of not trusting, and it is the same worker who turns the next job down.
 *
 * This file stays a Server Component and hands the whole queue down: only the steppers need a browser, and
 * lib/approveQueue.ts opens the database. There is no tab for this — it is reached from the hero on /boss
 * and from the badge, because it is somewhere you go when something is waiting, not a place you browse.
 *
 * THE SHAPE, SO NOBODY "FIXES" IT INTO A GRID. This screen is one 2x2 and then rows, in all three states:
 *
 *   - the queue's own 2x2 — hours, dollars, workers, sites, oldest — is drawn by components/ApproveRow's
 *     `ApproveBoard`, not here, because every figure in it is recomputed on the client as a stepper moves
 *     and a server-rendered copy of it would be a second, staler total sitting next to the live one;
 *   - the two states this file does own, a failed queue and an empty one, are the same 2x2 in its place;
 *   - a worker's line stays a ROW. It carries a 56x56 stepper either side of the hours and a 56px approve
 *     button, which is 168px of target on one line before a name or a site has been drawn. There is no
 *     tile shape that holds that without putting a control under the 44px floor, and the hours on that
 *     row are what somebody gets paid.
 *
 * ORANGE IS SPENT ON THE QUEUE TILE, inside ApproveBoard, and there is none anywhere else on the screen —
 * not on a row, not on a rained-off note. One per screen, and this screen's one is the pile of hours.
 *
 * IT SAYS SO WHEN IT CANNOT CHECK. approveQueue() throws rather than answering with an empty list, and
 * "Nothing waiting on you" is an assertion of absence that a failed query has not earned. A boss who reads
 * green here puts the phone down, and the crew is still unpaid on Monday. So the catch below draws white
 * and says we could not reach it (the same fail-white rule as components/HeroCell.tsx and lib/rank.ts).
 */
export default async function Approve() {
  const u = await requireRole("boss");
  const q = await queue(u.id).catch(() => null);

  return (
    <>
      <Header title="Approve hours" back="/boss" />
      <Page>
        {!q ? (
          <div className="bento">
            <Cell span={2} rows={2}>
              <div className="min-w-0">
                <div className="c-label">We couldn&apos;t check just now</div>
                <div className="c-sub">Nothing here is a statement about anyone&apos;s hours — we just
                  couldn&apos;t reach them. Nobody has been approved or missed.</div>
              </div>
              {/* A plain anchor, not a Link: this has to ask the server again, and the client router would
                  be within its rights to hand back the very page that failed. */}
              <div className="cell-bar"><a href="/boss/approve" className="cell-act">Retry</a></div>
            </Cell>
          </div>
        ) : q.days.length === 0 ? (
          <div className="bento">
            <Cell span={2} rows={2} tone="go">
              <div className="min-w-0">
                <div className="c-label flex items-start gap-2">
                  <Check size={24} strokeWidth={2.5} aria-hidden className="shrink-0" />
                  <span className="min-w-0">Nothing waiting on you.</span>
                </div>
                <div className="c-sub">When someone clocks out, their hours land here.</div>
              </div>
            </Cell>
          </div>
        ) : (
          <ApproveBoard days={q.days} max={MAX_APPROVE_HOURS} feeWords={priceWords(matchFeeCents())} />
        )}

        {/* Never silently short. A row that dropped out between the two statements below is a booking that
            changed under us, and a queue quietly one shorter than it should be is the pay dispute this
            screen exists to end. */}
        {q && q.dropped > 0 && (
          <p className="text-steel text-base">
            {q.dropped === 1 ? "One booking" : `${q.dropped} bookings`} changed while this screen loaded.
            Refresh to see {q.dropped === 1 ? "it" : "them"}.
          </p>
        )}
      </Page>
    </>
  );
}

/** The overtime terms every line has to be priced under, which lib/approveQueue's QueueLine does not carry. */
type TermsRow = {
  booking_id: string;
  ot_mode: OtTerms["ot_mode"] | null;
  ot_after_hours: number | string | null;
  ot_multiplier: number | string | null;
};

/**
 * The queue, plus the terms the browser needs to re-price a line as its stepper moves.
 *
 * WHY A SECOND STATEMENT. QueueLine carries one `gross`, priced at the hours it was pre-filled with, and
 * the moment a stepper moves that figure is stale. The browser cannot re-derive it from the rate — first
 * eight hours at rate, then time and a half is not a multiplication — so it needs the shift's own
 * ot_mode / ot_after_hours / ot_multiplier and payForShift(), exactly as actions/boss.ts approveMany will
 * price it when it writes. The alternative was to multiply rate by hours on the client, which silently
 * drops every overtime hour out of the biggest number on the screen.
 *
 * Its WHERE is the WHERE approveQueue uses, so the two see the same bookings; there is no date arithmetic
 * in it at all, and so nothing for the pooler's GMT session to misdate. A booking that answers one
 * statement and not the other changed in between — it is counted and said out loud rather than dropped
 * quietly, because approveMany would refuse it anyway and a row the boss cannot act on is worse than a
 * line of type telling him to refresh.
 */
async function queue(bossId: string): Promise<{ days: ApproveDay[]; dropped: number }> {
  const [q, terms] = await Promise.all([
    approveQueue(bossId),
    sql<TermsRow[]>`
      SELECT b.id AS booking_id, s.ot_mode, s.ot_after_hours, s.ot_multiplier
      FROM bookings b
      JOIN shifts s ON s.id = b.shift_id
      WHERE s.boss_id = ${bossId} AND b.status = 'clocked_out'`,
  ]);

  const byBooking = new Map<string, OtTerms>(terms.map((t) => [t.booking_id, {
    ot_mode: t.ot_mode ?? "award",
    ot_after_hours: t.ot_after_hours ?? 8,
    ot_multiplier: t.ot_multiplier,
  }]));

  // One rained-off note per shift, on the first of its rows, wherever that row falls. Everyone sent home
  // off the same slab shares one explanation; one above each of their rows would be the same sentence four
  // times and the boss would stop reading it on the second.
  const explained = new Set<string>();
  const days: ApproveDay[] = [];
  let dropped = 0;

  for (const d of q.days) {
    const lines: ApproveLine[] = [];
    for (const l of d.lines) {
      const t = byBooking.get(l.bookingId);
      if (!t) { dropped++; continue; }
      const rain = l.weatherStop && !explained.has(l.shiftId);
      if (rain) explained.add(l.shiftId);
      lines.push(view(l, t, rain ? `${l.site} · ${l.payReason ?? "Weather stopped work"}` : null));
    }
    if (lines.length) days.push({ day: d.day, heading: d.heading, lines });
  }
  return { days, dropped };
}

/** A queue line as the screen needs it: the day and the clock resolved here, the money left to payForShift. */
function view(l: QueueLine, terms: OtTerms, rainNote: string | null) {
  return {
    bookingId: l.bookingId,
    workerId: l.workerId,
    name: l.name,
    photo: l.photo,
    site: l.site,
    // Built here rather than in the browser: `day` is the site's own calendar day and `tzWords` is only
    // present when that site's clock is not the app's, so a Perth 6:30 start says "Perth time" and a
    // Sydney one is not made to carry a zone nobody needed to be told.
    where: `${l.site} · ${fmtDay(l.day)} · ${fmtTime(l.start)}${l.tzWords ? ` (${l.tzWords})` : ""}`,
    worked: l.worked,
    hours: l.hours,
    rate: l.rate,
    terms,
    waitingHours: l.waitingHours,
    waitingWords: l.waitingWords,
    unbilledIntroduction: l.unbilledIntroduction,
    weatherStop: l.weatherStop,
    weatherWhy: l.weatherWhy,
    payReason: l.payReason,
    rainNote,
  };
}
