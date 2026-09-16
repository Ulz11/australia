import Link from "next/link";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Avatar, Chev, Say, Section } from "@/components/ui";
import { Check, CircleAlert } from "lucide-react";
import { myBookings } from "@/lib/workerQueries";
import { MeForm } from "./MeForm";
import { ProfileCard } from "./ProfileCard";
import { Licences } from "./Licences";
import { InviteLink } from "./InviteLink";
import { StatusPill } from "@/components/StatusPill";
import { ConfirmButton } from "@/components/ConfirmButton";
import { disagree, workerLogCall } from "@/actions/worker";
import { CallLink } from "@/components/CallLink";
import { fmtDay } from "@/lib/util";
import { money } from "@/lib/award";
import { payForShift } from "@/lib/rules";
import { logout } from "@/actions/auth";
import { savedPushFingerprint } from "@/lib/alerts";
import { AlertsToggle } from "@/components/AlertsToggle";
export const dynamic = "force-dynamic";

export default async function Me() {
  const u = await requireRole("worker");
  const [[w], mates, all, licences] = await Promise.all([
    sql`SELECT w.*, ST_Y(home::geometry) AS lat, ST_X(home::geometry) AS lng,
          CASE WHEN st.past_shifts > 0 THEN ROUND(100.0 * st.showed / st.past_shifts) END AS score, st.completed, st.cancels
        FROM workers w LEFT JOIN worker_stats st ON st.worker_id = w.user_id WHERE w.user_id = ${u.id}`,
    sql`SELECT us.name, st.completed FROM workers x JOIN users us ON us.id = x.user_id LEFT JOIN worker_stats st ON st.worker_id = x.user_id WHERE x.invited_by = ${u.id}`,
    myBookings(u.id),
    sql`SELECT kind, number, issued_state, expires_on::text, status, checked_at::text, check_note FROM licences WHERE worker_id = ${u.id} ORDER BY kind`,
  ]);
  const history = all.filter((b) => ["approved", "paid", "clocked_out"].includes(b.status));
  const gross = (b: (typeof history)[number]) =>
    b.hours_approved == null ? 0 : payForShift(Number(b.hours_approved), Number(b.rate), { ot_mode: b.ot_mode, ot_after_hours: b.ot_after_hours, ot_multiplier: b.ot_multiplier }).gross;
  const owed = history.filter((b) => b.status === "approved");
  const owedTotal = owed.reduce((a, b) => a + gross(b), 0);
  const base = process.env.NEXT_PUBLIC_BASE_URL || "";
  return (
    <>
      <Header title="Me" />
      <Page>
        <div className="card flex items-center gap-3">
          <Avatar name={u.name!} photo={w.photo} size={64} />
          <div className="flex-1 min-w-0"><div className="text-xl font-extrabold truncate">{u.name}</div><div className="text-steel">{u.phone}</div></div>
          <div className="text-right shrink-0"><div className="font-extrabold text-3xl num">{w.score != null ? `${w.score}%` : "New"}</div><div className="text-sm text-steel">turn-up · {w.completed ?? 0} done</div></div>
        </div>

        <Link href="/worker/offers" className="card flex items-center gap-3">
          <div className="flex-1"><div className="text-lg font-bold">My deal requests</div><div className="text-steel">Jobs where you asked for different pay or hours.</div></div>
          <Chev />
        </Link>

        <Say tone={owed.length ? "dark" : "grey"} title={owed.length ? `Owed to me: ${money(owedTotal)}` : "Owed to me: $0"} sub={owed.length ? `${owed.length} shift${owed.length > 1 ? "s" : ""} approved, not yet paid. Bosses' names below.` : "When a boss approves your hours, it shows here until they pay you."} />

        {history.length > 0 && (
          <div className="card divide-y divide-line">
            {history.map((h) => (
              <div key={h.id} className="py-3">
                <div className="flex justify-between items-center gap-2">
                  <div><div className="font-bold">{fmtDay(h.day)} · {h.site}</div><div className="text-sm text-steel">{h.boss_name}{h.company ? ` · ${h.company}` : ""}</div></div>
                  <div className="text-right num"><div className="font-extrabold text-lg">{h.hours_approved != null ? money(gross(h)) : "—"}</div><StatusPill s={h.status} view="worker" /></div>
                </div>
                {/* Hours that don't match are waiting on this worker to say something — orange until they do. */}
                {h.hours_approved != null && Number(h.hours_approved) !== Number(h.hours_worked) && (
                  <div className={`mt-2 ${h.disputed_at ? "say-grey" : "say-orange"}`}>
                    <div className="flex items-start gap-3">
                      {h.disputed_at
                        ? <Check size={22} strokeWidth={2.25} aria-hidden className="shrink-0 mt-0.5 text-go" />
                        : <CircleAlert size={22} strokeWidth={2.25} aria-hidden className="shrink-0 mt-0.5" />}
                      <div className="min-w-0 flex-1">
                        <div className="font-bold">Boss approved {Number(h.hours_approved)}h. You recorded {Number(h.hours_worked)}h.</div>
                        <div className="say-sub">{h.disputed_at ? "You've told them you disagree. Both numbers stay on record." : "Both numbers stay on record. Best fix: ring them."}</div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <CallLink phone={h.boss_phone} name={h.boss_name} onCall={workerLogCall.bind(null, h.boss_id, h.id)} className="btn bg-white text-ink btn-sm w-full" />
                      {!h.disputed_at && (
                        <ConfirmButton action={disagree.bind(null, h.id)} className="btn bg-white text-ink btn-sm w-full" danger={false}
                          title={`Tell ${h.boss_name.split(" ")[0]} you disagree?`}
                          details={[
                            `${h.boss_name.split(" ")[0]} gets a message that you disagree with the ${Number(h.hours_approved)}h approved for ${fmtDay(h.day)}.`,
                            `Both numbers stay on record: you recorded ${Number(h.hours_worked)}h.`,
                            "Nothing is changed by itself — the two of you sort out the number.",
                          ]}
                          confirmLabel="Yes, tell them" cancelLabel="Not now">I disagree</ConfirmButton>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {process.env.VAPID_PUBLIC_KEY && <AlertsToggle publicKey={process.env.VAPID_PUBLIC_KEY} savedPush={await savedPushFingerprint(u.id)} role="worker" />}

        <InviteLink url={`${base}/join/${w.invite_code}`} code={w.invite_code} mates={mates.map((m) => ({ name: m.name, done: m.completed ?? 0 }))} />

        <Section title="My profile" hint="This is what a boss sees before he books you. Your visa and card numbers stay private." />
        <ProfileCard p={{ name: u.name!, photo: w.photo, years_exp: w.years_exp, trades: w.trades ?? [], languages: w.languages ?? [], about: w.about }} />

        <Licences licences={licences as never} name={u.name!} />

        <Section title="Where and how far" hint="These two decide which shifts you get shown at all." />
        <MeForm name={u.name!} radius={w.radius_km} tickets={w.tickets} visa={w.visa_type} home={w.lat ? { lat: w.lat, lng: w.lng, label: w.home_label } : null} />

        <div className="card space-y-2">
          <div className="text-lg font-bold">Your rights, short version</div>
          <p>Every shift here is a casual job with the boss who posted it. No ABN. Minimum pay is the Building Award rate. Super goes on top. Your hours record is yours.</p>
        </div>
        <form action={logout}><button className="btn-ghost">Sign out</button></form>
      </Page>
    </>
  );
}
