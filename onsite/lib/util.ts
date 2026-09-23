/**
 * "Wed 4 Nov". `locale` is the reader's language on a translated screen (lib/i18n LOCALES); everything else
 * about it stays put. A plain date has no time zone of its own, so it is anchored at UTC midnight and read
 * back in UTC — the only way it can't slide a day either side of midnight in Sydney.
 */
export const fmtDay = (d: string, locale = "en-AU") =>
  new Date(d + "T00:00:00Z").toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
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
/**
 * How long ago, short enough for a list row. Split in two so a translated screen can put the number where its
 * own grammar needs it: `agoParts` gives the English key and the number, `ago` is the English sentence.
 */
export function agoParts(d: Date | string, now: Date = new Date()): { key: string; n: number } {
  const mins = Math.floor((now.getTime() - new Date(d).getTime()) / 60000);
  if (mins < 2) return { key: "just now", n: 0 };
  if (mins < 60) return { key: "{n} min ago", n: mins };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { key: "{n} h ago", n: hours };
  const days = Math.floor(hours / 24);
  if (days === 1) return { key: "yesterday", n: 1 };
  if (days < 30) return { key: "{n} days ago", n: days };
  const months = Math.floor(days / 30);
  return months < 12 ? { key: "{n} months ago", n: months } : { key: "over a year ago", n: 12 };
}

/** "just now", "2 h ago", "3 days ago" — in English. */
export function ago(d: Date | string, now: Date = new Date()): string {
  const { key, n } = agoParts(d, now);
  return key.split("{n}").join(String(n));
}
/** "BE" for Batbayar Erdene. A run of spaces is not a name, so it is skipped rather than read as a blank initial. */
export const initials = (name: string) => name.trim().split(/\s+/).filter(Boolean).map((s) => s[0]).join("").slice(0, 2).toUpperCase();

/**
 * A number out of Postgres, or null. Postgres hands every `numeric` back as a string — boss_stats gives
 * "2.0", not 2 — so a column interpolated straight into a sentence read "approves hours in about 2.0 h",
 * and any arithmetic on it would have concatenated rather than added. This is the one place that turns
 * one into a number, and it keeps null as null rather than the 0 that `Number(null)` would give.
 */
export const numOrNull = (v: string | number | null | undefined): number | null => (v == null ? null : Number(v));
