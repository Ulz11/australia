/** Small input guards so a bad form value returns a message instead of a 500. */
export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z"));
export const isTime = (v: unknown): v is string => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
/** Numeric form field → number within [lo, hi], or the fallback when it isn't a number. */
export const num = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
/** Latitude/longitude that could plausibly be a place on Earth (and not the 0,0 default). */
export const isLatLng = (lat: unknown, lng: unknown) =>
  typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)
  && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
/**
 * An ABN, checked the way the ATO's own rule does rather than just counted: knock one off the first digit,
 * weight the eleven digits 10, 1, 3, 5… and the sum divides by 89. Returns the eleven digits with the spaces
 * taken out — that is what gets stored — or null for anything that isn't a real ABN.
 */
const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
export function cleanAbn(v: unknown): string | null {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (digits.length !== 11) return null;
  const sum = ABN_WEIGHTS.reduce((a, w, i) => a + w * (Number(digits[i]) - (i === 0 ? 1 : 0)), 0);
  return sum % 89 === 0 ? digits : null;
}

/** Escape text before it goes into innerHTML. */
export const escapeHtml = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
