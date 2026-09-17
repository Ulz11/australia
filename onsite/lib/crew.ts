/**
 * Reading a list of people off a boss's phone. Server side — it needs the app's own phone rules — so that the
 * preview on screen and the import that follows read the same list from the same text (actions/boss.ts never
 * trusts what the browser sends back). The words that go with it are lib/crewWords.ts, re-exported here.
 */
import { sql } from "./db";
import { normalisePhone } from "./sms";
import { phoneAllowed } from "./otp";
import { MAX_IMPORT } from "./crewWords";

export * from "./crewWords";

export type CrewEntry = {
  /** E.164, as normalisePhone writes it. */
  phone: string;
  /** What the boss called them, if they typed a name. */
  name: string | null;
};
export type CrewParse = {
  entries: CrewEntry[];
  /** Lines that weren't an Australian mobile, exactly as they were typed, for the preview to show. */
  dropped: string[];
  /** True when they pasted more than MAX_IMPORT usable numbers; the extras are left out, not silently added. */
  overflowed: boolean;
};

/**
 * "One per line. Name first if you like: `Batbayar 0412 345 678`". The number is whatever the line ends with,
 * the name is whatever came before it. The same number twice is one person — the first line that named them
 * wins, so pasting a list over the top of a shorter one doesn't lose the names.
 */
export function parseCrewList(text: string): CrewParse {
  const entries: CrewEntry[] = [];
  const dropped: string[] = [];
  const seen = new Map<string, number>();
  let overflowed = false;

  for (const raw of String(text ?? "").split(/[\n\r]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(.*?)([+\d][\d\s()+.-]*)$/.exec(line);
    const phone = m ? normalisePhone(m[2]) : null;
    if (!phone || !phoneAllowed(phone)) { dropped.push(line.slice(0, 60)); continue; }
    const name = (m![1] ?? "").replace(/[\s,;:–—-]+$/, "").trim().slice(0, 60) || null;
    const at = seen.get(phone);
    if (at !== undefined) { if (!entries[at].name && name) entries[at].name = name; continue; }
    if (entries.length >= MAX_IMPORT) { overflowed = true; continue; }
    seen.set(phone, entries.length);
    entries.push({ phone, name });
  }
  return { entries, dropped, overflowed };
}


/**
 * The cron's 90-day sweep. A number a boss typed in is kept only long enough to recognise the person if they
 * sign up; after that it is deleted. A row that has already joined is the record of who brought whom, which
 * is what keeps that worker from ever being billed as an introduction, so it stays.
 */
export async function sweepCrewInvites(): Promise<{ expired: number }> {
  const gone = await sql`DELETE FROM crew_invites WHERE joined_at IS NULL AND expires_at < now()`;
  return { expired: gone.count };
}
