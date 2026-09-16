"use client";
import { useState, useSyncExternalStore } from "react";
import { geocode, reverseGeocode } from "./MapPicker";
import { LazyMap as MapView } from "./LazyMap";
import { PINNED, locationError, pinFor, type Precision } from "@/lib/place";

const INNER_WEST: [number, number] = [151.16, -33.90];
/** How close to zoom once we know the spot: the street for a site, the neighbourhood for a home. */
const NEAR = { exact: 17, suburb: 14 } as const;

/** Only offer "Use my location" where the browser can actually ask: it has geolocation and the page is https (or localhost). */
const canLocate = () => "geolocation" in navigator && window.isSecureContext;
const noSubscribe = () => () => {};

/**
 * Address box + map. Search, "Use my location", or tap the map; writes lat/lng/label to hidden inputs.
 * `precision`: "exact" for a site; "suburb" for a worker's home — the pin is rounded to about a kilometre and
 * the name is the suburb, whichever way it was chosen (lib/place.ts).
 */
export function AddressPin({ initial, labelName = "home_label", placeholder = "Suburb or address", precision }:
  { initial?: { lat: number; lng: number; label?: string } | null; labelName?: string; placeholder?: string; precision: Precision }) {
  const [q, setQ] = useState(initial?.label ?? "");
  const [pt, setPt] = useState<[number, number] | null>(initial ? pinFor(initial.lng, initial.lat, precision) : null);
  const [focus, setFocus] = useState<{ center: [number, number]; zoom: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const gps = useSyncExternalStore(noSubscribe, canLocate, () => false);

  /** Every way of placing the pin comes through here, so a home is rounded however it was chosen. */
  function place(lng: number, lat: number, move: boolean) {
    const p = pinFor(lng, lat, precision);
    setPt(p);
    if (move) setFocus({ center: p, zoom: NEAR[precision] });
  }

  async function search() {
    if (!q.trim()) return;
    setBusy(true);
    setGpsError(null);
    const g = await geocode(q, precision).catch(() => null);
    setBusy(false);
    if (g) { place(g.lng, g.lat, true); setQ(g.label); }
  }

  function locate() {
    setGpsError(null);
    setLocating(true);
    const failed = (code: number) => { setLocating(false); setGpsError(locationError(code)); };
    try {
      navigator.geolocation.getCurrentPosition(async ({ coords }) => {
        place(coords.longitude, coords.latitude, true);
        // One name lookup per tap. If it fails the pin still stands and the form still saves.
        const label = await reverseGeocode(coords.latitude, coords.longitude, precision).catch(() => null);
        setQ(label ?? PINNED);
        setLocating(false);
      }, (e) => failed(e.code), { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 });
    } catch {
      failed(2);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} name={labelName} placeholder={placeholder} className="input flex-1 min-w-0"
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }} />
        <button type="button" onClick={search} className="btn-dark w-auto shrink-0 px-6" disabled={busy || locating}>{busy ? "…" : "Find"}</button>
      </div>
      {gps && (
        <button type="button" onClick={locate} className="btn-ghost" disabled={busy || locating}>
          {locating ? "Finding you…" : "Use my location"}
        </button>
      )}
      {gpsError && <p role="alert" className="text-warn font-semibold">{gpsError}</p>}
      <MapView center={pt ?? INNER_WEST} zoom={pt ? NEAR[precision] : 11} focus={focus} picked={pt} onPick={(lng, lat) => place(lng, lat, false)} />
      <p className="text-xs text-steel">
        {precision === "suburb" ? "Tap the map to move the pin. We only keep your area, to about a kilometre." : "Tap the map to move the pin."}
      </p>
      <input type="hidden" name="lat" value={pt?.[1] ?? ""} />
      <input type="hidden" name="lng" value={pt?.[0] ?? ""} />
    </div>
  );
}
