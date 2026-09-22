import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { BigMoney, Cell, Flag, Row, Say, Section, Viz } from "@/components/ui";
import { SegmentBar, SiteBars } from "@/components/cells";
import { money, SUPER_RATE } from "@/lib/award";
import { fmtBillingDay, moneyCents } from "@/lib/subscription";
import {
  fortnightMoney, introWords, readBack, readDay,
  type FortnightMoney, type FortnightRun, type WorkerRun,
} from "@/lib/fortnight";
import { markPaidMany } from "@/actions/boss";
import { PaidToggle } from "../pay/PaidToggle";
export const dynamic = "force-dynamic";

/**
 * The money screen: what the boss owes his workers and what he owes OnSite, on ONE fortnight window.
 *
 * /boss/pay is week-locked and /boss/billing is a different screen, so reconciling a $34 invoice against
 * a fortnight of wages meant paging Last week / Next week and adding two weeks up in the head. Both are
 * still there and still work; this is the screen that puts them on the same fourteen days (lib/fortnight).
 *
 * THE SHAPE. This was twelve full-width cards stacked down a page — a .bento with nothing but 2-wide
 * tiles in it, which is the stack it was supposed to replace. It is a mosaic now, and size is the
 * hierarchy:
 *
 *    2x2  Still to pay — ink, and the way down to the run
 *    2x1  The whole fortnight — the SegmentBar IS the tile
 *    1x1  Wages   1x1 Super
 *    1x1  OnSite fee   1x1 per open invoice
 *    2x2  Spend by site — SiteBars at the size it was drawn for
 *
 * A 1x1 holds a figure, two or three words and a short sub. Every sentence those tiles used to carry is
 * now in the tile's `sr` line or in the Section heading, which is where prose belongs.
 *
 * THE PAY RUN IS NOT IN THE GRID. A row with a Paid toggle in it is a row: two targets side by side, a
 * name, a dispute badge and up to four lines of explanation. Squeezing that into a tile would either
 * shrink the toggle under the 44px floor or blow the tile's height — so the run is a list under its own
 * heading, and the hero links down to it.
 *
 * There is no gate on this screen. The subscription is gone — billing is $2 an introduction, invoiced
 * every fortnight — so nothing in the app is switched off for not paying and there is no `payToolsAllowed`
 * check standing between a boss and the list of people he owes money to.
 *
 * ORANGE IS SPENT ONCE, ON ONE INVOICE. `.cell-needs` means "this needs you, now", and the budget is one
 * per screen. Here it goes to the most urgent open invoice that is overdue or inside three days
 * (lib/rank.ts INVOICE_SOON_DAYS) — the only thing on the screen with a deadline attached to it. The
 * hero is ink instead, even when thousands are owed, because "still to pay" is a standing state rather
 * than a thing that expires tonight; and a disputed shift is drawn as an ink flag, not an orange one,
 * because /boss already ranks a disagreement above an invoice and sends the boss off to ring the worker.
 * Two oranges on one screen and neither of them means it.
 */
