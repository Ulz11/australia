import Link from "next/link";
import { notFound } from "next/navigation";
import { Ban, Check, CircleAlert, Handshake, Hourglass, Lock, Phone, Users, Wallet, type LucideIcon } from "lucide-react";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Avatar, Row, Say, Section, bookingWords, type Tone } from "@/components/ui";
import { ConfirmButton } from "@/components/ConfirmButton";
import { CallLink } from "@/components/CallLink";
import { StatusPill } from "@/components/StatusPill";
import { IntroFeeNote } from "@/components/IntroFeeNote";
import { approveHours, cancelShift, cancelPost, removeBooking, widenSearch, sameAgainTomorrow, logCall, setAllowOffers } from "@/actions/boss";
import { fillWords, linesInWords } from "@/lib/posts";
import { isUuid } from "@/lib/validate";
import { fmtDay, fmtTime, km, todayIso } from "@/lib/util";
import { TICKETS, money } from "@/lib/award";
import { clockInLooks, hoursUntil, otInWords, payForShift, weatherSuggestion, urgencyOf } from "@/lib/rules";
import { WeatherRow, weatherKind } from "../Weather";
export const dynamic = "force-dynamic";

type Line = { id: string; role: string; spots: number; status: string; taken: number; told_names: string | null; on_names: string | null; asks: number };
type Booking = {
  id: string; worker_id: string; status: string; name: string; phone: string; photo: string | null; tickets: string[];
  score: number | null; completed: number | null; calls: number;
  clock_in_at: string | null; clock_in_dist_m: number | null; hours_worked: number | string | null; hours_approved: number | string | null;
  disputed_at: string | null; agreed_rate: number | string | null; agreed_hours: number | string | null; agreed_start: string | null;
};

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

  // Who is in what state right now. The status block says one thing, and it's the first one of these that's true.
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
    ? "It has already started, so we've stopped asking on our own — ask another round yourself below."
    : urgencyOf({ day: s.day, start_time: String(s.start_time) }).urgent
      ? "It starts soon, so we ask three times as many workers each round — the next one goes out within 20 minutes."
      : "If nobody says yes we ask more workers on our own, within 40 minutes.";

  // Is "ask more workers" the one thing to do, or is something louder in front of it?
  const nag = s.status === "cancelled" ? "cancelled" : toApprove.length ? "approve" : disputed.length ? "dispute" : noClockOut.length ? "no-clock-out" : null;
  const needsWorkers = open && upcoming && !s.direct_worker_id && s.status !== "cancelled";

  const status: { tone: Tone; icon: LucideIcon; title: string; sub: string; action?: React.ReactNode } = (() => {
    if (s.status === "cancelled") return { tone: "red" as const, icon: Ban, title: "You cancelled this shift", sub: "Everyone who was booked has been told." };
    if (toApprove.length) return {
      tone: "orange" as const, icon: CircleAlert,
      title: `${toApprove.length === 1 ? `${names(toApprove)} finished` : `${toApprove.length} workers finished`} — approve their hours`,
      sub: "Check the hours they recorded, change the number if you need to, then approve.",
      action: <a href={`#worker-${toApprove[0].id}`} className="btn bg-white text-ink w-full">Approve hours</a>,
    };
    if (disputed.length) return {
      tone: "orange" as const, icon: CircleAlert,
      title: `${names(disputed)} ${disputed.length > 1 ? "disagree" : "disagrees"} with the hours you approved`,
      sub: "Both numbers stay on record. A phone call is the quickest fix.",
      action: <CallLink phone={disputed[0].phone} name={disputed[0].name} onCall={logCall.bind(null, disputed[0].worker_id, disputed[0].id)} className="btn bg-white text-ink w-full" />,
    };
    if (noClockOut.length) return {
      tone: "orange" as const, icon: CircleAlert,
      title: `${names(noClockOut)} never clocked out`,
      sub: "The day has passed. Set the hours yourself and approve them.",
      action: <a href={`#worker-${noClockOut[0].id}`} className="btn bg-white text-ink w-full">Set the hours</a>,
    };
    if (open && upcoming && s.direct_worker_id) return {
      tone: "grey" as const, icon: Hourglass,
      title: `Sent to ${String(s.direct_name ?? "them").split(" ")[0]}. Waiting for a yes.`,
      sub: "Nobody else is asked. It buzzes their phone if they've turned alerts on.",
    };
    if (open && upcoming) return {
      tone: "orange" as const, icon: CircleAlert,
      title: s.notified > 0 ? `Needs ${short} more ${short > 1 ? "workers" : "worker"}` : "Nobody free nearby yet",
      sub: `${s.notified > 0 ? `We've asked ${s.notified} worker${s.notified > 1 ? "s" : ""} nearby. ` : "Nobody nearby was free that day with the right licences. "}${auto}`,
      action: <form action={widenSearch.bind(null, s.id)}><button className="btn bg-white text-ink w-full">Ask more workers now</button></form>,
    };
    if (done) return owed.length
      ? { tone: "green" as const, icon: Check, title: `Hours approved · ${money(owedTotal)} to pay`, sub: "Pay them your usual way, then mark it paid.",
          action: <Link href="/boss/pay" className="btn bg-white text-ink w-full">Open Pay</Link> }
      : { tone: "green" as const, icon: Check, title: "Approved and paid", sub: "Nothing left to do on this one." };
    if (onSite.length) return { tone: "green" as const, icon: Check, title: `${names(onSite)} on site now`, sub: "They clock out when they finish. Then you approve the hours." };
    if (taken >= s.spots) return { tone: "green" as const, icon: Check, title: "All spots taken", sub: "Names below. They'll clock in on site." };
    if (!upcoming) return { tone: "grey" as const, icon: Hourglass, title: "That day has passed", sub: `${taken} of ${s.spots} ${taken === 1 ? "was" : "were"} booked.` };
    return { tone: "grey" as const, icon: Hourglass, title: fillWords(taken, s.spots), sub: "Names below." };
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
        {/* 1. What the shift is. */}
        <div className="card">
          <div className="text-2xl font-extrabold">{s.site}</div>
          <div className="text-steel">{s.address}</div>
          <div className="mt-3 text-lg"><b>{s.spots} × {s.role}</b> · {when} {start} · {Number(s.hours)} hours · <b className="num">${Number(s.rate).toFixed(2)}/h</b></div>
          <div className="text-steel">Needs: {s.tickets_required.map((t: string) => TICKETS[t] ?? t).join(", ")}{s.note ? ` · “${s.note}”` : ""}</div>
          {others.length > 0 && <div className="text-steel mt-1">Part of one job: {linesInWords(job)}</div>}
          <div className="mt-2 rounded-xl bg-site px-3 py-2">
            <div className="text-sm font-bold">Overtime, agreed when you posted</div>
            <div className="text-sm text-steel">{otInWords(terms, Number(s.rate))}</div>
          </div>
        </div>

        {/* 2. What's going on, and the one thing to do about it. */}
        {wk && (
          <Say tone="dark" icon={wk.icon} title={`Work stopped · ${wk.label}${s.weather_note ? ` — ${s.weather_note}` : ""}`}
            sub="Everyone on this shift was told. Set each worker's hours below — you decide the number, we write it down." />
        )}

        <Say tone={status.tone} icon={status.icon} title={status.title} sub={status.sub}>
          {status.action && <div className="mt-3">{status.action}</div>}
        </Say>

        {/* 3. The workers on it. */}
        <Section title={`Workers · ${taken} of ${s.spots}`} />
        {bookings.length === 0 && <div className="card text-steel text-center py-6">Names show up here as workers say yes.</div>}
        {bookings.map((b) => {
          const w = bookingWords({ status: b.status, clock_in_at: b.clock_in_at, hours_worked: b.hours_worked, hours_approved: b.hours_approved, disputed_at: b.disputed_at },
            b.agreed_start ? fmtTime(String(b.agreed_start)) : start, Number(b.agreed_rate ?? s.rate), terms);
          const look = b.clock_in_at ? clockInLooks({ day: s.day, start_time: s.start_time }, { dist_m: b.clock_in_dist_m, at: b.clock_in_at }) : null;
          const canApprove = b.status === "clocked_out" || b.status === "clocked_in" || (b.status === "accepted" && s.day <= today);
          return (
            <div key={b.id} id={`worker-${b.id}`} className="card space-y-3 scroll-mt-20">
              <div className="flex items-center gap-3">
                <Avatar name={b.name} photo={b.photo} />
                <div className="flex-1 min-w-0">
                  <Link href={`/boss/workers/${b.worker_id}`} className="text-lg font-bold">{b.name}</Link>
                  <div className="text-sm text-steel">{b.score != null ? `Turns up ${b.score}% of the time · ${b.completed} shifts` : "New — first shift"} · {b.tickets.map((t: string) => t === "WC" ? "White Card" : t).join(", ")}</div>
                  {(b.agreed_rate || b.agreed_hours || b.agreed_start) && (
                    <div className="text-sm font-bold flex items-center gap-1.5">
                      <Handshake size={16} strokeWidth={2.25} aria-hidden className="shrink-0" />
                      Agreed deal: ${Number(b.agreed_rate ?? s.rate).toFixed(2)}/h · {Number(b.agreed_hours ?? s.hours)}h{b.agreed_start ? ` from ${String(b.agreed_start).slice(0, 5)}` : ""}
                    </div>
                  )}
                </div>
              </div>

              <Say tone={w.tone} icon={w.icon} title={w.title} sub={w.sub} />

              {look && (
                <div className="text-sm text-steel flex items-start gap-1.5">
                  {look === "good" && <Check size={16} strokeWidth={2.5} aria-hidden className="shrink-0 mt-0.5 text-go" />}
                  <span>
                    Clocked in {km(b.clock_in_dist_m ?? 0)} from the site{look === "good" ? " — on time" : look === "late" ? " — late" : look === "far" ? " — a long way off" : ""}.
                    {b.hours_approved != null && Number(b.hours_approved) !== Number(b.hours_worked) && <> Worker recorded <b>{Number(b.hours_worked)}h</b>, you approved <b>{Number(b.hours_approved)}h</b>.</>}
                    {b.calls > 0 && <> <Phone size={14} strokeWidth={2.5} aria-hidden className="inline align-[-2px]" /> {b.calls} call{b.calls > 1 ? "s" : ""}.</>}
                  </span>
                </div>
              )}

              {canApprove && (() => {
                const sug = s.weather_stop
                  ? weatherSuggestion({ scheduled: Number(b.agreed_hours ?? s.hours), worked: Number(b.hours_worked ?? 0), clockedIn: !!b.clock_in_at })
                  : null;
                return (
                  <form action={approveHours} className="space-y-2">
                    <input type="hidden" name="booking_id" value={b.id} />
                    {sug && (
                      <div className="say-grey">
                        <div className="say-title num">Suggest paying {sug.hours} hours</div>
                        <div className="say-sub">{sug.why} Change it to whatever you decide.</div>
                        <input type="hidden" name="pay_reason" value={`${s.weather_stop === "rain" ? "Rained out" : "Weather stopped work"}${s.weather_note ? ` — ${s.weather_note}` : ""}`} />
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <input name="hours" type="number" step="0.5" min="0" max="16"
                        defaultValue={sug ? sug.hours : (b.hours_worked ?? Number(b.agreed_hours ?? s.hours))}
                        className="input w-28 num text-2xl font-extrabold text-center" aria-label={`Hours to approve for ${b.name}`} />
                      <div className="text-lg">hours</div>
                    </div>
                    <button className="btn-primary">Approve and record it</button>
                    <IntroFeeNote bossId={u.id} workerId={b.worker_id} workerName={b.name} />
                    <div className="text-sm text-steel">The worker sees this number, what they recorded, and the reason.</div>
                  </form>
                );
              })()}

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
            </div>
          );
        })}

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

          {needsWorkers && nag && (
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

        {/* The state block already links to Pay once everyone's hours are in; this is for a shift still half-running. */}
        {owed.length > 0 && !done && (
          <Link href="/boss/pay" className="text-steel underline text-base flex items-center gap-1.5">
            <Wallet size={18} strokeWidth={2.25} aria-hidden />{money(owedTotal)} from this shift is waiting in Pay
          </Link>
        )}
      </Page>
    </>
  );
}
