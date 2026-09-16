"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LazyMap } from "@/components/LazyMap";
import type { Pin } from "@/components/MapPicker";
import { ShiftCard, type S } from "../Calendar";
import { takeShift } from "@/actions/worker";
import { fmtDay, todayIso } from "@/lib/util";

type XS = S & { project_id: string; avail: string };

export function Explore({ home, radiusKm, sites, shifts, q }: { home: [number, number]; radiusKm: number; sites: { id: string; name: string; lat: number; lng: number }[]; shifts: XS[]; q: string }) {
  const [view, setView] = useState<"map" | "list">("map");
  const [site, setSite] = useState<string | null>(null);
  const [query, setQuery] = useState(q);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  const today = todayIso();
  const counts = useMemo(() => { const m: Record<string, number> = {}; for (const s of shifts) if (!s.mine) m[s.project_id] = (m[s.project_id] ?? 0) + 1; return m; }, [shifts]);
  // A site is orange only where a shift on it was offered to this worker; open work nobody asked them about is ink.
  const offered = useMemo(() => { const m: Record<string, number> = {}; for (const s of shifts) if (!s.mine && s.notified) m[s.project_id] = (m[s.project_id] ?? 0) + 1; return m; }, [shifts]);
  const pins: Pin[] = [{ id: "home", lat: home[1], lng: home[0], kind: "home" as const }, ...sites.map((s) => ({
    id: s.id, lat: s.lat, lng: s.lng, label: s.name,
    count: offered[s.id] ?? counts[s.id] ?? 0,
    kind: (offered[s.id] ? "offer" : counts[s.id] ? "work" : "site") as Pin["kind"],
  }))];
  const list = (site ? shifts.filter((s) => s.project_id === site) : shifts).filter((s) => !s.mine);
  const take = (id: string) => start(async () => { setErr(null); const r = await takeShift(id); if (r?.error) setErr(r.error); });
  return (
    <div className="space-y-3">
      <div className="seg grid-cols-2">
        {(["map", "list"] as const).map((v) => <button type="button" key={v} onClick={() => setView(v)} className={`seg-item ${view === v ? "seg-on" : ""}`}>{v === "map" ? "Map" : "List"}</button>)}
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); router.push(`/worker/explore?q=${encodeURIComponent(query)}`); }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search: forklift, concreter, Newtown…" className="input" />
        <button className="btn-dark btn-sm">Go</button>
      </form>
      {view === "map" && (
        <>
          <LazyMap center={home} zoom={radiusKm > 30 ? 9 : 11} radiusKm={radiusKm} pins={pins} onPinClick={(id) => setSite(id === "home" ? null : id)} className="h-72" />
          <div className="text-steel">
            Black dot is home. <b className="text-ink">Orange pins are shifts a boss offered you.</b> White pins have work open to anyone — tap one.
            Grey dots are sites with nothing open right now.
          </div>
        </>
      )}
      {site && (
        <div className="flex items-center justify-between"><div className="text-lg font-bold">{sites.find((s) => s.id === site)?.name}</div><button className="btn-ghost btn-sm" onClick={() => setSite(null)}>Show all</button></div>
      )}
      {list.length === 0 ? <div className="card text-center text-steel text-lg py-6">{site ? "Nothing open at this site right now." : "No open shifts within your travel distance right now."}</div> : (
        <div className="space-y-3">
          <div className="text-lg font-bold">{list.length} shift{list.length > 1 ? "s" : ""} you could take</div>
          {list.map((s) => (
            <div key={s.id}>
              <div className="flex justify-between text-sm font-semibold px-1 mb-1"><span>{s.day === today ? "Today" : fmtDay(s.day)}</span><span className={s.avail === "free" ? "text-go" : "text-steel"}>{s.avail === "free" ? "You're free" : "You said busy — taking it is fine"}</span></div>
              <ShiftCard s={s} onTake={() => take(s.id)} pending={pending} />
            </div>
          ))}
          {err && <div className="say-red"><div className="say-title">{err}</div></div>}
        </div>
      )}
    </div>
  );
}