export default async function Money({ searchParams }: { searchParams: Promise<{ back?: string; on?: string }> }) {
  const u = await requireRole("boss");
  const sp = await searchParams;
  const m = await fortnightMoney(u.id, { back: readBack(sp.back), on: readDay(sp.on) });
  const { window: w, run, invoices } = m;
  // The one orange, if anything has earned it: invoices come back oldest-due first, so the first one
  // that is overdue or nearly due is the most urgent one there is.
  const alarm = invoices?.find((i) => i.soon)?.id ?? null;
  const small = smallTiles(m, alarm);
  const split = run ? run.split.paid + run.split.approved + run.split.waiting : 0;

  return (
    <>
      <Header title="Money" back="/boss" />
      <Page>
        {/* The window, as the screen's own heading. It used to be a centred pair of lines above the grid,
            which is a caption; at 22/700 it is the thing every figure below is counted over. */}
        <Section title={w.label}
          hint={`${fmtBillingDay(w.from + "T00:00:00Z")} – ${fmtBillingDay(w.to + "T00:00:00Z")}`} />

        {m.couldNotCheck.length > 0 && (
          <Say tone="grey" icon={null} title="We couldn't check everything just now"
            sub={`Missing: ${m.couldNotCheck.join(", ")}. Nothing here is a statement about your money — we just couldn't reach some of the numbers.`} />
        )}

        <div className="bento">
          <Hero run={run} />

          {/* The bar is the tile, not a footnote under one. `viz` puts the label on top and gives the
              drawing every pixel underneath. No `sr` on the cell: SegmentBar carries its own sentence,
              and a cell-level `sr` would hide the legend — which is real text — from a screen reader. */}
          {run && split > 0 && (
            <Viz span={2} rows={1} label="The whole fortnight">
              <SegmentBar
                segments={[
                  { label: "Paid", dollars: run.split.paid, tone: "paid" },
                  { label: "Approved, not paid yet", dollars: run.split.approved, tone: "owed" },
                  { label: "Still to approve", dollars: run.split.waiting, tone: "unapproved" },
                ]}
                sr={`${money(run.split.paid)} already paid. ${money(run.split.approved)} approved and not paid yet. `
                  + `${money(run.split.waiting)} still to approve, from ${run.split.waitingHours} hours across `
                  + `${run.split.waitingWorkers} workers.`} />
            </Viz>
          )}

          {/* An odd tile out widens rather than leaving a hole in the row. Two open invoices, or none, or a
              fortnight where the pay run failed and the fee did not — the grid closes up either way. */}
          {small.map((tile, i) => tile(i === small.length - 1 && small.length % 2 === 1 ? 2 : 1))}

          {run && run.sites.length > 0 && (
            <Viz span={2} rows={2} label="Spend by site">
              <SiteBars rows={run.sites}
                sr={`Wages by site, ${w.from} to ${w.to}. ${run.sites.map((s) => `${s.name}: ${money(s.dollars)}`).join(". ")}.`} />
            </Viz>
          )}
        </div>

        {run && run.workers.length > 0 && (
          // scroll-mt clears the 56px pushed-screen bar, so the hero's jump lands on the heading and not
          // under it. The id is what `href="#run"` on the hero is aiming at.
          <section id="run" className="space-y-2 scroll-mt-20">
            <Section title="The pay run"
              hint="Everyone you owe this fortnight. Mark them paid as you go — they see it straight away." />
            {run.workers.map((r) => <WorkerRow key={r.workerId} r={r} />)}
          </section>
        )}

        <p className="text-steel">
          Each day is paid on the overtime terms you agreed when you posted that shift. Super {SUPER_RATE * 100}% is on
          top of every wage figure here, and it is not part of what you owe the worker.
        </p>

        <Period back={w.back} on={readDay(sp.on)} current={w.isCurrent} from={w.from} />

        {/* Rows, not links inside a sentence. Both of these were 18px tall — a target you hit with a
            fingertip and miss with a work glove, which is the hand this app is actually used with. The
            inline-link exemption in the sizing guidance assumes neither of those things. */}
        <div className="space-y-2">
          <Row href="/boss/billing" title="Every invoice" sub="Including the ones you have already paid." />
          <Row href="/terms" title="The rules" sub="Every fee on this screen, in plain words." />
        </div>
      </Page>
    </>
  );
}

/* ───────────────────────────────────────────────────────────────────────── the hero */

/**
 * Still to pay. 2x2, ink, and the whole cell is the way down to the rows it summarises.
 *
 * The three-state bar used to live inside this cell's `sub`. It is its own 2x1 now: a drawing wedged
 * under a 48px figure is a footnote, and the hero reads as one figure and one sentence without it.
 *
 * FAIL WHITE, NEVER FAIL GREEN. A pay run that did not load renders white and says we could not check.
 * It never degrades into "Nothing to pay this fortnight", because that sentence sends the boss away from
 * the screen and four people are still unpaid on Friday.
 */
