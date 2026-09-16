import { isIP } from "node:net";
import { headers } from "next/headers";
import { sql } from "./db";
import { OTP } from "./otp";

/** Every posted shift can buzz and text workers, so posting is capped per boss. */
export const SHIFT_POSTS_PER_HOUR = 40;

/**
 * Saving a card costs a live lookup at a government register, so one account can't do it all day.
 * Ten an hour is far more than a real worker needs (they have at most five cards) and far less
 * than number-walking needs.
 */
export const LICENCE_SAVES_PER_HOUR = 10;

/**
 * Fixed-window counter, one atomic statement: parallel requests can't all slip under the limit.
 * Returns true while the key is still within `limit` hits for the current window.
 */
export async function hit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const [r] = await sql<{ hits: number }[]>`
    INSERT INTO rate_limits AS r (key, window_start, hits) VALUES (${key}, now(), 1)
    ON CONFLICT (key) DO UPDATE SET
      hits = CASE WHEN r.window_start < now() - make_interval(secs => ${windowSeconds}) THEN 1 ELSE r.hits + 1 END,
      window_start = CASE WHEN r.window_start < now() - make_interval(secs => ${windowSeconds}) THEN now() ELSE r.window_start END
    RETURNING hits`;
  return r.hits <= limit;
}

/**
 * The caller's IP as seen by the proxy in front of us (Render appends it last to X-Forwarded-For).
 * null outside a request (scripts, tests) — callers skip IP limits then.
 */
export async function clientIp(): Promise<string | null> {
  try {
    const h = await headers();
    const xff = h.get("x-forwarded-for");
    const last = xff?.split(",").map((s) => s.trim()).filter(Boolean).pop();
    const seen = last || h.get("x-real-ip");
    return seen ? ipBucket(seen) : null;      // no proxy header: skip the per-connection gate rather than putting everyone in one bucket
  } catch {
    return null;
  }
}

/**
 * One bucket per IPv4 address, one per IPv6 /64 — a single home or phone gets a whole /64,
 * so counting each IPv6 address separately would hand an attacker billions of fresh buckets.
 */
const MAX_KEY = 64;
export function ipBucket(raw: string): string {
  // Proxies write addresses in several shapes: "1.2.3.4", "1.2.3.4:5678", "[::1]:5678", "::ffff:1.2.3.4", "fe80::1%eth0".
  const bracketed = raw.match(/^\[(.+)\](?::\d+)?$/);
  const withPort = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  const ip = (bracketed?.[1] ?? withPort?.[1] ?? raw).split("%")[0];
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) !== 6) return raw.slice(0, MAX_KEY);                  // not an address (e.g. "local") — key it as it came, bounded
  // Expand to eight groups first, so every spelling of the same address lands in the same bucket.
  const [head, tail = ""] = ip.split("::");
  const parts = (s: string) => (s ? s.split(":").filter((x) => x !== "") : []);
  const h = parts(head), t = parts(tail);
  const last = t.at(-1) ?? h.at(-1) ?? "";
  const dotted = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(last);            // "::ffff:1.2.3.4" spells its last 32 bits as IPv4
  const quad = dotted ? last.split(".").map(Number) : null;
  const tailGroups = dotted ? [...t.slice(0, -1), ((quad![0] << 8) | quad![1]).toString(16), ((quad![2] << 8) | quad![3]).toString(16)] : t;
  const headGroups = dotted && !t.length ? [...h.slice(0, -1), ((quad![0] << 8) | quad![1]).toString(16), ((quad![2] << 8) | quad![3]).toString(16)] : h;
  const groups = ip.includes("::")
    ? [...headGroups, ...Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0"), ...tailGroups]
    : headGroups;
  const g = groups.map((x) => parseInt(x || "0", 16) || 0);
  if (g.length === 8 && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".");  // IPv4 wearing an IPv6 coat, however it's spelled
  return g.slice(0, 4).map((x) => x.toString(16)).join(":") + "::/64";
}

/**
 * Is there room under this limit? A look, not a spend — so a request refused for some other reason
 * doesn't cost the person their allowance. Two callers can both see room at once and overshoot by one;
 * for cost ceilings that is the right trade against charging people for things that never happened.
 */
export async function hasRoom(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const [r] = await sql<{ hits: number }[]>`
    SELECT hits FROM rate_limits WHERE key = ${key} AND window_start > now() - make_interval(secs => ${windowSeconds})`;
  return !r || r.hits < limit;
}

/** Is the app already at its hourly ceiling for login codes? */
export const atSendCeiling = async () => !(await hasRoom("otp-send:all", OTP.sendsPerHourAll(), 3600));

/** Hand a hit back when the thing it was paying for didn't happen (a later gate refused, or the send failed). */
export const refund = (key: string, windowSeconds: number) => sql`
  UPDATE rate_limits SET hits = GREATEST(0, hits - 1)
  WHERE key = ${key} AND window_start > now() - make_interval(secs => ${windowSeconds})`;

/** When the live window `hit` opened on this key closes — null when there is no live window. */
export async function windowEndsAt(key: string, windowSeconds: number): Promise<Date | null> {
  const [r] = await sql<{ at: Date }[]>`
    SELECT window_start + make_interval(secs => ${windowSeconds}) AS at FROM rate_limits
    WHERE key = ${key} AND window_start > now() - make_interval(secs => ${windowSeconds})`;
  return r?.at ?? null;
}

/** Old windows are useless; the cron sweeps them. */
export const sweepRateLimits = () => sql`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`;
