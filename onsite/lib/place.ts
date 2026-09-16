/**
 * Pins and place names, with no map and no browser in sight — so the rules can be tested.
 *
 * A building site needs its exact spot: workers walk to it. A worker's home does not, and storing it would
 * say where they sleep. So a home is kept to two decimal places of a degree — the pin lands within about
 * 0.55 km north–south and 0.46 km east–west of the real spot in Sydney — and is named by suburb, never street.
 */
export type Precision = "exact" | "suburb";

/** What the text box says when we have a pin but no name for it. */
export const PINNED = "Pinned on the map";

export const HOME_DECIMALS = 2;

export const roundCoord = (n: number, decimals = HOME_DECIMALS) => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};

/**
 * The point as it will be stored, [lng, lat] like the map. Every way of choosing it — a search, a tap on the
 * map, "Use my location" — goes through here, and the server applies it again to a home.
 */
export const pinFor = (lng: number, lat: number, precision: Precision): [number, number] =>
  precision === "suburb" ? [roundCoord(lng), roundCoord(lat)] : [lng, lat];

/** The bits of a Nominatim answer we read (`format=json&addressdetails=1` search, or `format=jsonv2` reverse). */
export type NominatimPlace = { lat?: string; lon?: string; display_name?: string; address?: Record<string, string | undefined>; error?: string };

const STATES: Record<string, string> = {
  "New South Wales": "NSW", Victoria: "VIC", Queensland: "QLD", "Western Australia": "WA",
  "South Australia": "SA", Tasmania: "TAS", "Australian Capital Territory": "ACT", "Northern Territory": "NT",
};
/** Nominatim names a suburb differently depending on how the area is mapped — most specific first. */
const SUBURB = ["suburb", "town", "village", "hamlet", "locality", "city_district", "neighbourhood", "quarter", "city", "municipality"];
const ROAD = ["road", "pedestrian", "footway", "path"];

const first = (a: Record<string, string | undefined>, keys: string[]) => keys.map((k) => a[k]?.trim()).find(Boolean);

/**
 * A name for a point, from Nominatim's address parts.
 *  - exact:  "12 Smith Street, Marrickville" (house number + road + suburb, whichever exist)
 *  - suburb: "Marrickville NSW" — nothing narrower than the suburb
 * Null when the answer has nothing usable, so the caller can fall back to PINNED.
 */
export function placeLabel(place: NominatimPlace | null | undefined, precision: Precision): string | null {
  const a = place?.address;
  if (!a) return null;
  const suburb = first(a, SUBURB);
  if (precision === "suburb") {
    if (!suburb) return null;
    const state = a.state?.trim();
    return !state ? suburb : STATES[state] ? `${suburb} ${STATES[state]}` : `${suburb}, ${state}`;
  }
  const road = first(a, ROAD);
  const street = road ? [a.house_number?.trim(), road].filter(Boolean).join(" ") : null;
  return [street, suburb].filter(Boolean).join(", ") || null;
}

/** The label after a typed search: a site keeps the search's own wording; a home is cut back to its suburb. */
export function searchLabel(place: NominatimPlace, precision: Precision): string {
  if (precision === "suburb") return placeLabel(place, "suburb") ?? PINNED;
  return (place.display_name ?? "").split(",").slice(0, 3).join(",") || PINNED;
}

/** "Use my location" failed. GeolocationPositionError.code: 1 permission denied, 2 unavailable, 3 timeout. */
export const locationError = (code: number) =>
  code === 1
    ? "Location is off for OnSite. Allow it in your browser settings, or type the address."
    : "Couldn't find your location. Type the address instead.";