function Hero({ run }: { run: FortnightRun | null }) {
  if (!run) {
    return (
      <Cell span={2} rows={2}>
        <div className="min-w-0">
          <div className="c-label">We couldn&rsquo;t check just now</div>
          <div className="c-sub c-prose">Nothing here is a statement about what you owe — we just couldn&rsquo;t
            reach the pay run.</div>
        </div>
        {/* A plain anchor, not a Link: this has to ask the server again, and the client router would be
            within its rights to hand back the very page that failed. */}
        <div className="cell-bar"><a href="/boss/money" className="cell-act">Retry</a></div>
      </Cell>
    );
  }

  // Nothing worked, or nothing was approved: a real sentence, not a $0.00 tile. A money figure of zero
  // read at arm's length in the sun is read as a broken query, not as good news.
  if (run.shifts === 0) {
    return (
      <Cell span={2} rows={2} sr={run.sr + (run.split.waiting > 0
        ? ` ${money(run.split.waiting)} of hours is waiting on your approval.` : "")}>
        <div className="min-w-0">
          <div className="c-label">Nothing to pay this fortnight.</div>
          <div className="c-sub c-prose">
            {run.split.waiting > 0
              ? `${run.split.waitingHours} hours are clocked out and waiting on your approval. They land here once you have said yes.`
              : "No approved hours between these dates."}
          </div>
        </div>
      </Cell>
    );
  }

  // Everyone square. Green, and it says so in words as well as in colour.
  if (run.totals.owed <= 0) {
    return (
      <BigMoney span={2} rows={2} tone="go" hero n={run.totals.wages} label="Wages this fortnight — all paid"
        sr={run.sr}
        sub={`${run.shifts === 1 ? "1 shift" : `${run.shifts} shifts`}, everyone square.`} />
    );
  }

  return (
    <BigMoney span={2} rows={2} tone="ink" hero href="#run" n={run.totals.owed} label="Still to pay"
      sr={run.sr + " Opens the pay run."}
      sub={`${run.unpaidShifts === 1 ? "1 shift" : `${run.unpaidShifts} shifts`} · `
        + `${run.unpaidWorkers === 1 ? "1 worker" : `${run.unpaidWorkers} workers`}`
        + (run.oldest ? ` · oldest waiting ${run.oldest === 1 ? "1 day" : `${run.oldest} days`}` : "")} />
  );
}

/* ────────────────────────────────────────────────────────────────────── the small tiles */

/** A tile that can be asked to widen, so the grid never ends a row with a hole in it. */
type Tile = (span: 1 | 2) => React.ReactNode;

/**
 * Wages, super, OnSite's fee, and one tile per open invoice.
 *
 * These were three full-width cards, one of them a three-row table under a "what this fortnight cost"
 * heading. Three figures are three figures; the heading was the only thing making them a table. They are
 * deliberately still NOT added up — wages and super are dollars out of payForShift(), the OnSite line is
 * cents out of lib/subscription, and summing a cents figure into a dollars one is precisely how commit
 * 8f912ee printed $3,300.00 for a $33 charge.
 */
