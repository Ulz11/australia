import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Say, Section, bookingWords } from "@/components/ui";
import { ConfirmButton } from "@/components/ConfirmButton";
import { CallLink } from "@/components/CallLink";
import { approveHours, cancelShift, removeBooking, widenSearch, sameAgainTomorrow, logCall } from "@/actions/boss";
import { fmtDay, fmtTime, km, initials, todayIso } from "@/lib/util";
import { TICKETS } from "@/lib/award";
import { clockInLooks, otInWords, weatherSuggestion, urgencyOf } from "@/lib/rules";
import { Weather } from "../Weather";
import { setAllowOffers } from "@/actions/boss";
export const dynamic = "force-dynamic";

export default async function LiveShift({ params }: { params: Promise<{ id: string }> }) {
  const u = await requireRole("boss");
  const { id } = await params;
  const [[s], bookings] = await Promise.all([
    sql`SELECT s.*, p.name AS site, p.address,
          (SELECT COUNT(*) FROM notifications n WHERE n.shift_id = s.id AND n.kind = 'shift_match')::int AS notified
        FROM shifts s JOIN projects p ON p.id = s.project_id WHERE s.id = ${id} AND s.boss_id = ${u.id}`,
    sql`SELECT b.*, us.name, us.phone, w.tickets, w.photo,
          CASE WHEN st.past_shifts > 0 THEN ROUND(100.0 * st.showed / st.past_shifts) END AS score, st.completed,
          (SELECT COUNT(*) FROM calls c WHERE c.booking_id = b.id)::int AS calls
        FROM bookings b JOIN users us ON us.id = b.worker_id JOIN workers w ON w.user_id = b.worker_id
        LEFT JOIN worker_stats st ON st.worker_id = b.worker_id
        WHERE b.shift_id = ${id} AND b.status <> 'removed' ORDER BY b.created_at`,
  ]);
  if (!s) notFound();
  const today = todayIso();
  const taken = bookings.filter((b) => b.status !== "cancelled").length;
  const open = s.status === "open" && taken < s.spots;
  const start = fmtTime(s.start_time);
  const when = s.day === today ? "Today" : fmtDay(s.day);

  return (
    <>
      <Header title={`${when} · ${start}`} back="/boss" />
      <Page>
        <div className="card">
          <div className="text-2xl font-extrabold">{s.site}</div>
          <div className="text-steel">{s.address}</div>
          <div className="mt-3 text-lg"><b>{s.spots} × {s.role}</b> · {Number(s.hours)} hours · <b className="num">${Number(s.rate).toFixed(2)}/h</b></div>
          <div className="text-steel">Needs: {s.tickets_required.map((t: string) => TICKETS[t] ?? t).join(", ")}{s.note ? ` · “${s.note}”` : ""}</div>
          <div className="mt-2 rounded-xl bg-site px-3 py-2">
            <div className="text-sm font-bold">Overtime, agreed when you posted</div>
            <div className="text-sm text-steel">{otInWords({ ot_mode: s.ot_mode, ot_after_hours: s.ot_after_hours, ot_multiplier: s.ot_multiplier }, Number(s.rate))}</div>
          </div>
        </div>

        <Weather shiftId={s.id} stop={s.weather_stop} note={s.weather_note} />

        {s.status === "cancelled" ? <Say tone="red" title="You cancelled this shift" /> :
         open ? (
          s.direct_worker_id
            ? <Say tone="orange" title="Sent. Waiting for them to say yes." sub="We've let them know — it buzzes their phone if they've turned alerts on." />
            : <Say tone="orange" title={s.notified > 0 ? `We've asked ${s.notified} worker${s.notified > 1 ? "s" : ""} nearby` : "Nobody free nearby yet"}
                sub={urgencyOf({ day: s.day, start_time: String(s.start_time) }).urgent
                  ? `${s.spots - taken} spot${s.spots - taken > 1 ? "s" : ""} still open and the shift starts soon — we're asking three times as many workers, every 5 minutes.`
                  : `${s.spots - taken} spot${s.spots - taken > 1 ? "s" : ""} still open. If nobody says yes in 20 minutes, we ask more workers automatically.`}>
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <form action={widenSearch.bind(null, s.id)}><button className="btn-dark btn-sm w-full">Ask more workers</button></form>
                  <form action={setAllowOffers.bind(null, s.id, !s.allow_offers)}>
                    <button className="btn bg-white text-ink btn-sm w-full border-2 border-ink">{s.allow_offers ? "Stop haggling" : "Allow offers"}</button>
                  </form>
                </div>
                {!s.allow_offers && <div className="say-sub mt-2">Fixed rate — workers can only take it or leave it.</div>}
              </Say>
        ) : <Say tone="green" title="All spots taken" sub="Names below. They'll clock in on site." />}

        <Section title={`Workers · ${taken} of ${s.spots}`} />
        {bookings.length === 0 && <div className="card text-steel text-center py-6">Names show up here as workers say yes.</div>}
        {bookings.map((b) => {
          const w = bookingWords({ status: b.status, clock_in_at: b.clock_in_at, hours_worked: b.hours_worked, hours_approved: b.hours_approved, disputed_at: b.disputed_at },
            b.agreed_start ? fmtTime(String(b.agreed_start)) : start, Number(b.agreed_rate ?? s.rate),
            { ot_mode: s.ot_mode, ot_after_hours: s.ot_after_hours, ot_multiplier: s.ot_multiplier });
          const look = b.clock_in_at ? clockInLooks({ day: s.day, start_time: s.start_time }, { dist_m: b.clock_in_dist_m, at: b.clock_in_at }) : null;
          const canApprove = b.status === "clocked_out" || b.status === "clocked_in" || (b.status === "accepted" && s.day <= today);
          return (
            <div key={b.id} className="card space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-slab text-white overflow-hidden flex items-center justify-center font-bold text-lg shrink-0">
                  {b.photo ? <img src={b.photo} alt="" className="w-full h-full object-cover" /> : initials(b.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <Link href={`/boss/workers/${b.worker_id}`} className="text-lg font-bold">{b.name}</Link>
                  <div className="text-sm text-steel">{b.score != null ? `Turns up ${b.score}% of the time · ${b.completed} shifts` : "New — first shift"} · {b.tickets.map((t: string) => t === "WC" ? "White Card" : t).join(", ")}</div>
                  {(b.agreed_rate || b.agreed_hours || b.agreed_start) && (
                    <div className="text-sm font-bold text-hv-dark">Agreed deal: ${Number(b.agreed_rate ?? s.rate).toFixed(2)}/h · {Number(b.agreed_hours ?? s.hours)}h{b.agreed_start ? ` from ${String(b.agreed_start).slice(0, 5)}` : ""}</div>
                  )}
                </div>
              </div>

              <Say tone={w.tone} title={w.title} sub={w.sub} />

              {look && (
                <div className="text-sm text-steel">
                  Clocked in {km(b.clock_in_dist_m ?? 0)} from the site{look === "good" ? " — on time ✓" : look === "late" ? " — late" : look === "far" ? " — a long way off" : ""}.
                  {b.hours_approved != null && Number(b.hours_approved) !== Number(b.hours_worked) && <> Worker recorded <b>{Number(b.hours_worked)}h</b>, you approved <b>{Number(b.hours_approved)}h</b>.</>}
                  {b.calls > 0 && <> 📞 {b.calls} call{b.calls > 1 ? "s" : ""}.</>}
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
                      <div className="say-orange">
                        <div className="say-title num">Suggest paying {sug.hours} hours</div>
                        <div className="say-sub">{sug.why} Change it to whatever you decide.</div>
                        <input type="hidden" name="pay_reason" value={`${s.weather_stop === "rain" ? "Rained out" : "Weather stopped work"}${s.weather_note ? ` — ${s.weather_note}` : ""}`} />
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <input name="hours" type="number" step="0.5" min="0" max="16"
                        defaultValue={sug ? sug.hours : (b.hours_worked ?? Number(b.agreed_hours ?? s.hours))}
                        className="input w-28 num text-2xl font-extrabold text-center" />
                      <div className="text-lg">hours</div>
                    </div>
                    <button className="btn-primary">Approve and record it</button>
                    <div className="text-sm text-steel">The worker sees this number, what they recorded, and the reason.</div>
                  </form>
                );
              })()}

              <div className="grid grid-cols-2 gap-2">
                <CallLink phone={b.phone} name={b.name} onCall={logCall.bind(null, b.worker_id, b.id)} className="btn-ghost btn-sm w-full" />
                {b.status === "accepted" && <ConfirmButton action={removeBooking.bind(null, b.id)} className="btn-danger btn-sm w-full" msg="Take this worker off the shift?">Take off shift</ConfirmButton>}
                {(b.status === "approved" || b.status === "paid") && <form action={sameAgainTomorrow.bind(null, b.id)}><button className="btn-dark btn-sm w-full">Same again tomorrow</button></form>}
              </div>
            </div>
          );
        })}

        {s.status !== "cancelled" && s.day >= today && (
          <ConfirmButton action={cancelShift.bind(null, s.id)} msg="Cancel this shift? Workers who said yes will be told.">Cancel this shift</ConfirmButton>
        )}
      </Page>
    </>
  );
}
