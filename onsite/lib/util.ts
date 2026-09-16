export const fmtDay = (d: string) =>
  new Date(d + "T00:00:00Z").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
/** A week, short enough for a phone: "14 – 20 Sept", or "28 Sept – 4 Oct" across a month boundary. */
export const fmtRange = (a: string, b: string) => {
  const at = new Date(a + "T00:00:00Z"), bt = new Date(b + "T00:00:00Z");
  const part = (d: Date, month: boolean) =>
    d.toLocaleDateString("en-AU", { day: "numeric", ...(month ? { month: "short" } : {}), timeZone: "UTC" });
  return `${part(at, at.getUTCMonth() !== bt.getUTCMonth())} – ${part(bt, true)}`;
};
export const fmtTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "pm" : "am";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${ap}`;
};
export const km = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
export const TZ = process.env.NEXT_PUBLIC_APP_TZ || "Australia/Sydney";
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/** Today's date in site-local time (Australia/Sydney by default). */
export const todayIso = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
export const addDays = (iso: string, n: number) => { const d = new Date(iso); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
/** Monday of the week containing iso */
export const weekStart = (iso: string) => { const d = new Date(iso); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return isoDay(d); };
export function hoursBetween(a: Date, b: Date) { return Math.round(((b.getTime() - a.getTime()) / 36e5) * 2) / 2; }
export const initials = (name: string) => name.split(" ").map((s) => s[0]).join("").slice(0, 2).toUpperCase();