function smallTiles(m: FortnightMoney, alarm: string | null): Tile[] {
  const { run, introductions: intro, invoices } = m;
  const t: Tile[] = [];

  if (run) {
    t.push((span) => (
      <BigMoney key="wages" span={span} n={run.totals.wages} label="Wages"
        sub={<span className="c-prose">{run.shifts === 1 ? "1 shift" : `${run.shifts} shifts`}</span>}
        sr={`Wages this fortnight: ${money(run.totals.wages)}, across ${run.shifts === 1 ? "1 shift" : `${run.shifts} shifts`}.`} />
    ));
    t.push((span) => (
      <BigMoney key="super" span={span} n={run.totals.superAmt} label="Super"
        sub={<span className="c-prose">{SUPER_RATE * 100}% on top</span>}
        sr={`Super: ${money(run.totals.superAmt)}, ${SUPER_RATE * 100}% on top of those wages. It is not part of what you owe the worker.`} />
    ));
  } else {
    t.push((span) => (
      <Cell key="wages" span={span} label="Wages and super"
        sub={<span className="c-prose">Couldn&rsquo;t check just now.</span>} />
    ));
  }

  // OnSite's own fee. Never a $0.00 tile: a zero money figure read in the sun is read as a broken query,
  // so a fortnight with no introductions in it says that in words instead.
  t.push((span) => !intro ? (
    <Cell key="fee" span={span} label="OnSite fee"
      sub={<span className="c-prose">Couldn&rsquo;t count just now.</span>} />
  ) : intro.n === 0 ? (
    <Cell key="fee" span={span} label="No introductions"
      sub={<span className="c-prose">Nothing to pay OnSite.</span>}
      sr="No introductions this fortnight, so there is nothing to pay OnSite. You are charged when OnSite finds you someone new and you approve their first shift. Your own crew is never an introduction." />
  ) : (
    <Cell key="fee" span={span} label="OnSite fee"
      sub={<span className="c-prose">{introWords(intro.n, intro.feeCents)}</span>}
      sr={`OnSite's fee this fortnight: ${moneyCents(intro.cents)}, ${introWords(intro.n, intro.feeCents).toLowerCase()}. Your own crew is never an introduction.`}>
      <div className="c-fig truncate">{moneyCents(intro.cents)}</div>
    </Cell>
  ));

  if (invoices === null) {
    t.push((span) => (
      <Cell key="inv" span={span} label="Invoices"
        sub={<span className="c-prose">Couldn&rsquo;t check just now.</span>}
        sr="We couldn't check your invoices. Nothing here says you owe nothing — we just couldn't reach them." />
    ));
  } else if (invoices.length > 0) {
    // A stack, never a sum: two open invoices have two numbers, two due dates and two QPay payments
    // behind them, so one combined figure would be a number the boss cannot pay. One tile, one target.
    //
    // The route the redesign is heading for is /boss/money/invoice/[number], which is not built.
    // /boss/billing/[number] is the same invoice, today, with the QPay button on it — and a 404 behind a
    // tile that says "Pay $34.00" is the worst thing this tile could do.
    for (const i of invoices) {
      t.push((span) => (
        <Cell key={i.id} span={span} href={`/boss/billing/${i.number}`} sr={i.sr}
          tone={i.id === alarm ? "needs" : "ink"} icon={i.id === alarm ? CircleAlert : undefined}
          label={i.words} sub={<span className="num">{i.number}</span>} />
      ));
    }
  } else if (intro && intro.n > 0) {
    // Nothing is payable yet. No href and no ink: there is nothing to press, and an ink cell that goes
    // nowhere is a lie about what happens when you press it.
    t.push((span) => (
      <Cell key="bill" span={span} label="Nothing to pay yet"
        sub={<span className="c-prose">This fortnight is still open.</span>}
        sr={`${introWords(intro.n, intro.feeCents)}, ${moneyCents(intro.cents)} so far. Nothing to pay until this fortnight closes.`} />
    ));
  }

  return t;
}

/* ─────────────────────────────────────────────────────────────────────── the pay run */

/**
 * One person's fortnight — a ROW, and that is the decision this screen turns on.
 *
 * It carries two separate targets (the name, and the Paid toggle beside it), a dispute badge and up to
 * four lines of explanation. A tile would have to shrink the toggle under the 44px floor or grow until it
 * was a card pretending to be a tile. So the run is a list, under its own heading, below the grid.
 *
 * The figure is what is still OWED them, never their whole fortnight's gross — a row that shows a man
 * $770 when one Wednesday of it is outstanding is the same confusion the hero exists to stop, one level
 * down. The gross rides underneath, where it is context rather than a debt.
 */
