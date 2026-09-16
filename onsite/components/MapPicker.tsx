"use client";
import { useEffect, useRef } from "react";
import { Map as MapLibreMap, Marker, NavigationControl, getVersion, setWorkerUrl, type MapMouseEvent, type StyleSpecification } from "maplibre-gl";
import { escapeHtml } from "@/lib/validate";
import "maplibre-gl/dist/maplibre-gl.css";

/** The tile worker lives in public/maplibre/<version>/ (copied by scripts/copy-maplibre-worker.mjs) — bundlers can't locate it. */
const workerUrl = () => `/maplibre/${getVersion()}/maplibre-gl-worker.mjs`;

export const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" } },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

export type Pin = { id: string; lat: number; lng: number; label?: string; count?: number; kind?: "site" | "home" | "hot" };

/**
 * One map component for every screen: pick a point (onPick), show pins, optional radius circle.
 */
export function MapView({
  center, zoom = 12, pins = [], radiusKm, onPick, onPinClick, picked, className = "h-64",
}: {
  center: [number, number]; zoom?: number; pins?: Pin[]; radiusKm?: number;
  onPick?: (lng: number, lat: number) => void; onPinClick?: (id: string) => void;
  picked?: [number, number] | null; className?: string;
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
        m.addLayer({ id: "radius-fill", type: "fill", source: "radius", paint: { "fill-color": "#FF7A00", "fill-opacity": 0.08 } });
        m.addLayer({ id: "radius-line", type: "line", source: "radius", paint: { "line-color": "#FF7A00", "line-width": 2, "line-dasharray": [2, 2] } });
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
      if (p.kind === "home") d.innerHTML = `<div class="w-4 h-4 rounded-full bg-ink border-2 border-white shadow"></div>`;
      else if (p.kind === "hot" || (p.count ?? 0) > 0)
        d.innerHTML = `<div class="flex items-center gap-1 bg-hv text-ink font-bold text-sm rounded-full pl-2 pr-2.5 py-1 shadow border-2 border-white">${p.count ?? ""}<span class="font-normal text-xs">${escapeHtml(p.label ?? "")}</span></div>`;
      else d.innerHTML = `<div class="w-3.5 h-3.5 rounded-full bg-steel border-2 border-white shadow" title="${escapeHtml(p.label ?? "")}"></div>`;
      d.onclick = (ev) => { ev.stopPropagation(); onPinClick?.(p.id); };
      markers.current.push(new Marker({ element: d }).setLngLat([p.lng, p.lat]).addTo(m));
    }
  }, [pins, onPinClick]);

  useEffect(() => {
    const m = map.current; if (!m) return;
    pickMarker.current?.remove(); pickMarker.current = null;
    if (picked) {
      const d = document.createElement("div");
      d.innerHTML = `<div class="w-6 h-6 rounded-full bg-hv border-[3px] border-ink shadow-lg"></div>`;
      pickMarker.current = new Marker({ element: d }).setLngLat(picked).addTo(m);
    }
  }, [picked]);

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

/** Free geocoder (Nominatim). Australia-biased. Be polite: 1 req/s. */
export async function geocode(q: string): Promise<{ lat: number; lng: number; label: string } | null> {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=${encodeURIComponent(q)}`, { headers: { "Accept-Language": "en" } });
  const j = await r.json();
  if (!j[0]) return null;
  return { lat: Number(j[0].lat), lng: Number(j[0].lon), label: j[0].display_name.split(",").slice(0, 3).join(",") };
}
