import Link from "next/link";
import { notFound } from "next/navigation";
import { Ban, Check, CircleAlert, Handshake, Hourglass, Lock, Phone, Users, Wallet, type LucideIcon } from "lucide-react";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Avatar, Big, Cell, Row, Section, bookingWords, type CellTone } from "@/components/ui";
import { ConfirmButton } from "@/components/ConfirmButton";
import { CallLink } from "@/components/CallLink";
import { StatusPill } from "@/components/StatusPill";
import { approveHours, cancelShift, cancelPost, removeBooking, widenSearch, sameAgainTomorrow, logCall, setAllowOffers } from "@/actions/boss";
import { fillWords, linesInWords } from "@/lib/posts";
import { isUuid } from "@/lib/validate";
import { fmtDay, fmtTime, km, todayIso } from "@/lib/util";
import { TICKETS, money } from "@/lib/award";
import { clockInLooks, hoursUntil, otInWords, payForShift, weatherSuggestion, urgencyOf } from "@/lib/rules";
import { WeatherRow, weatherKind } from "../Weather";
export const dynamic = "force-dynamic";

/**
 * THE JOB SCREEN — what this job is, who is on it, and what each of them is doing right now.
 *
 * WHAT THIS SCREEN STOPPED BEING. It used to carry a status block, a profile block and an approve form
 * per worker: six workers was about eight phone screens of scrolling, and the approve form nearest the
 * thumb belonged to whoever happened to have said yes first. Those forms now live on /boss/approve, which
 * prices every waiting lot of hours together and has a bulk action, so this screen is a bento of
 * statements with one link through. The cells got shorter because the screen stopped having two jobs.
 *
 * ONE ORANGE, AND ONLY WHEN SHORT. Orange means "this needs you, now", and on a job the only state where
 * "now" is literally true is a hole in the crew with the day still ahead of it — that is the one there is
 * still somebody to ring about tonight. Hours waiting on a yes are real but they are not this screen's
 * job any more; they get an ink cell, because ink is the press-me colour and that cell goes somewhere. A
 * dispute and a worker who never clocked out are drawn `cell-soft`, the volume step down, and both of
 * them can only happen on a day that has already passed — so the orange and the soft never compete.
 *
 * EVERY ACTION THAT WAS HERE IS STILL HERE. Cancelling the shift, cancelling the whole job, taking a
 * worker off, ringing one, the deals toggle, marking weather and asking another round all kept their
 * exact confirm sheets and their exact words. Losing one of them to a tidier screen is a regression even
 * when the screen looks better: the boss standing in the rain with a crew to stand down has no second
 * route to it.
 *
 * AND THE APPROVE FORM DID NOT ALL LEAVE. /boss/approve reads `b.status = 'clocked_out'` and nothing else
 * (lib/approveQueue.ts), so a worker who forgot to clock out — the whole reason the "never clocked out"
 * state exists — never appears on it. Their form stays here, folded into their own row, because the
 * alternative is a crew member who cannot be paid through the app at all.
 */

type Line = { id: string; role: string; spots: number; status: string; taken: number; told_names: string | null; on_names: string | null; asks: number };
type Booking = {
  id: string; worker_id: string; status: string; name: string; phone: string; photo: string | null; tickets: string[];
  score: number | null; completed: number | null; calls: number;
  clock_in_at: string | null; clock_in_dist_m: number | null; hours_worked: number | string | null; hours_approved: number | string | null;
  disputed_at: string | null; agreed_rate: number | string | null; agreed_hours: number | string | null; agreed_start: string | null;
};

/**
 * A worker's state, in the colour of the cell it is drawn in. `bookingWords()` is the single source for
 * that vocabulary and it answers in `Say` tones, which are not the same alphabet a cell speaks.
 *
 * Its "orange" is deliberately not carried across. Orange is one per screen and it is spent on a short
 * crew; six clocked-out workers drawn orange would be six "this needs you, now" on one screen and the
 * colour would stop meaning anything — the exact flattening lib/rank.ts was written to end on /boss.
 * Green becomes `gos`, which is what green does inside a list that is mostly not green, and the two
 * states that go on somebody's record — pulled out, and a disagreement over hours already approved — get
 * `warns`, the colour that exists to keep those apart from a day that was nobody's fault.
 */
