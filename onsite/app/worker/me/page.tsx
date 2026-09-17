import { requireRole } from "@/lib/session";
import { Empty, Header, Page } from "@/components/Header";
import { Avatar, Flag, Row, Say, Section } from "@/components/ui";
import { Heatmap } from "@/components/Heatmap";
import { MonthBars } from "@/components/MonthBars";
import { RecordTiles } from "@/components/RecordTiles";
import { Facts } from "@/components/Facts";
import { Milestones } from "@/components/Milestones";
import { InviteLink } from "./InviteLink";
import { ShiftRow } from "./ShiftRow";
import { money, TICKETS } from "@/lib/award";
import { addDays, TZ, todayIso } from "@/lib/util";
import { licenceWords } from "@/lib/verify";
import { share, SMALL_N, workerRecord } from "@/lib/profileStats";
export const dynamic = "force-dynamic";

/** "Mar 2026" — how long someone has been here, to the month. A day would be false precision. */
const monthYear = (d: Date | string) => new Date(d).toLocaleDateString("en-AU", { month: "short", year: "numeric", timeZone: TZ });

export default async function Me() {
  const u = await requireRole("worker");
  const r = await workerRecord(u.id);
  const today = todayIso();
  const rel = r.reliability;
  const base = process.env.NEXT_PUBLIC_BASE_URL || "";

  // What they do, in their own order: the trades they have actually been paid for, then what they ticked.
  const doing = (r.trades.length ? r.trades.map((t) => t.role) : r.ticked).slice(0, 2);
  const trade = [doing.join(" · "), r.years_exp ? `${r.years_exp} yrs on the tools` : null].filter(Boolean).join(" · ");
  const shifts = `${r.shifts} shift${r.shifts === 1 ? "" : "s"}`;
  // Under five past shifts there is no percentage worth printing, so the line says so instead of guessing.
  const turnUp = rel.past >= SMALL_N ? `Turns up ${Math.round((100 * rel.showed) / rel.past)}% · ${shifts}` : `New — ${shifts}`;
  const line = [turnUp, r.since ? `on OnSite since ${monthYear(r.since)}` : null].filter(Boolean).join(" · ");

  const wc = r.licences.find((l) => l.kind === "WC" && l.status === "verified");
  const owedTotal = r.owed.reduce((a, b) => a + r.gross(b), 0);
  const soon = addDays(today, 30);
  const monthsOn = r.since ? Math.floor((Date.parse(today) - new Date(r.since).getTime()) / 2_629_800_000) : 0;

  return (
    <>
      <Header title="Me" />
      <Page>
        <div className="card space-y-2">
          <div className="flex items-center gap-3">
            <Avatar name={r.name || u.name!} photo={r.photo} size={64} />
            <div className="flex-1 min-w-0">
              <div className="text-xl font-extrabold truncate">{r.name || u.name}</div>
              {trade && <div className="text-steel">{trade}</div>}
            </div>
          </div>
          <div className="num">{line}</div>
          {wc && <Flag tone="green">White Card checked{wc.issued_state ? `, ${wc.issued_state}` : ""}</Flag>}
          {/* Who looked is never said, only how many. The promise is written down on /privacy. */}
          {r.lookers > 0 && <div className="text-steel num">{r.lookers} boss{r.lookers === 1 ? "" : "es"} looked at your profile this week</div>}
        </div>

        <Say tone={r.owed.length ? "dark" : "grey"} title={r.owed.length ? `Owed to me: ${money(owedTotal)}` : "Owed to me: $0"}
          sub={r.owed.length ? `${r.owed.length} shift${r.owed.length > 1 ? "s" : ""} approved, not yet paid. Bosses' names below.` : "When a boss approves your hours, it shows here until they pay you."} />

        <RecordTiles year={tiles(r.tiles.year)} all={tiles(r.tiles.all)} />

        <Heatmap weeks={r.weeks}
          title="Days on the tools"
          sub={r.days === 0 ? "Your first shift starts your record." : r.streak >= 2 ? `${r.streak} weeks in a row` : undefined}
          label={`Days on the tools: ${r.days} days worked in the last 52 weeks.`} />

        {r.hours > 0 && <MonthBars title="Hours by month" months={r.months} />}

        <Facts title="Reliability" hint="What a boss sees." facts={[
          { label: "Turned up", value: `${rel.showed} of ${rel.past}` },
          { label: "Clocked in on time", value: rel.clockIns >= SMALL_N ? share(rel.onTime, rel.clockIns) : `${rel.onTime} of ${rel.clockIns}`, sub: "Within ten minutes of the start." },
          { label: "Pulled out after booking", value: rel.pulled },
          { label: "Hours disagreed", value: `${rel.disagreed} of ${rel.ofWorked}` },
        ]} />

        <Section title="Work passport" hint="Hours by trade, and the cards behind them." />
        <Facts facts={[
          ...(r.trades.length ? r.trades.map((t) => ({ label: t.role, value: `${t.hours}h` })) : [{ label: "No hours yet", value: "—" }]),
          { label: "Bosses who'd book you again", value: r.rehires },
        ]} />
        <div className="card space-y-2">
          <div className="text-lg font-bold">My cards</div>
          {r.licences.length === 0
            ? <Row href="/worker/me/edit" title="Add or update your cards" sub="Nearly every shift needs a White Card." />
            : r.licences.map((l) => {
              const w = licenceWords(l as never);
              // Orange is "this needs you": a card that has run out, or one that runs out inside a month.
              const needs = w.tone === "red" || (l.expires_on != null && l.expires_on <= soon);
              return (
                <div key={l.kind} className="flex items-center justify-between gap-2 py-1">
                  <div className="min-w-0">
                    <div className="font-bold">{TICKETS[l.kind] ?? l.kind}</div>
                    <div className="text-sm text-steel num">{[l.issued_state, l.expires_on ? `expires ${l.expires_on}` : null].filter(Boolean).join(" · ") || "State not given"}</div>
                  </div>
                  <Flag tone={needs ? "orange" : w.tone === "green" ? "green" : "grey"} className="shrink-0">
                    {needs && w.tone !== "red" ? "Renew soon" : w.label}
                  </Flag>
                </div>
              );
            })}
        </div>

        <Milestones items={[
          { key: "first", label: "First shift", done: r.shifts >= 1, togo: "1 to go" },
          { key: "hours", label: "100 hours", done: r.hours >= 100, togo: `${Math.ceil(100 - r.hours)} to go` },
          { key: "sites", label: "10 sites", done: r.sites >= 10, togo: `${10 - r.sites} to go` },
          { key: "rehires", label: "5 rehires", done: r.rehires >= 5, togo: `${5 - r.rehires} to go` },
          { key: "year", label: "1 year on OnSite", done: monthsOn >= 12, togo: `in ${Math.max(1, 12 - monthsOn)} months` },
        ]} />

        <InviteLink url={`${base}/join/${r.invite_code}`} code={r.invite_code} mates={r.mates} />

        <Section title="Shifts" hint={r.history.length ? "Newest first." : undefined} />
        {r.history.length === 0
          ? <Empty>Nothing on the record yet. Your first shift starts it.</Empty>
          : <div className="card divide-y divide-line">
              {r.history.slice(0, 10).map((h) => <ShiftRow key={h.id} h={h} gross={r.gross} />)}
            </div>}
        {r.history.length > 10 && <Row href="/worker/me/shifts" title={`All ${r.history.length} shifts`} />}

        <Row href="/worker/offers" title="My deal requests" sub="Jobs where you asked for different pay or hours." />
        <Row href="/worker/me/edit" title="Edit profile" sub="Photo, trades, languages, cards." />
        <Row href="/worker/me/settings" title="Settings" sub="Where you work, alerts, sign-in, sign out." />
      </Page>
    </>
  );
}

/** The four tiles, for one span of time. Earned is the only one nobody else ever sees. */
const tiles = (t: { hours: number; shifts: number; sites: number; earned: number }) => [
  { label: "Hours", n: t.hours },
  { label: "Shifts", n: t.shifts },
  { label: "Sites", n: t.sites },
  { label: "Earned", money: t.earned, locked: true },
];