function WorkerRow({ r }: { r: WorkerRun }) {
  const owed = r.owed > 0;
  const extras = [
    r.partPaid ? `${money(r.gross)} for the fortnight, ${money(r.gross - r.owed)} of it already paid` : "",
    r.otHours > 0 ? `includes ${r.otHours}h overtime` : "",
    r.toppedUp ? "topped up to the Award" : "",
    ...r.notes,
  ].filter(Boolean);

  return (
    <Cell tone={r.paid ? "gos" : "white"}>
      <div className="flex items-start gap-3">
        {/* The whole left block is the link, not the name on its own: a 19px line of bold text is a 19px
            target, and the thumb aiming at it belongs to someone holding a ladder with the other hand.
            The toggle sits outside it, so the two targets are side by side and neither is inside the other. */}
        <Link href={`/boss/workers/${r.workerId}`} className="min-w-0 flex-1 block">
          <span className="c-label block truncate">{r.name}</span>
          <span className="c-fig mt-1 flex items-baseline gap-1.5 min-w-0">
            <span className="truncate">{money(owed ? r.owed : r.gross)}</span>
            <span className="c-unit shrink-0">{owed ? "still to pay" : "paid"}</span>
          </span>
          <span className="c-sub c-prose num block">
            {r.hours}h over {r.days === 1 ? "1 day" : `${r.days} days`} · {money(r.superAmt)} super
          </span>
          {extras.length > 0 && <span className="c-sub c-prose block">{extras.join(" · ")}</span>}
          {/* Ink, not orange. The orange on this screen is spent on the invoice, and /boss already ranks a
              disagreement above one and sends the boss to ring the worker — the same badge in orange here
              would be the second "this needs you, now" and neither would mean it. */}
          {r.disputed && (
            <Flag tone="dark" icon={CircleAlert} className="mt-2">
              {r.name.split(" ")[0]} disagrees with these hours — give them a call
            </Flag>
          )}
        </Link>
        {/* A group with the person's name on it, so the button reads as "mark Sam paid" rather than as one
            of six identical "Mark paid" buttons with nothing to tell them apart. */}
        <div className="shrink-0" role="group" aria-label={r.name}>
          <PaidToggle paid={r.paid} ids={r.ids} action={markPaidMany} />
        </div>
      </div>
    </Cell>
  );
}

/* ─────────────────────────────────────────────────────────────────────── the period */

/**
 * This fortnight, last fortnight, or any day you like — not a week pager.
 *
 * The two chevrons on /boss/pay were the whole bug: a fortnight is two taps away from wherever you are,
 * and neither tap tells you which half of the invoice you are looking at. These are named destinations.
 * The third is a plain GET form with a date in it, so any fortnight is one pick rather than n taps —
 * lib/fortnight resolves the day to the fortnight that contains it, on the boss's own billing grid.
 *
 * A form and two links: no client component, no JavaScript, and it still works with both switched off.
 */
function Period({ back, on, current, from }: { back: number; on: string | null; current: boolean; from: string }) {
  const thisOne = current && !on;
  const lastOne = back === 1 && !on;
  return (
    <div className="space-y-2">
      <div className="seg grid-cols-2">
        <Link href="/boss/money" className={`seg-item ${thisOne ? "seg-on" : ""}`} aria-current={thisOne ? "page" : undefined}>This fortnight</Link>
        <Link href="/boss/money?back=1" className={`seg-item ${lastOne ? "seg-on" : ""}`} aria-current={lastOne ? "page" : undefined}>Last fortnight</Link>
      </div>
      <form method="get" action="/boss/money" className="flex gap-2">
        <input type="date" name="on" defaultValue={on ?? from} className="input flex-1 num"
          aria-label="Show the fortnight that contains this day" />
        <button className="btn bg-ink text-white shrink-0 shadow-[0_1px_2px_rgba(16,24,40,0.10)]">Show</button>
      </form>
    </div>
  );
}
