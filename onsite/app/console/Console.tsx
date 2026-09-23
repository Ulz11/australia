"use client";
import { useEffect, useRef, useState } from "react";
import { ExternalLink, RotateCw } from "lucide-react";

type Person = { id: string; phone: string; name: string; sub: string };
type Counts = { bosses: number; workers: number; sites: number; open_shifts: number; live_bookings: number; to_approve: number; owed: number; open_offers: number; cards_to_check: number; notifs_24h: number; matches_billed: number; invoices: number; invoices_open: number };
type Ev = { id: string; kind: string; body: string; user_id: string; created_at: string; name: string; role: string };
type Env = { db: boolean; sms: string | null; nsw: boolean; push: boolean; qpay: boolean; cron: boolean; devOtp: boolean; node: string };

const local = (p: string) => p.replace("+61", "0").replace(/(\d{4})(\d{3})(\d{3})/, "$1 $2 $3");
const KIND: Record<string, string> = {
  shift_match: "shift offered", booking: "took a shift", hours_approved: "hours approved", paid: "paid", offer: "deal request",
  offer_accepted: "deal agreed", offer_declined: "deal declined", counter: "counter-offer", cancelled: "cancelled", removed: "taken off",
  approve: "clocked out", dispute: "disagrees", weather: "weather stop",
};