const cellToneFor = (b: { status: string; disputed_at: string | null }, words: { tone: string }): CellTone =>
  b.status === "cancelled" || (b.disputed_at && ["approved", "paid"].includes(b.status)) ? "warns"
    : words.tone === "green" ? "gos" : "white";

export default async function LiveShift({ params }: { params: Promise<{ id: string }> }) {
  const u = await requireRole("boss");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [[s], bookings, job] = await Promise.all([
    sql`SELECT s.*, p.name AS site, p.address,
          (SELECT COUNT(*) FROM notifications n WHERE n.shift_id = s.id AND n.kind = 'shift_match')::int AS notified,
          (SELECT us.name FROM users us WHERE us.id = s.direct_worker_id) AS direct_name
        FROM shifts s JOIN projects p ON p.id = s.project_id WHERE s.id = ${id} AND s.boss_id = ${u.id}`,
    sql<Booking[]>`SELECT b.*, us.name, us.phone, w.tickets, w.photo,
          CASE WHEN st.past_shifts > 0 THEN ROUND(100.0 * st.showed / st.past_shifts) END AS score, st.completed,
          (SELECT COUNT(*) FROM calls c WHERE c.booking_id = b.id)::int AS calls
        FROM bookings b JOIN users us ON us.id = b.worker_id JOIN workers w ON w.user_id = b.worker_id
        LEFT JOIN worker_stats st ON st.worker_id = b.worker_id
        WHERE b.shift_id = ${id} AND b.status <> 'removed' ORDER BY b.created_at`,
    // Every line of the job this shift was posted in, this one first or last as it was written. A shift that is
    // its own post is a job of one line. told_names / on_names are what the cancel sheets read out.
    sql<Line[]>`SELECT x.id, x.role, x.spots, x.status,
          (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = x.id AND b.status NOT IN ('removed','cancelled'))::int AS taken,
          (SELECT string_agg(split_part(us.name,' ',1), ', ' ORDER BY b.created_at) FROM bookings b JOIN users us ON us.id = b.worker_id
            WHERE b.shift_id = x.id AND b.status IN ('accepted','clocked_in')) AS told_names,
          (SELECT string_agg(split_part(us.name,' ',1), ', ' ORDER BY b.created_at) FROM bookings b JOIN users us ON us.id = b.worker_id
            WHERE b.shift_id = x.id AND b.status NOT IN ('removed','cancelled')) AS on_names,
          (SELECT COUNT(*) FROM offers o WHERE o.shift_id = x.id AND o.status = 'pending')::int AS asks
        FROM shifts me JOIN shifts x ON (x.id = me.id OR x.post_id = me.post_id) AND x.boss_id = me.boss_id
        WHERE me.id = ${id} AND me.boss_id = ${u.id} ORDER BY x.created_at`,
  ]);
  if (!s) notFound();
  const today = todayIso();
  const taken = bookings.filter((b) => b.status !== "cancelled").length;
  const short = s.spots - taken;
  const open = s.status === "open" && short > 0;
  const upcoming = s.day >= today;
  const start = fmtTime(s.start_time);
  const when = s.day === today ? "Today" : fmtDay(s.day);
  const mine = job.find((l) => l.id === s.id);
  const others = job.filter((l) => l.id !== s.id);
  const stillLooking = job.filter((l) => l.status === "open"), full = job.filter((l) => l.status === "filled");
  const lineState = (l: Line) => (l.status === "cancelled" ? "cancelled" : s.day < today ? "closed" : l.taken >= l.spots ? "filled" : l.status);
  const terms = { ot_mode: s.ot_mode, ot_after_hours: s.ot_after_hours, ot_multiplier: s.ot_multiplier };
  const wk = s.weather_stop ? weatherKind(s.weather_stop) : null;

  // Who is in what state right now. The state cell says one thing, and it's the first one of these that's true.
  const names = (list: { name: string }[]) => list.map((b) => b.name.split(" ")[0]).join(", ");
  const toApprove = bookings.filter((b) => b.status === "clocked_out");
  const onSite = bookings.filter((b) => b.status === "clocked_in");
  const noClockOut = s.day < today ? bookings.filter((b) => ["accepted", "clocked_in"].includes(b.status)) : [];
  const disputed = bookings.filter((b) => b.disputed_at && ["approved", "paid"].includes(b.status));
  const live = bookings.filter((b) => b.status !== "cancelled");
  const owed = bookings.filter((b) => b.status === "approved");
  const owedTotal = owed.reduce((a, b) => a + payForShift(Number(b.hours_approved), Number(b.agreed_rate ?? s.rate), terms).gross, 0);
  const done = live.length > 0 && live.every((b) => ["approved", "paid"].includes(b.status));
  const hoursAway = hoursUntil({ day: s.day, start_time: String(s.start_time) }, new Date());
  // The cron runs every 20 minutes (vercel.json) and only picks up a shift 20 minutes after its last round,
  // so the next automatic round can be up to 40 minutes away. Urgent shifts qualify on every run.
  const auto = hoursAway <= 0
    ? "It has already started, so we've stopped asking on our own — ask another round yourself."
    : urgencyOf({ day: s.day, start_time: String(s.start_time) }).urgent
      ? "It starts soon, so we ask three times as many workers each round — the next one goes out within 20 minutes."
      : "If nobody says yes we ask more workers on our own, within 40 minutes.";

  const needsWorkers = open && upcoming && !s.direct_worker_id && s.status !== "cancelled";

  /**
   * The one cell at the top, and the one action in it.
   *
   * There is no `sr` on it, deliberately: `Cell` hides its whole body from a screen reader the moment
   * `sr` is set, and the button in the foot would go with it. Every part of this cell is real text
   * already — the label, the figure and the sentence — so the spoken version is the visible one.
   */
  const state: {
    tone: CellTone; icon: LucideIcon; label: string; n?: string | number; unit?: string;
    sub: string; bar?: React.ReactNode; asks?: boolean;
  } = (() => {
    if (s.status === "cancelled") return {
      tone: "warns" as const, icon: Ban, label: "You cancelled this shift",
      sub: "Everyone who was booked has been told. Any hours already recorded are still below, for you to settle.",
    };
    // THE ONLY ORANGE ON THIS SCREEN: a hole in the crew with the day still ahead of it.
    if (open && upcoming && !s.direct_worker_id) return {
      tone: "needs" as const, icon: CircleAlert,
      label: s.notified > 0 ? "Still short" : "Nobody free nearby yet",
      n: short, unit: short === 1 ? "worker" : "workers",
      sub: `${s.notified > 0 ? `We've asked ${s.notified} worker${s.notified > 1 ? "s" : ""} nearby. ` : "Nobody nearby was free that day with the right licences. "}${auto}`,
      asks: true,
      bar: (
        <div className="cell-bar">
          <form action={widenSearch.bind(null, s.id)}><button className="cell-act w-full">Ask more workers now</button></form>
        </div>
      ),
    };
    if (open && upcoming && s.direct_worker_id) return {
      tone: "white" as const, icon: Hourglass,
      label: `Sent to ${String(s.direct_name ?? "them").split(" ")[0]}. Waiting for a yes.`,
      sub: "Nobody else is asked. It buzzes their phone if they've turned alerts on.",
    };
    // Both of these need the boss, and neither can happen on a day that still has workers to find — so
    // they take `soft`, the volume step down, and nothing on this screen is ever two volumes at once.
    if (disputed.length) return {
      tone: "soft" as const, icon: CircleAlert,
      label: `${names(disputed)} ${disputed.length > 1 ? "disagree" : "disagrees"} with the hours you approved`,
      sub: "Both numbers stay on record. A phone call is the quickest fix — the button is on their row below.",
    };
    if (noClockOut.length) return {
      tone: "soft" as const, icon: CircleAlert, label: `${names(noClockOut)} never clocked out`,
      sub: "The day has passed, so nothing lands in Approve hours for them. Open their row below and set the number yourself.",
    };
    if (done) return owed.length
      ? {
        tone: "go" as const, icon: Check, label: "Hours approved", n: money(owedTotal), unit: "to pay",
        sub: "Pay them your usual way, then mark it paid.",
        bar: <div className="cell-bar"><Link href="/boss/pay" className="cell-act">Open Pay</Link></div>,
      }
      : { tone: "go" as const, icon: Check, label: "Approved and paid", sub: "Nothing left to do on this one." };
    if (onSite.length) return {
      tone: "go" as const, icon: Check, label: `${names(onSite)} on site now`,
      sub: "They clock out when they finish. Their hours land in Approve hours.",
    };
    if (taken >= s.spots) return {
      tone: "go" as const, icon: Check, label: "All spots taken", n: `${taken} of ${s.spots}`,
      sub: "Names below. They'll clock in on site.",
    };
    if (!upcoming) return {
      tone: "white" as const, icon: Hourglass, label: "That day has passed", n: `${taken} of ${s.spots}`,
      sub: `${taken === 1 ? "worker was" : "workers were"} booked.`,
    };
    return { tone: "white" as const, icon: Hourglass, label: "Filling up", n: `${taken} of ${s.spots}`, sub: "Names below." };
  })();

  // What "cancel" really does, line by line, in the same order the action does it (actions/boss.ts).
  const booked = bookings.filter((b) => b.status === "accepted");
  const finished = bookings.filter((b) => ["clocked_out", "approved", "paid"].includes(b.status));
  const cancelThis = [
    booked.length ? `${names(booked)} ${booked.length > 1 ? "are" : "is"} booked and will be told the shift is off.` : null,
    onSite.length ? `${names(onSite)} clocked in today — they come off the shift and are told.` : null,
    !booked.length && !onSite.length ? "Nobody is booked, so nobody gets a message." : null,
    finished.length ? `${names(finished)} already recorded hours — those stay, for you to approve and pay.` : null,
    mine && mine.asks > 0 ? `${mine.asks} deal request${mine.asks > 1 ? "s" : ""} closed, and ${mine.asks > 1 ? "those workers are" : "that worker is"} told.` : null,
    "Workers stop seeing it. You can't undo this.",
  ].filter(Boolean) as string[];
  const cancelJob = [
    ...job.map((l) => {
      const head = `${l.spots} × ${l.role} — `;
      if (l.status === "cancelled") return `${head}already cancelled.`;
      if (l.status === "filled") return `${head}full, ${l.on_names ?? "everyone on it"} stay${l.on_names && l.on_names.includes(",") ? "" : "s"} booked.`;
      const asks = l.asks > 0 ? `, ${l.asks} deal request${l.asks > 1 ? "s" : ""} closed` : "";
      return l.told_names
        ? `${head}${l.told_names} ${l.told_names.includes(",") ? "are" : "is"} booked and will be told, cancelled${asks}.`
        : `${head}nobody booked yet, cancelled${asks}.`;
    }),
    full.length ? "Full lines stay booked — cancel one of those on its own page." : null,
  ].filter(Boolean) as string[];

  return (
    <>
      <Header title={`${when} · ${start}`} back="/boss" />
      <Page>
        {/* 1. The one thing, and the one action. */}
        <div className="bento">
          <Cell span={2} rows={2} tone={state.tone}>
            <div className="min-w-0">
              <div className="c-label flex items-start gap-2">
                <state.icon size={state.tone === "needs" ? 24 : 20} strokeWidth={2.5} aria-hidden className="shrink-0" />
                <span className="min-w-0">{state.label}</span>
              </div>
              {state.n != null && (
                <div className="c-fig-2 mt-1 flex items-baseline gap-1 min-w-0">
                  <span className="truncate">{state.n}</span>
                  {state.unit && <span className="c-unit shrink-0">{state.unit}</span>}
                </div>
              )}
              <div className="c-sub line-clamp-4">{state.sub}</div>
            </div>
            {state.bar}
          </Cell>

          {/* Rained off is a fact about the day, not a job to do — warn-soft, and the words are what keep
              it apart from a crew who pulled out. It sits under the state it explains. */}
          {wk && (
            <Cell span={2} tone="warns" icon={wk.icon} label={`Work stopped · ${wk.label}`}
              sub={`${s.weather_note ? `“${s.weather_note}” ` : ""}Everyone on this shift was told. You decide each worker's hours — we write the reason down next to the number.`} />
          )}

          {/* Ink, because ink is the press-me colour and this one goes somewhere. The hours are approved on
              /boss/approve, where every lot waiting across every site is priced and can be done together. */}
          {toApprove.length > 0 && (
            <Cell span={2} tone="ink" href="/boss/approve" icon={Hourglass}
              label={toApprove.length === 1 ? `${names(toApprove)} finished — approve their hours` : `${toApprove.length} workers finished — approve their hours`}
              sub="Their hours, with everyone else's that are waiting, on one screen." />
          )}
        </div>

        {/* 2. What the job is, and what was agreed. */}
        <div className="bento">
          <Cell span={2}>
            <div className="min-w-0">
              <div className="c-label">{s.site}</div>
              <div className="c-sub c-prose">{s.address}</div>
            </div>
            <div className="min-w-0">
              <div className="c-label">{s.spots} × {s.role}</div>
              <div className="c-sub">
                <span className="num">{when} {start} · {Number(s.hours)} hours</span>
                {others.length > 0 && <span className="c-prose"> · part of one job: {linesInWords(job)}</span>}
              </div>
            </div>
          </Cell>

          {/* The rate leads, because it is the number an argument at the end of the week is about, and the
              sentence under it is otInWords' — the same words the worker read before they said yes. */}
          <Big span={2} n={money(Number(s.rate))} unit="an hour" label="The deal you posted"
            sub={<span className="num">{Number(s.hours)} hours · {otInWords(terms, Number(s.rate))}</span>} />

          <Cell span={s.note ? 1 : 2} label="Licences needed"
            sub={s.tickets_required.map((t: string) => TICKETS[t] ?? t).join(", ")} />
          {/* No cell when there is no note. An empty "Your note" earns nothing and costs a row. */}
          {s.note && <Cell label="Your note" sub={<span className="c-prose">“{s.note}”</span>} />}
        </div>

        {/* 3. Who is on it, and what each of them is doing right now. */}
        <Section title={`Who is on it · ${taken} of ${s.spots}`} hint="Tap a name for their record." />
        <div className="bento">
          {bookings.length === 0 && (
            <Cell span={2} label="Nobody yet" sub={<span className="c-prose">Names show up here as workers say yes.</span>} />
          )}
          {bookings.map((b) => {
            const w = bookingWords({ status: b.status, clock_in_at: b.clock_in_at, hours_worked: b.hours_worked, hours_approved: b.hours_approved, disputed_at: b.disputed_at },
              b.agreed_start ? fmtTime(String(b.agreed_start)) : start, Number(b.agreed_rate ?? s.rate), terms);
            const WIcon = w.icon;
            const tone = cellToneFor(b, w);
            const look = b.clock_in_at ? clockInLooks({ day: s.day, start_time: s.start_time }, { dist_m: b.clock_in_dist_m, at: b.clock_in_at }) : null;
            /**
             * The half of the old approve form /boss/approve cannot reach: it reads `clocked_out` only, so
             * neither of these two ever appears on it. A worker still on site whose day the boss wants to
             * close early, and — the one that matters — a worker on a day that has passed who never
             * clocked out. Drop this and they cannot be paid through the app at all.
             */
            const setHours = b.status === "clocked_in" || (b.status === "accepted" && s.day <= today);
            const sug = setHours && s.weather_stop
              ? weatherSuggestion({ scheduled: Number(b.agreed_hours ?? s.hours), worked: Number(b.hours_worked ?? 0), clockedIn: !!b.clock_in_at })
              : null;
            return (
              <Cell key={b.id} span={2} tone={tone}>
                {/* The anchor a deep link lands on. A span, because the cell itself is the grid item and
                    wrapping it in a div with an id would break the two-column span. */}
                <span id={`worker-${b.id}`} className="block scroll-mt-24" aria-hidden />
                <div className="flex items-start gap-3 min-w-0">
                  <Avatar name={b.name} photo={b.photo} size={40} />
                  <div className="flex-1 min-w-0">
                    {/* 44px of link, not 20px of text: this is the only target on the row that is a word
                        rather than a button, and a name you can read but not hit is worse than no link. */}
                    <Link href={`/boss/workers/${b.worker_id}`}
                      className="c-label inline-flex items-center min-h-[44px] underline decoration-2 underline-offset-4">{b.name}</Link>
                    <div className="c-label flex items-start gap-1.5">
                      {WIcon && <WIcon size={18} strokeWidth={2.5} aria-hidden className="shrink-0 mt-0.5" />}
                      <span className="min-w-0">{w.title}</span>
                    </div>
                    {/* Steel for prose, full ink on a warns row: "give them a call" is a thing to do. */}
                    <div className={`c-sub${tone === "warns" ? "" : " c-prose"}`}>{w.sub}</div>

                    {(b.agreed_rate || b.agreed_hours || b.agreed_start) && (
                      <div className="c-sub flex items-start gap-1.5 font-bold">
                        <Handshake size={16} strokeWidth={2.25} aria-hidden className="shrink-0 mt-0.5" />
                        <span className="num">Agreed deal: {money(Number(b.agreed_rate ?? s.rate))}/h · {Number(b.agreed_hours ?? s.hours)}h{b.agreed_start ? ` from ${String(b.agreed_start).slice(0, 5)}` : ""}</span>
                      </div>
                    )}

                    <div className="c-sub c-prose">
                      {b.score != null ? `Turns up ${b.score}% of the time · ${b.completed} shifts` : "New — first shift"}
                      {" · "}{b.tickets.map((t: string) => t === "WC" ? "White Card" : t).join(", ")}
                    </div>

                    {look && (
                      <div className="c-sub c-prose">
                        Clocked in {km(b.clock_in_dist_m ?? 0)} from the site{look === "good" ? " — on time" : look === "late" ? " — late" : look === "far" ? " — a long way off" : ""}.
                        {b.hours_approved != null && Number(b.hours_approved) !== Number(b.hours_worked) && <> Worker recorded <b className="num">{Number(b.hours_worked)}h</b>, you approved <b className="num">{Number(b.hours_approved)}h</b>.</>}
                        {b.calls > 0 && <> <Phone size={14} strokeWidth={2.5} aria-hidden className="inline align-[-2px]" /> {b.calls} call{b.calls > 1 ? "s" : ""}.</>}
                      </div>
                    )}
                  </div>
                </div>

                {setHours && (
                  <details className="min-w-0">
                    <summary className="c-label min-h-[44px] flex items-center gap-2 cursor-pointer">Set the hours yourself</summary>
                    <form action={approveHours} className="mt-2 space-y-2">
                      <input type="hidden" name="booking_id" value={b.id} />
                      {sug && (
                        <>
                          <div className="c-label num">Suggest paying {sug.hours} hours</div>
                          <div className="c-sub c-prose">{sug.why} Change it to whatever you decide.</div>
                          <input type="hidden" name="pay_reason" value={`${s.weather_stop === "rain" ? "Rained out" : "Weather stopped work"}${s.weather_note ? ` — ${s.weather_note}` : ""}`} />
                        </>
                      )}
                      <div className="flex items-center gap-2">
                        <input name="hours" type="number" step="0.5" min="0" max="16"
                          defaultValue={sug ? sug.hours : (b.hours_worked ?? Number(b.agreed_hours ?? s.hours))}
                          className="input w-28 num text-2xl font-extrabold text-center" aria-label={`Hours to approve for ${b.name}`} />
                        <div className="c-label">hours</div>
                      </div>
                      <button className="btn-primary">Approve and record it</button>
                      {/* No fee line here. The $2 is explained once, on /boss/approve, where every waiting
                          booking is priced together and the sheet lists each charge before it is made — two
                          screens telling the same pricing story is how the two of them come to disagree. */}
                      <div className="c-sub c-prose">The worker sees this number, what they recorded, and the reason.</div>
                    </form>
                  </details>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <CallLink phone={b.phone} name={b.name} onCall={logCall.bind(null, b.worker_id, b.id)} className="btn-ghost btn-sm w-full" />
                  {b.status === "accepted" && (
                    <ConfirmButton action={removeBooking.bind(null, b.id)} className="btn-danger btn-sm w-full"
                      title={`Take ${b.name.split(" ")[0]} off this shift?`}
                      details={[
                        `${b.name.split(" ")[0]} gets a message saying you took them off, with your number to call.`,
                        "The spot opens up again and we start looking for someone else.",
                        "Their hours and history with you stay on record.",
                      ]}
                      confirmLabel={`Take ${b.name.split(" ")[0]} off`} cancelLabel="Keep them on">Take off shift</ConfirmButton>
                  )}
                  {(b.status === "approved" || b.status === "paid") && <form action={sameAgainTomorrow.bind(null, b.id)}><button className="btn-dark btn-sm w-full">Same again tomorrow</button></form>}
                </div>
              </Cell>
            );
          })}
        </div>

        {/* 4. The rest of this job. */}
        {others.length > 0 && (
          <>
            <Section title="The rest of this job" hint={`Posted together for ${fmtDay(s.day)}, ${start}. Tap one to see who's on it.`} />
            <div className="space-y-2">
              {others.map((l) => (
                <Row key={l.id} href={`/boss/shifts/${l.id}`} title={`${l.spots} × ${l.role}`} sub={fillWords(l.taken, l.spots)} right={<StatusPill s={lineState(l)} />} />
              ))}
            </div>
          </>
        )}

        {/* 5. The things you rarely press, out of the way but never hidden. */}
        <Section title="Other things you can do" />
        <div className="acts">
          <WeatherRow shiftId={s.id} stop={s.weather_stop} />

          {needsWorkers && (
            <form action={setAllowOffers.bind(null, s.id, !s.allow_offers)}>
              <button className="act">
                {s.allow_offers
                  ? <Lock size={20} strokeWidth={2.25} aria-hidden className="shrink-0 text-steel" />
                  : <Handshake size={20} strokeWidth={2.25} aria-hidden className="shrink-0 text-steel" />}
                <span className="flex-1">
                  {s.allow_offers ? "Fixed rate, no deals" : "Let workers ask for a deal"}
                  <span className="block text-sm font-normal text-steel">
                    {s.allow_offers ? "Right now workers can ask you for different pay, hours or a later start." : "Right now it's the posted rate — take it or leave it."}
                  </span>
                </span>
              </button>
            </form>
          )}

          {/* Only when the state cell above is not already holding this button. Today it always is, but the
              ladder up there is what decides that, not this row — so the fallback stays rather than the
              one way to wake more phones depending on the order of a list somewhere else. */}
          {needsWorkers && !state.asks && (
            <form action={widenSearch.bind(null, s.id)}>
              <button className="act"><Users size={20} strokeWidth={2.25} aria-hidden className="shrink-0 text-steel" />
                <span className="flex-1">Ask more workers now<span className="block text-sm font-normal text-steel">Wakes the next batch of phones nearby.</span></span>
              </button>
            </form>
          )}

          {s.status !== "cancelled" && upcoming && (
            <ConfirmButton action={cancelShift.bind(null, s.id)} className="act text-warn"
              title={others.length > 0 ? `Cancel ${s.spots} × ${s.role}?` : "Cancel this shift?"}
              details={cancelThis}
              confirmLabel={others.length > 0 ? `Cancel ${s.spots} × ${s.role}` : "Cancel the shift"} cancelLabel="Keep it">
              <Ban size={20} strokeWidth={2.25} aria-hidden className="shrink-0" />
              <span className="flex-1">{others.length > 0 ? `Cancel just ${s.spots} × ${s.role}` : "Cancel this shift"}</span>
            </ConfirmButton>
          )}

          {others.length > 0 && stillLooking.length > 0 && upcoming && (
            <ConfirmButton action={cancelPost.bind(null, s.id)} className="act text-warn"
              title="Cancel the whole job?" details={cancelJob}
              confirmLabel="Cancel the job" cancelLabel="Keep it">
              <Ban size={20} strokeWidth={2.25} aria-hidden className="shrink-0" />
              <span className="flex-1">Cancel the whole job</span>
            </ConfirmButton>
          )}
        </div>

        {/* The state cell already links to Pay once everyone's hours are in; this is for a shift still half-running. */}
        {owed.length > 0 && !done && (
          <Link href="/boss/pay" className="text-steel underline text-base flex items-center gap-1.5">
            <Wallet size={18} strokeWidth={2.25} aria-hidden />{money(owedTotal)} from this shift is waiting in Pay
          </Link>
        )}
      </Page>
    </>
  );
}
