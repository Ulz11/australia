"use client";
import { useState } from "react";
import { geocode } from "./MapPicker";
import { LazyMap as MapView } from "./LazyMap";

/** Address box + map. Search or tap the map; writes lat/lng/label to hidden inputs. */
export function AddressPin({ initial, labelName = "home_label", placeholder = "Suburb or address" }:
  { initial?: { lat: number; lng: number; label?: string } | null; labelName?: string; placeholder?: string }) {
  const [q, setQ] = useState(initial?.label ?? "");
  const [pt, setPt] = useState<[number, number] | null>(initial ? [initial.lng, initial.lat] : null);
  const [busy, setBusy] = useState(false);
  const center: [number, number] = pt ?? [151.16, -33.90]; // Inner West Sydney
  async function search() {
    if (!q.trim()) return;
    setBusy(true);
    const g = await geocode(q).catch(() => null);
    setBusy(false);
    if (g) { setPt([g.lng, g.lat]); setQ(g.label); }
  }
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} name={labelName} placeholder={placeholder} className="input"
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }} />
        <button type="button" onClick={search} className="btn-dark shrink-0" disabled={busy}>{busy ? "…" : "Find"}</button>
      </div>
      <MapView key={pt ? "p" : "n"} center={center} zoom={pt ? 14 : 11} picked={pt} onPick={(lng, lat) => setPt([lng, lat])} />
      <p className="text-xs text-steel">Tap the map to move the pin.</p>
      <input type="hidden" name="lat" value={pt?.[1] ?? ""} />
      <input type="hidden" name="lng" value={pt?.[0] ?? ""} />
    </div>
  );
}
