import Link from "next/link";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { Big } from "@/components/ui";
import { money, SUPER_RATE } from "@/lib/award";
import { payForShift } from "@/lib/rules";
import { addDays, fmtDay, todayIso, weekStart } from "@/lib/util";
import { markPaidMany } from "@/actions/boss";
import { PaidToggle } from "./PaidToggle";
export const dynamic = "force-dynamic";

export default async function Pay({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const u = await requireRole("boss");
  const { week } = await searchParams;
  const ws = weekStart(week || todayIso());
  const we = addDays(ws, 6);
  const rows = await sql`SELECT b.id, b.worker_id, b.hours_approved, b.status, b.pay_reason, s.day,
               COALESCE(b.agreed_rate, s.rate) AS rate, s.ot_mode, s.ot_after_hours, s.ot_multiplier,
               s.weather_stop, us.name, c.type
        FROM bookings b JOIN shifts s ON s.id = b.shift_id JOIN users us ON us.id = b.worker_id
        LEFT JOIN crew c ON c.worker_id = b.worker_id AND c.boss_id = ${u.id}
        WHERE s.boss_id = ${u.id} AND b.status IN ('approved','paid') AND s.day BETWEEN ${ws} AND ${we}
        ORDER BY us.name, s.day`;
  // Each shift carries the overtime terms agreed when it was posted.
  const terms = (r: { ot_mode?: string; ot_after_hours?: number; ot_multiplier?: number | null }) =>
    ({ ot_mode: (r.ot_mode ?? "award") as never, ot_after_hours: r.ot_after_hours ?? 8, ot_multiplier: r.ot_multiplier ?? null });
  type R = (typeof rows)[number];
  const byWorker = new Map<string, { name: string; type: string | null; days: R[]; gross: number; superAmt: number; hours: number; paid: boolean }>();
  for (const r of rows) {
    const p = payForShift(Number(r.hours_approved), Number(r.rate), terms(r as never));
    const w = byWorker.get(r.worker_id) ?? { name: r.name, type: r.type, days: [] as R[], gross: 0, superAmt: 0, hours: 0, paid: true };
    w.days.push(r); w.gross += p.gross; w.superAmt += p.superAmt; w.hours += Number(r.hours_approved); w.paid = w.paid && r.status === "paid";
    byWorker.set(r.worker_id, w);
  }
  const totals = [...byWorker.values()].reduce((a, w) => ({ gross: a.gross + w.gross, sup: a.sup + w.superAmt, owed: a.owed + (w.paid ? 0 : w.gross) }), { gross: 0, sup: 0, owed: 0 });

  return (
    <>
      <Header title="Pay" right={<a href={`/boss/pay/export?week=${ws}`} className="btn-ghost btn-sm">Export</a>} />
      <Page>
        <div className="flex items-center justify-between card py-2">
          <Link href={`/boss/pay?week=${addDays(ws, -7)}`} className="btn-ghost btn-sm">‹ Last week</Link>
          <div className="text-center font-bold">{fmtDay(ws)} – {fmtDay(we)}</div>
          <Link href={`/boss/pay?week=${addDays(ws, 7)}`} className="btn-ghost btn-sm">Next ›</Link>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Big n={money(totals.owed)} label="Still to pay" hot={totals.owed > 0} /><Big n={money(totals.gross)} label="Wages this week" /><Big n={money(totals.sup)} label="Super on top" />
        </div>

        <p className="text-steel">
          Each day is paid on the overtime terms you agreed when you posted that shift. Super {SUPER_RATE * 100}% is on top of every number here.
        </p>

        {byWorker.size === 0 ? <Empty>No approved hours this week.</Empty> : [...byWorker.entries()].map(([wid, w]) => (
          <div key={wid} className="card">
            <div className="flex items-center justify-between gap-2">
              <Link href={`/boss/workers/${wid}`} className="text-lg font-bold">{w.name} <span className="text-sm text-steel font-normal">{w.type === "fulltime" ? "Full-time" : "Casual"}</span></Link>
              <PaidToggle paid={w.paid} ids={w.days.map((d) => d.id)} action={markPaidMany} />
            </div>
            <div className="mt-2 num divide-y divide-line">
              {w.days.map((d) => { const p = payForShift(Number(d.hours_approved), Number(d.rate), terms(d as never)); return (
                <div key={d.id} className="py-1.5">
                  <div className="flex justify-between">
                    <span>{fmtDay(d.day)} · {Number(d.hours_approved)}h{p.ot150 + p.ot200 > 0 ? <span className="text-hv-dark text-sm"> ({p.ot150 + p.ot200}h overtime)</span> : null}</span>
                    <span>{money(p.gross)}</span>
                  </div>
                  <div className="text-xs text-steel">{p.words}{p.appliedFloor ? " — topped up to the Award" : ""}{d.pay_reason ? ` · ${d.pay_reason}` : ""}</div>
                </div>); })}
              <div className="py-2 flex justify-between text-lg font-extrabold"><span>{w.hours}h</span><span>{money(w.gross)}</span></div>
              <div className="text-sm text-steel pt-1">+ {money(w.superAmt)} super to their fund</div>
            </div>
          </div>
        ))}
      </Page>
    </>
  );
}
