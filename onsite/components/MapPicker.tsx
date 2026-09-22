"use client";
import { useEffect, useRef } from "react";
import { Map as MapLibreMap, Marker, NavigationControl, getVersion, setWorkerUrl, type MapMouseEvent, type StyleSpecification } from "maplibre-gl";
import { escapeHtml } from "@/lib/validate";
import { placeLabel, searchLabel, type NominatimPlace, type Precision } from "@/lib/place";
import "maplibre-gl/dist/maplibre-gl.css";

/** The tile worker lives in public/maplibre/<version>/ (copied by scripts/copy-maplibre-worker.mjs) — bundlers can't locate it. */
const workerUrl = () => `/maplibre/${getVersion()}/maplibre-gl-worker.mjs`;

export const OSM_STYLE: StyleSpecification = {
  version: 8,
  // The attribution is rendered as HTML by MapLibre, so the copyright sign is written as an entity: the app's
  // source files hold no pictographic characters at all (tests/unit/noEmoji.test.ts).
  sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "&copy; OpenStreetMap contributors" } },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

/**
 * A pin on the map. `offer` is orange because that shift was offered to the person reading the map —
 * "place" and "work" are ink, because a site that merely exists isn't waiting on anybody.
 */
export type Pin = { id: string; lat: number; lng: number; label?: string; count?: number; kind?: "site" | "home" | "place" | "offer" | "work" };

/**
 * One map component for every screen: pick a point (onPick), show pins, optional radius circle.
 * `center` and `zoom` only place the camera at the start; pass a new `focus` object to move it later
 * (a search result, "Use my location").
 */
export function MapView({
  center, zoom = 12, pins = [], radiusKm, onPick, onPinClick, picked, focus, className = "h-64",
}: {
  center: [number, number]; zoom?: number; pins?: Pin[]; radiusKm?: number;
  onPick?: (lng: number, lat: number) => void; onPinClick?: (id: string) => void;
  picked?: [number, number] | null; focus?: { center: [number, number]; zoom: number } | null; className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const pickMarker = useRef<Marker | null>(null);

  useEffect(() => {
    if (!el.current || map.current) return;
    setWorkerUrl(workerUrl());
    const m = new MapLibreMap({ container: el.current, style: OSM_STYLE, center, zoom, attributionControl: { compact: true } });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.on("click", (e: MapMouseEvent) => onPick?.(e.lngLat.lng, e.lngLat.lat));
    m.on("load", () => {
      if (radiusKm) {
        m.addSource("radius", { type: "geojson", data: circle(center, radiusKm) });
        // How far you'll travel is information, not something waiting on you: ink, not orange.
        m.addLayer({ id: "radius-fill", type: "fill", source: "radius", paint: { "fill-color": "#15171A", "fill-opacity": 0.06 } });
        m.addLayer({ id: "radius-line", type: "line", source: "radius", paint: { "line-color": "#15171A", "line-width": 2, "line-dasharray": [2, 2] } });
      }
    });
    map.current = m;
    return () => { m.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current; if (!m) return;
    markers.current.forEach((x) => x.remove()); markers.current = [];
    for (const p of pins) {
      const d = document.createElement("div");
      d.className = "cursor-pointer";
      const label = escapeHtml(p.label ?? "");
      if (p.kind === "home") d.innerHTML = `<div class="w-4 h-4 rounded-full bg-ink border-2 border-white shadow" title="Home"></div>`;
      else if (p.kind === "offer")   // a shift offered to this worker: the one thing on the map that wants them
        d.innerHTML = `<div class="flex items-center gap-1 bg-hv text-ink font-bold text-sm rounded-full pl-2 pr-2.5 py-1 shadow border-2 border-ink">${p.count ?? ""} for you<span class="font-normal text-sm">${label}</span></div>`;
      else if (p.kind === "place")
        d.innerHTML = `<div class="flex items-center gap-1 bg-ink text-white font-bold text-sm rounded-full px-2.5 py-1 shadow border-2 border-white">${label}</div>`;
      else if (p.kind === "work" || (p.count ?? 0) > 0)
        d.innerHTML = `<div class="flex items-center gap-1 bg-white text-ink font-bold text-sm rounded-full pl-2 pr-2.5 py-1 shadow border-2 border-ink">${p.count ?? ""}<span class="font-normal text-sm">${label}</span></div>`;
      else d.innerHTML = `<div class="w-3.5 h-3.5 rounded-full bg-steel border-2 border-white shadow" title="${label}"></div>`;
      d.onclick = (ev) => { ev.stopPropagation(); onPinClick?.(p.id); };
      markers.current.push(new Marker({ element: d }).setLngLat([p.lng, p.lat]).addTo(m));
    }
  }, [pins, onPinClick]);

  useEffect(() => {
    const m = map.current; if (!m) return;
    pickMarker.current?.remove(); pickMarker.current = null;
    if (picked) {
      const d = document.createElement("div");
      d.innerHTML = `<div class="w-6 h-6 rounded-full bg-ink border-[3px] border-white shadow-lg ring-2 ring-ink"></div>`;
      pickMarker.current = new Marker({ element: d }).setLngLat(picked).addTo(m);
    }
  }, [picked]);

  useEffect(() => {
    if (focus) map.current?.easeTo({ center: focus.center, zoom: focus.zoom });
  }, [focus]);

  return <div ref={el} className={`w-full rounded-2xl overflow-hidden border border-line ${className}`} />;
}

function circle([lng, lat]: [number, number], km: number) {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    pts.push([lng + (km / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a), lat + (km / 110.57) * Math.sin(a)]);
  }
  return { type: "Feature" as const, geometry: { type: "Polygon" as const, coordinates: [pts] }, properties: {} };
}

/** Free geocoder (Nominatim). Australia-biased. Be polite: 1 req/s. The label follows the precision (lib/place.ts). */
export async function geocode(q: string, precision: Precision = "exact"): Promise<{ lat: number; lng: number; label: string } | null> {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&addressdetails=1&q=${encodeURIComponent(q)}`, { headers: { "Accept-Language": "en" } });
  if (!r.ok) return null;                                            // throttled or down: the box keeps its words, nothing moves
  const j: NominatimPlace[] = await r.json();
  if (!j[0]) return null;
  return { lat: Number(j[0].lat), lng: Number(j[0].lon), label: searchLabel(j[0], precision) };
}

/** The other way (Nominatim reverse): a name for a point — a street address, or only the suburb. One request per call. */
export async function reverseGeocode(lat: number, lng: number, precision: Precision): Promise<string | null> {
  const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`, { headers: { "Accept-Language": "en" } });
  if (!r.ok) return null;
  return placeLabel(await r.json(), precision);
}
