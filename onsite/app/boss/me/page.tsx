import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Row } from "@/components/ui";
import { Heatmap } from "@/components/Heatmap";
import { RecordTiles } from "@/components/RecordTiles";
import { Facts } from "@/components/Facts";
import { money } from "@/lib/award";
import { matchFeeCents, money as cents, statusWords } from "@/lib/subscription";
import { matchesThisPeriod } from "@/lib/invoicing";
import { bossRecord, fillWords, share, SMALL_N, WINDOW_DAYS } from "@/lib/profileStats";
export const dynamic = "force-dynamic";

export default async function BossMe() {
  const u = await requireRole("boss");
  const [r, matches] = await Promise.all([bossRecord(u.id), matchesThisPeriod(u.id)]);
  const p = r.pulse;

  // Under five approvals there is nothing to average, so the line says "new" instead of a number nobody can trust.
  const speed = [r.approveHours != null ? `approves hours in ${r.approveHours} h` : null, r.payDays != null ? `pays in ${r.payDays} days` : null].filter(Boolean).join(" · ");
  const seen = r.approved >= SMALL_N && speed
    ? `Workers see: ${speed}`
    : `New — ${r.approved} shift${r.approved === 1 ? "" : "s"} approved`;

  return (
    <>
      <Header title="Me" />
      <Page>
        <div className="card">
          <div className="text-xl font-extrabold">{r.company ?? u.name}</div>
          {r.abn && <div className="text-steel num">ABN {r.abn}</div>}
          <div className="text-steel">{r.company ? u.name : ""}{r.company ? " · " : ""}{u.phone}</div>
          <div className="mt-1 num">{seen}</div>
        </div>
        {!r.company && <Row href="/boss/me/settings" tone="orange" title="Company details missing" sub="Your company name goes on the top of every invoice. Add it in Settings." />}

        <RecordTiles year={tiles(r.tiles.year)} all={tiles(r.tiles.all)} />

        <Heatmap weeks={r.weeks}
          title="People on site"
          sub={r.days === 0 ? "Book someone and this fills in." : "Darker = more people."}
          label={`People on site: workers on the tools on ${r.days} days in the last 52 weeks.`} />

        <Facts title={`Hiring pulse · last ${WINDOW_DAYS} days`} facts={[
          { label: "Shifts filled", value: p.spots === 0 ? "—" : p.shifts >= SMALL_N ? `${Math.round((100 * p.taken) / p.spots)}%` : `${p.taken} of ${p.spots}`, sub: "Spots taken out of spots posted." },
          { label: "Typical time to fill", value: fillWords(p.fillMin), sub: "From posting it to the first worker saying yes." },
          { label: "No-shows on your sites", value: p.noShows, sub: `Out of ${p.pastShifts} past shift${p.pastShifts === 1 ? "" : "s"}. Rained-off days don't count.` },
          { label: "Bookings by returning workers", value: share(p.returning, p.bookings) },
        ]} />

        <Facts title="Your regulars" hint="Most hours with you."
          facts={r.regulars.length
            ? r.regulars.map((w) => ({ label: w.name, value: `${w.hours}h`, href: `/boss/workers/${w.id}` }))
            : [{ label: "Nobody yet", value: "—" }]} />

        <Facts title="Wages by site · this month"
          facts={r.sites.length ? r.sites.map((s) => ({ label: s.name, value: money(s.wages) })) : [{ label: "Nothing approved this month", value: "—" }]} />

        <Facts facts={[{ label: "Hours disagreed by workers", value: `${r.disputes.n} of ${r.disputes.of}` }]}
          foot="Workers see this too. Ring them before approving fewer hours than they recorded." />

        <Facts title="OnSite" facts={[
          { label: "Introductions this month", value: `${matches} · ${cents(matchFeeCents() * matches)}`, sub: "A worker OnSite found you, first time their hours were approved." },
        ]} />
        {/* Billing lives on its own screen; this says where the boss stands without opening it. */}
        <Row href="/boss/billing" title="Billing" sub={statusWords({ status: r.status, trial_ends_at: r.trial_ends_at, period_ends_at: r.period_ends_at }).title} />
        <Row href="/boss/me/settings" title="Settings" sub="Company details, alerts, sign-in, sign out." />
      </Page>
    </>
  );
}

const tiles = (t: { shifts: number; hours: number; wages: number; workers: number }) => [
  { label: "Shifts staffed", n: t.shifts },
  { label: "Hours bought", n: t.hours },
  { label: "Wages approved", money: t.wages },
  { label: "Workers", n: t.workers },
];