export function Console({ bosses, workers, counts: c0, env, tests, resultsHtml, readmeHtml }: {
  bosses: Person[]; workers: Person[]; counts: Counts; env: Env; tests: { file: string; n: number }[]; resultsHtml: string; readmeHtml: string;
}) {
  const [boss, setBoss] = useState(bosses[0]);
  const [worker, setWorker] = useState(workers[0]);
  const [counts, setCounts] = useState(c0);
  const [events, setEvents] = useState<Ev[]>([]);
  const [auto, setAuto] = useState(true);
  const [tick, setTick] = useState<{ boss: number; worker: number }>({ boss: 0, worker: 0 });
  const [lastAt, setLastAt] = useState<string | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  // Poll the feed. When the person in a frame receives something, that frame reloads —
  // it's the passive side, so nothing you're typing gets interrupted.
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/console/feed", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { events: Ev[]; counts: Counts; at: string };
        if (stop) return;
        setCounts(j.counts); setEvents(j.events); setLastAt(j.at);
        const fresh = j.events.filter((e) => !seen.current.has(e.id));
        j.events.forEach((e) => seen.current.add(e.id));
        if (primed.current && auto && fresh.length) {
          if (fresh.some((e) => e.user_id === boss.id)) setTick((t) => ({ ...t, boss: t.boss + 1 }));
          if (fresh.some((e) => e.user_id === worker.id)) setTick((t) => ({ ...t, worker: t.worker + 1 }));
        }
        primed.current = true;
      } catch { /* offline, try again */ }
    };
    poll();
    const h = setInterval(poll, 4000);
    return () => { stop = true; clearInterval(h); };
  }, [boss.id, worker.id, auto]);

  const stat = (n: number, l: string, hot?: boolean) => (
    <div className={`cr-stat ${hot && n > 0 ? "hot" : ""}`}><b>{n}</b><span>{l}</span></div>
  );

  return (
    <div className="cr">
      <header className="cr-top">
        <div className="cr-brand"><span className="cr-stripe" /><b>OnSite</b> control room</div>
        <nav className="cr-nav">
          <a href="#phones">Phones</a><a href="#money">Scenarios</a><a href="#sim">Simulation</a><a href="#project">Project</a>
        </nav>
        <div className="cr-stats">
          {stat(counts.open_shifts, "open shifts")}{stat(counts.live_bookings, "booked")}{stat(counts.to_approve, "to approve", true)}
          {stat(counts.open_offers, "requests", true)}{stat(counts.owed, "owed")}{stat(counts.cards_to_check, "cards to check")}
        </div>
      </header>

      {/* ── two phones, one database ─────────────────────────────────── */}
      <section id="phones" className="cr-section">
        <div className="cr-h">
          <h1>Two phones, one database</h1>
          <p>Post a shift on the left, take it on the right, watch the other phone update. Same live database the apps use.</p>
        </div>
        <div className="cr-stage">
          <Phone label="Boss" tone="ink" who={boss} people={bosses} onPick={setBoss} frame="boss" reload={tick.boss} onReload={() => setTick((t) => ({ ...t, boss: t.boss + 1 }))} />

          <div className="cr-feed">
            <div className="cr-feed-head">
              <div><b>Between them</b><span>{lastAt ? `live · ${new Date(lastAt).toLocaleTimeString("en-AU")}` : "connecting…"}</span></div>
              <label className="cr-toggle"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto-refresh the receiving phone</label>
              <button className="cr-btn" onClick={() => setTick((t) => ({ boss: t.boss + 1, worker: t.worker + 1 }))}>Reload both</button>
            </div>
            <ol className="cr-events">
              {events.length === 0 && <li className="cr-ev muted">Nothing yet. Post a shift on the Boss phone.</li>}
              {events.map((e) => (
                <li key={e.id} className={`cr-ev ${e.user_id === boss.id || e.user_id === worker.id ? "mine" : ""}`}>
                  <span className={`cr-dot ${e.role}`} />
                  <div>
                    <div className="cr-ev-line"><b>{e.name.split(" ")[0]}</b> <em>{KIND[e.kind] ?? e.kind}</em> <time>{ago(e.created_at)}</time></div>
                    <div className="cr-ev-body">{e.body}</div>
                  </div>
                </li>
              ))}
            </ol>
            <div className="cr-walk">
              <b>Walk the loop</b>
              <ol>
                <li>Boss → <b>Need workers</b> → Find workers</li>
                <li>Worker → <b>Offers for you</b> → <b>Take it</b></li>
                <li>Worker → My shift → Clock in → Clock out</li>
                <li>Boss → the shift → check hours → <b>Approve</b></li>
                <li>Boss → Pay → <b>Mark paid</b> · Worker → Me → Owed</li>
              </ol>
            </div>
          </div>

          <Phone label="Worker" tone="hv" who={worker} people={workers} onPick={setWorker} frame="worker" reload={tick.worker} onReload={() => setTick((t) => ({ ...t, worker: t.worker + 1 }))} />
        </div>
      </section>

      {/* ── the money ────────────────────────────────────────────────── */}
      <section id="money" className="cr-section">
        <div className="cr-h">
          <h1>Three scenarios</h1>
          {/* Said out loud rather than quietly left to read as current: the app charges $2 an introduction
              on a fortnightly invoice and nothing else, and this model has not been re-run against that. */}
          <p><b>Old pricing.</b> $1 a match and $33 a month, costed against real Stripe and Twilio pricing. Every assumption is a slider. OnSite now charges $2 an introduction, invoiced every 14 days, with no subscription — so read these three scenarios as the working, not as the plan. <a href="/money-model.html" target="_blank" rel="noreferrer">Open full screen <ExternalLink size={14} strokeWidth={2.5} aria-hidden /></a></p>
        </div>
        <iframe className="cr-money" src="/money-model.html" title="OnSite money model" />
      </section>

      {/* ── the simulation ───────────────────────────────────────────── */}
      <section id="sim" className="cr-section">
        <div className="cr-h">
          <h1>Does it work with real people in it?</h1>
          <p>The matching engine's real rules against 40 subbies and 220 workers for 8 simulated weeks. <code>python3 sim/marketplace.py</code></p>
        </div>
        <article className="cr-doc" dangerouslySetInnerHTML={{ __html: resultsHtml }} />
      </section>

      {/* ── the project ──────────────────────────────────────────────── */}
      <section id="project" className="cr-section">
        <div className="cr-h"><h1>Project</h1><p>What's wired up, what's covered, what's in the database right now.</p></div>
        <div className="cr-grid">
          <div className="cr-card">
            <h3>Environment</h3>
            <ul className="cr-env">
              <Row ok={env.db} label="Database" hint="Neon Postgres + PostGIS, Sydney" />
              <Row ok={!!env.sms} label={`SMS (${env.sms ?? "no provider"})`} hint={env.sms ? "codes go by text" : env.devOtp ? "stubbed — code shows on screen" : "not set: nobody can sign in"} warn={!env.sms && !env.devOtp} />
              <Row ok={env.nsw} label="White Card check (SafeWork NSW)" hint={env.nsw ? "automatic for NSW White Cards" : "no API key — cards marked 'not checked yet'"} />
              <Row ok={env.push} label="Phone alerts (web push)" hint={env.push ? "buzzes phones that turned alerts on; texts shift offers otherwise" : "no VAPID keys — shift offers go by text only"} warn={!env.push && !env.sms} />
              <Row ok={env.qpay} label="Payments (QPay)" hint={env.qpay ? "invoices in MNT, confirmed via payment check" : "no credentials — billing off"} />
              <Row ok={env.cron} label="Matching cron secret" hint="widens matching every 20 min" />
              <Row ok={env.node === "production"} label={`Mode: ${env.node}`} hint={env.node === "production" ? "" : "use npm run build && npm start to feel real speed"} neutral />
            </ul>
          </div>
          <div className="cr-card">
            <h3>In the database</h3>
            <div className="cr-kv">
              <span>Bosses</span><b>{counts.bosses}</b><span>Workers</span><b>{counts.workers}</b><span>Sites</span><b>{counts.sites}</b>
              <span>Open shifts</span><b>{counts.open_shifts}</b><span>Booked</span><b>{counts.live_bookings}</b><span>Awaiting approval</span><b>{counts.to_approve}</b>
              <span>Approved, unpaid</span><b>{counts.owed}</b><span>Open deal requests</span><b>{counts.open_offers}</b><span>Cards to check by hand</span><b>{counts.cards_to_check}</b>
              <span>Notifications, 24h</span><b>{counts.notifs_24h}</b>
              <span>Billable matches</span><b>{counts.matches_billed}</b><span>Invoices</span><b>{counts.invoices}</b><span>Invoices open</span><b>{counts.invoices_open}</b>
            </div>
            <p className="cr-hint">Reset with <code>npm run db:seed</code> — only touches demo phones (0400 000 xxx).</p>
          </div>
          <div className="cr-card">
            <h3>Tests · {tests.reduce((a, t) => a + t.n, 0)}</h3>
            <ul className="cr-tests">{tests.map((t) => <li key={t.file}><code>{t.file}</code><b>{t.n}</b></li>)}</ul>
            <p className="cr-hint"><code>npm test</code> runs unit + integration. Integration needs <code>DATABASE_URL</code> and a seeded DB.</p>
          </div>
          <div className="cr-card">
            <h3>Screens</h3>
            <div className="cr-routes">
              <div><b>Boss</b><span>/boss</span><span>/boss/shifts/new</span><span>/boss/shifts/[id]</span><span>/boss/projects/[id]</span><span>/boss/offers</span><span>/boss/workers</span><span>/boss/workers/[id]</span><span>/boss/pay</span><span>/boss/me</span></div>
              <div><b>Worker</b><span>/worker</span><span>/worker/explore</span><span>/worker/shift</span><span>/worker/offers</span><span>/worker/me</span></div>
              <div><b>Shared</b><span>/login</span><span>/onboarding</span><span>/join/[code]</span><span>/api/cron/expand</span></div>
            </div>
          </div>
        </div>
        <details className="cr-readme"><summary>README</summary><article className="cr-doc" dangerouslySetInnerHTML={{ __html: readmeHtml }} /></details>
      </section>

      <footer className="cr-foot">Control room is on because <code>DEMO_CONSOLE=1</code>. It signs demo accounts in without a code — keep it off in production.</footer>
    </div>
  );
}

