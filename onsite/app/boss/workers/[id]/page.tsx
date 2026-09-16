import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Wallet } from "lucide-react";
import { Avatar, Flag, Say, Section, Field } from "@/components/ui";
import { StatusPill } from "@/components/StatusPill";
import { CallLink } from "@/components/CallLink";
import { ConfirmButton } from "@/components/ConfirmButton";
import { updateCrew, removeFromCrew, blockWorker, logCall } from "@/actions/boss";
import { AWARD_CASUAL_FLOOR, TICKETS, money } from "@/lib/award";
import { fmtDay, todayIso } from "@/lib/util";
import { licenceWords } from "@/lib/verify";
import { isUuid } from "@/lib/validate";
import { workerForBoss, licencesForBoss } from "@/lib/bossQueries";
export const dynamic = "force-dynamic";

export default async function WorkerProfile({ params }: { params: Promise<{ id: string }> }) {
  const u = await requireRole("boss");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [w, history, licences] = await Promise.all([
    workerForBoss(u.id, id),
    sql`SELECT b.id, b.status, b.hours_approved, b.hours_worked, s.day, s.rate, p.name AS site
        FROM bookings b JOIN shifts s ON s.id = b.shift_id JOIN projects p ON p.id = s.project_id
        WHERE b.worker_id = ${id} AND s.boss_id = ${u.id} AND b.status <> 'removed' ORDER BY s.day DESC LIMIT 40`,
    licencesForBoss(id),
  ]);
  if (!w) notFound();
  const total = history.filter((h) => h.hours_approved).reduce((a, h) => a + Number(h.hours_approved) * Number(h.rate), 0);
  const owed = history.filter((h) => h.status === "approved").reduce((a, h) => a + Number(h.hours_approved) * Number(h.rate), 0);
  const first = w.name.split(" ")[0];
  // What blocking them would actually do to work already booked (actions/boss.ts blockWorker).
  const coming = history.filter((h) => ["accepted", "clocked_in"].includes(h.status) && String(h.day) >= todayIso());
  return (
    <>
      <Header title={w.name} back="/boss/workers" />
      <Page>
        <div className="card space-y-3">
          <div className="flex items-center gap-3">
            <Avatar name={w.name} photo={w.photo} size={80} />
            <div className="flex-1 min-w-0">
              <div className="text-xl font-extrabold">{w.name}</div>
              <div className="text-steel">{w.score != null ? `Turns up ${w.score}% of the time · ${w.completed} shifts done` : "New — no shifts yet"}{w.cancels > 0 ? ` · pulled out ${w.cancels}×` : ""}</div>
              <div className="text-sm text-steel">
                {w.years_exp ? `${w.years_exp} years on the tools · ` : ""}{w.home_label || "—"}
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

        {/* Money you owe is waiting on you: same rule as "Still to pay" on the Pay screen. */}
        {owed > 0 && <Say tone="orange" icon={Wallet} title={`You owe ${money(owed)}`} sub="Approved hours you haven't marked paid. Pay them your usual way, then mark it in Pay." />}

        <div className="card space-y-2">
          <div className="text-lg font-bold">Cards and licences</div>
          {licences.length === 0 && <div className="text-steel">No card details on file. Ask to see them on site.</div>}
          {licences.map((l) => {
            const lw = licenceWords(l as never);
            return (
              <div key={l.kind} className={`rounded-xl border-2 p-3 ${lw.tone === "green" ? "border-go bg-go/5" : lw.tone === "red" ? "border-warn bg-warn/5" : "border-line"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="font-bold min-w-0">{TICKETS[l.kind] ?? l.kind}</div>
                  <Flag tone={lw.tone} className="shrink-0">{lw.label}</Flag>
                </div>
                <div className="text-sm text-steel num">{[l.issued_state, l.expires_on ? `expires ${l.expires_on}` : null].filter(Boolean).join(" · ") || "State not given"}</div>
                <div className="text-sm text-steel mt-1">{lw.detail}</div>
              </div>
            );
          })}
          <p className="text-xs text-steel">A green tick means we checked the card against the state register. Card numbers stay private to the worker — anything else, ask to see the card on site.</p>
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
          {w.type && (
            <ConfirmButton action={removeFromCrew.bind(null, w.id)} className="btn-ghost btn-sm w-full" danger={false}
              title={`Take ${first} out of your crew?`}
              details={[
                "Every shift, hour and dollar you two have on record stays.",
                `${first} isn't told, and can still be matched to your shifts.`,
                "Approving their hours puts them back in your crew.",
              ]}
              confirmLabel="Take them out" cancelLabel="Keep them">Remove from crew</ConfirmButton>
          )}
          <ConfirmButton action={blockWorker.bind(null, w.id)} className="btn-danger btn-sm w-full"
            title={`Block ${first}?`}
            details={[
              `${first} will never be matched to one of your shifts again.`,
              coming.length > 0
                ? `They come off ${coming.length} shift${coming.length > 1 ? "s" : ""} coming up and are told they were taken off — not that you blocked them.`
                : "They aren't on any of your shifts coming up, so nobody gets a message.",
              "Any deal request of theirs to you is closed, and they leave your crew.",
            ]}
            confirmLabel={`Block ${first}`} cancelLabel="Don't block">Block</ConfirmButton>
        </div>
      </Page>
    </>
  );
}
