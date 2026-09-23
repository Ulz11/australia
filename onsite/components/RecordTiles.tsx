"use client";
import { useSyncExternalStore } from "react";
import { Lock } from "lucide-react";
import { Big, BigMoney } from "./ui";

/**
 * The four tiles at the top of a record, on a "This year · All time" switch. Both sets are worked out on the
 * server and sent down, so flicking between them is instant and costs no query.
 *
 * The choice is remembered in this browser only — a preference, not a setting anyone else needs to see. It is
 * read as an external store so the server and the first paint agree on This year and the browser's own choice
 * takes over straight after; a browser that refuses storage (private window, storage blocked) gets This year
 * every time and nothing throws.
 *
 * Every word arrives as a prop. Both /worker/me and /boss/me draw this, and boss screens stay English
 * (lib/i18n/index.ts: getLang() answers "en" for a boss whatever the cookie says) — so the worker caller
 * passes t(…) and the boss caller passes plain strings, and neither the component nor a dictionary import
 * has to know which side it is on.
 */
const KEY = "onsite.record.range";
type Range = "year" | "all";

const listeners = new Set<() => void>();
const read = (): Range => { try { return localStorage.getItem(KEY) === "all" ? "all" : "year"; } catch { return "year"; } };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const write = (v: Range) => {
  try { localStorage.setItem(KEY, v); } catch { /* no storage here; the switch still works for this visit */ }
  for (const l of listeners) l();
};

/** `money` picks the dollars tile; `locked` adds the padlock and the line that says who can see it. */
export type Tile = { label: string; n?: string | number; money?: number; locked?: boolean };

export function RecordTiles({ year, all, yearLabel = "This year", allLabel = "All time", lockedSub = "only you see this" }: {
  year: Tile[]; all: Tile[]; yearLabel?: string; allLabel?: string; lockedSub?: string;
}) {
  const range = useSyncExternalStore(subscribe, read, () => "year" as Range);
  return (
    <div className="space-y-3">
      <div className="seg grid-cols-2">
        {([["year", yearLabel], ["all", allLabel]] as const).map(([v, label]) => (
          <button key={v} type="button" onClick={() => write(v)} aria-pressed={range === v}
            className={`seg-item ${range === v ? "seg-on" : ""}`}>{label}</button>
        ))}
      </div>
      {/* .bento, not a bare grid-cols-2: these four ARE tiles — the 12px seam the lifted cards need, the
          88px thumb floor, and the same two columns everything else on the screen is interlocked into.
          Four 1x1s, which is what a figure and a two-word label earn. */}
      <div className="bento">
        {(range === "year" ? year : all).map((t) => (
          t.money != null
            ? <BigMoney key={t.label} n={t.money} label={t.label} icon={t.locked ? Lock : undefined} sub={t.locked ? lockedSub : undefined} />
            : <Big key={t.label} n={t.n ?? 0} label={t.label} icon={t.locked ? Lock : undefined} sub={t.locked ? lockedSub : undefined} />
        ))}
      </div>
    </div>
  );
}
