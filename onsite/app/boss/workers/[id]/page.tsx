import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Say, Section, Field } from "@/components/ui";
import { StatusPill } from "@/components/StatusPill";
import { CallLink } from "@/components/CallLink";
import { ConfirmButton } from "@/components/ConfirmButton";
import { updateCrew, removeFromCrew, blockWorker, logCall } from "@/actions/boss";
import { AWARD_CASUAL_FLOOR, TICKETS, money } from "@/lib/award";
import { fmtDay, initials } from "@/lib/util";
import { licenceWords } from "@/lib/verify";
export const dynamic = "force-dynamic";

export default async function WorkerProfile({ params }: { params: Promise<{ id: string }> }) {
  const u = await requireRole("boss");
  const { id } = await params;
  const [[w], history, licences] = await Promise.all([
    sql`SELECT us.id, us.name, us.phone, w.tickets, w.visa_type, w.home_label, w.photo, w.years_exp, w.trades, w.languages, w.about,
          c.type, c.rate, c.since,
          CASE WHEN st.past_shifts > 0 THEN ROUND(100.0 * st.showed / st.past_shifts) END AS score, st.completed, st.cancels
        FROM users us JOIN workers w ON w.user_id = us.id
        LEFT JOIN crew c ON c.worker_id = us.id AND c.boss_id = ${u.id}
        LEFT JOIN worker_stats st ON st.worker_id = us.id WHERE us.id = ${id}`,
    sql`SELECT b.id, b.status, b.hours_approved, b.hours_worked, s.day, s.rate, p.name AS site
        FROM bookings b JOIN shifts s ON s.id = b.shift_id JOIN projects p ON p.id = s.project_id
        WHERE b.worker_id = ${id} AND s.boss_id = ${u.id} AND b.status <> 'removed' ORDER BY s.day DESC LIMIT 40`,
    sql`SELECT kind, number, issued_state, expires_on::text, status, checked_at::text, check_note FROM licences WHERE worker_id = ${id} ORDER BY kind`,
  ]);
  if (!w) notFound();
  const total = history.filter((h) => h.hours_approved).reduce((a, h) => a + Number(h.hours_approved) * Number(h.rate), 0);
  const owed = history.filter((h) => h.status === "approved").reduce((a, h) => a + Number(h.hours_approved) * Number(h.rate), 0);
  return (
    <>
      <Header title={w.name} back="/boss/workers" />
      <Page>
        <div className="card space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-20 h-20 rounded-2xl bg-site border border-line overflow-hidden shrink-0 flex items-center justify-center text-2xl font-bold text-steel">
              {w.photo ? <img src={w.photo} alt="" className="w-full h-full object-cover" /> : initials(w.name)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xl font-extrabold">{w.name}</div>
              <div className="text-steel">{w.score != null ? `Turns up ${w.score}% of the time · ${w.completed} shifts done` : "New — no shifts yet"}{w.cancels > 0 ? ` · pulled out ${w.cancels}×` : ""}</div>
              <div className="text-sm text-steel">
                {w.years_exp ? `${w.years_exp} years on the tools · ` : ""}{w.home_label || "—"}{w.visa_type ? ` · ${w.visa_type}` : ""}
              </div>
            </div>
          </div>
          {w.about && <p className="bg-site rounded-xl p-3">“{w.about}”</p>}
          {(w.trades ?? []).length > 0 && (
            <div><div className="label mb-1.5">Can do</div>
              <div className="flex flex-wrap gap-1.5">{w.trades.map((t: string) => <span key={t} className="rounded-lg bg-site px-2.5 py-1 text-sm font-semibold">{t}</span>)}</div></div>
          )}
          {(w.languages ?? []).length > 0 && (
            <div><div className="label mb-1.5">Speaks</div>
              <div className="flex flex-wrap gap-1.5">{w.languages.map((l: string) => <span key={l} className="rounded-lg bg-site px-2.5 py-1 text-sm font-semibold">{l}</span>)}</div></div>
          )}
        </div>

        <Link href={`/boss/shifts/new?worker=${w.id}`} className="btn-primary text-xl">Book {w.name.split(" ")[0]} again</Link>
        <CallLink phone={w.phone} name={w.name} onCall={logCall.bind(null, w.id, undefined)} className="btn-ghost" />

        {owed > 0 && <Say tone="dark" title={`You owe ${money(owed)}`} sub="Approved hours not yet marked paid. Go to Pay." />}

        <div className="card space-y-2">
          <div className="text-lg font-bold">Cards and licences</div>
          {licences.length === 0 && <div className="text-steel">No card details on file. Ask to see them on site.</div>}
          {licences.map((l) => {
            const lw = licenceWords(l as never);
            return (
              <div key={l.kind} className={`rounded-xl border-2 p-3 ${lw.tone === "green" ? "border-go bg-go/5" : lw.tone === "red" ? "border-warn bg-warn/5" : "border-line"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-bold">{TICKETS[l.kind] ?? l.kind}</div>
                    <div className="text-sm text-steel num">{l.number ? `No. ${l.number}` : "No number"}{l.issued_state ? ` · ${l.issued_state}` : ""}{l.expires_on ? ` · expires ${l.expires_on}` : ""}</div>
                  </div>
                  <span className={`inline-flex items-center rounded-lg px-2.5 py-1 text-sm font-bold shrink-0 ${
                    lw.tone === "green" ? "bg-go text-white" : lw.tone === "red" ? "bg-warn text-white" : "bg-site text-steel"}`}>{lw.label}</span>
                </div>
                <div className="text-sm text-steel mt-1">{l.check_note || lw.detail}</div>
              </div>
            );
          })}
          <p className="text-xs text-steel">A green tick means we checked the number against the state register. Anything else, ask to see the card on site.</p>
        </div>

        <form action={updateCrew} className="card space-y-4">
          <input type="hidden" name="worker_id" value={w.id} />
          <Field label="How do you employ them?">
            <div className="grid grid-cols-2 gap-2">
              {[["casual", "Casual"], ["fulltime", "Full-time"]].map(([k, l]) => (
                <label key={k} className="cursor-pointer">
                  <input type="radio" name="type" value={k} defaultChecked={(w.type ?? "casual") === k} className="peer sr-only" />
                  <div className="chip justify-center w-full peer-checked:bg-ink peer-checked:text-white peer-checked:border-ink">{l}</div>
                </label>
              ))}
            </div>
          </Field>
          <Field label="What you pay them per hour" hint={`Not below $${AWARD_CASUAL_FLOOR.toFixed(2)}.`}>
            <div className="flex items-center gap-2"><span className="text-3xl font-extrabold">$</span><input name="rate" type="number" step="0.05" min={AWARD_CASUAL_FLOOR} defaultValue={Number(w.rate ?? AWARD_CASUAL_FLOOR).toFixed(2)} className="input w-40 num text-2xl font-extrabold text-center" /></div>
          </Field>
          <button className="btn-dark">Save</button>
          {w.since && <div className="text-sm text-steel text-center">With you since {fmtDay(w.since)}</div>}
        </form>

        <Section title="Hours with you" hint={`${money(total)} in total`} />
        <div className="card">
          {history.length === 0 ? <div className="text-steel">No shifts yet.</div> : (
            <div className="divide-y divide-line">
              {history.map((h) => (
                <div key={h.id} className="py-2.5 flex items-center justify-between">
                  <div><div className="font-bold">{fmtDay(h.day)}</div><div className="text-steel text-sm">{h.site}</div></div>
                  <div className="text-right num"><div className="font-bold">{Number(h.hours_approved ?? h.hours_worked ?? 0) || "—"}h</div><StatusPill s={h.status} /></div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          {w.type && <ConfirmButton action={removeFromCrew.bind(null, w.id)} className="btn-ghost btn-sm w-full" msg="Remove from your crew? History is kept.">Remove from crew</ConfirmButton>}
          <ConfirmButton action={blockWorker.bind(null, w.id)} className="btn-danger btn-sm w-full" msg="Block? They'll never be matched to your shifts again.">Block</ConfirmButton>
        </div>
      </Page>
    </>
  );
}