function Phone({ label, tone, who, people, onPick, frame, reload, onReload }: {
  label: string; tone: "ink" | "hv"; who: Person; people: Person[]; onPick: (p: Person) => void; frame: "boss" | "worker"; reload: number; onReload: () => void;
}) {
  const src = `/api/console/login?frame=${frame}&phone=${encodeURIComponent(who.phone)}`;
  return (
    <div className="cr-phone-col">
      <div className={`cr-phone-bar ${tone}`}>
        <span className="cr-role">{label}</span>
        <select value={who.phone} onChange={(e) => onPick(people.find((p) => p.phone === e.target.value)!)} aria-label={`${label} account`}>
          {people.map((p) => <option key={p.phone} value={p.phone}>{p.name} · {local(p.phone)}</option>)}
        </select>
        <button className="cr-icon" onClick={onReload} title="Reload" aria-label="Reload this phone"><RotateCw size={16} strokeWidth={2.5} aria-hidden /></button>
        <a className="cr-icon" href={src} target="_blank" rel="noreferrer" title="Open in its own tab" aria-label="Open in its own tab"><ExternalLink size={16} strokeWidth={2.5} aria-hidden /></a>
      </div>
      <div className="cr-phone">
        <div className="cr-notch" />
        <iframe key={`${who.phone}-${reload}`} src={src} title={`${label} phone — ${who.name}`} />
      </div>
      <div className="cr-phone-sub">{who.sub}</div>
    </div>
  );
}

function Row({ ok, label, hint, warn, neutral }: { ok: boolean; label: string; hint: string; warn?: boolean; neutral?: boolean }) {
  return <li><span className={`cr-led ${neutral ? "grey" : ok ? "on" : warn ? "bad" : "off"}`} /><div><b>{label}</b><span>{hint}</span></div></li>;
}

function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
