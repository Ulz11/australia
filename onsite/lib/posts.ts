/**
 * One job post, several kinds of worker. Each line of "Who do you need?" becomes its own shift row and the rows
 * posted together share a post_id (db/migrations/009_shift_posts.sql). No server-only imports: the form uses this too.
 */
import { TICKETS } from "./award";
import { clampRate, normaliseTickets, MAX_RATE } from "./rules";

export const ROLES = ["General labourer", "Formworker", "Concreter", "Carpenter", "Steel fixer", "Forklift driver", "Scaffolder", "Dogman / rigger", "Cleaner / demo"];
export const MAX_LINES = 6;
export const MAX_SPOTS = 20;

export type PostLine = { role: string; spots: number; rate: number; tickets: string[] };
export type LinesRead = { ok: true; lines: PostLine[] } | { ok: false; error: string };

const LINE_FIELDS = ["line_role", "line_spots", "line_rate"] as const;

/** Did the form send a list of lines, rather than the one role / spots / rate a crew booking (or an older form) sends? */
export const hasLines = (form: FormData) => LINE_FIELDS.some((k) => form.has(k)) || [...form.keys()].some((k) => k.startsWith("line_tickets_"));

/**
 * The lines of a post, checked as if the form were never there: parallel arrays of the same length, 1–6 lines,
 * a role from the list, 1–20 workers each, licences we know (White Card always added), pay never under the Award.
 * Refuses rather than repairs — a post that isn't what the boss meant would wake the wrong phones.
 */
export function readPostLines(form: FormData): LinesRead {
  const [roles, spots, rates] = LINE_FIELDS.map((k) => form.getAll(k));
  const n = roles.length;
  const garbled = { ok: false as const, error: "Something went wrong with the list of workers. Check it and try again." };
  if (n === 0 || spots.length !== n || rates.length !== n) return garbled;
  if (n > MAX_LINES) return { ok: false, error: `Up to ${MAX_LINES} kinds of worker in one job. Post the rest as another job.` };
  for (const k of new Set(form.keys())) {
    const m = /^line_tickets_(.*)$/.exec(k);
    if (m && !(/^\d+$/.test(m[1]) && Number(m[1]) < n)) return garbled;   // licences for a line that isn't there
  }
  const known = Object.keys(TICKETS);
  const lines: PostLine[] = [];
  for (let i = 0; i < n; i++) {
    const role = typeof roles[i] === "string" ? String(roles[i]).trim() : "";
    if (!ROLES.includes(role)) return { ok: false, error: "Pick what each worker will be doing from the list." };
    const s = typeof spots[i] === "string" && /^\d{1,2}$/.test(String(spots[i]).trim()) ? Number(String(spots[i]).trim()) : NaN;
    if (!(s >= 1 && s <= MAX_SPOTS)) return { ok: false, error: `Each kind of worker needs between 1 and ${MAX_SPOTS} people.` };
    const tix = form.getAll(`line_tickets_${i}`);
    if (tix.some((t) => typeof t !== "string" || !known.includes(t))) return { ok: false, error: "One of those licences isn't one we know." };
    const rate = clampRate(typeof rates[i] === "string" ? rates[i] : NaN);
    if (rate > MAX_RATE) return { ok: false, error: `Pay has to be under $${MAX_RATE} an hour.` };
    lines.push({ role, spots: s, rate, tickets: normaliseTickets(tix) });
  }
  return { ok: true, lines };
}

/** "2 × Carpenter, 1 × Forklift driver" */
export const linesInWords = (lines: { spots: number; role: string }[]) => lines.map((l) => `${l.spots} × ${l.role}`).join(", ");

/** "1 of 2 booked" */
export const fillWords = (taken: number, spots: number) => `${taken} of ${spots} booked`;

/** Rows → jobs: each job sits where its first line came, its lines in the order they came. A shift with no post_id is a job of its own. */
export function groupByPost<T extends { id: string; post_id: string | null }>(rows: T[]): { key: string; lines: T[] }[] {
  const jobs: { key: string; lines: T[] }[] = [];
  const byKey = new Map<string, { key: string; lines: T[] }>();
  for (const r of rows) {
    const key = r.post_id ?? r.id;
    const job = byKey.get(key);
    if (job) job.lines.push(r);
    else { const j = { key, lines: [r] }; byKey.set(key, j); jobs.push(j); }
  }
  return jobs;
}
