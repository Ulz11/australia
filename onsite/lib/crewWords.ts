/**
 * The words a boss's own crew list uses, and the shapes the screens pass around. Client-safe — no database, no
 * node built-ins — because the Add-your-crew screen is a client component. Reading a pasted list is the server's
 * job and lives in lib/crew.ts, which re-exports everything here.
 */

/** One import at a time. A crew is a crew, not a mailing list. */
export const MAX_IMPORT = 50;
/** Invites one boss may send in a day (lib/ratelimit hit). */
export const INVITES_PER_DAY = 200;
/** How long an invited number is kept before the cron deletes it. */
export const INVITE_DAYS = 90;

/** "0412 345 678" — an Australian mobile the way it is written on a van. Anything else comes back as it is. */
export const prettyPhone = (e164: string) => {
  const m = /^\+614(\d{4})(\d{4})$/.exec(e164);
  return m ? `04${m[1].slice(0, 2)} ${m[1].slice(2)}${m[2].slice(0, 1)} ${m[2].slice(1)}` : e164;
};

/** What the boss's own list calls someone: the name they typed, or the number they typed it for. */
export const crewLabel = (e: { name: string | null; phone: string }) => e.name || prettyPhone(e.phone);

/** The link that puts whoever opens it on this boss's crew list. */
export const crewJoinUrl = (base: string, code: string) => `${base.replace(/\/+$/, "")}/join/c/${code}`;

/**
 * What the boss sends from their own phone (Web Share, or copied). It carries their name and their company
 * because they are the one sending it.
 */
export const crewShareText = (boss: { firstName: string; company: string }, url: string) =>
  `${boss.firstName} from ${boss.company} put you on the OnSite crew list. Sign up here and you're in: ${url}`;

/**
 * What OnSite texts, when a text provider is configured. Fixed wording: a text goes to someone who has never
 * used OnSite and costs money to send, so nothing a boss typed — their company name included — travels in it.
 * They find out whose crew it is when they open the link.
 */
export const crewInviteSms = (url: string) =>
  `OnSite: a boss has put you on their crew list so they can book you for shifts. Sign up here and you're in: ${url} Didn't expect this? Ignore it.`;

/** What previewCrew hands back: one row per number, in the order they were typed. */
export type CrewPreviewRow = { phone: string; name: string | null; label: string; known: boolean };
export type CrewPreview =
  | { ok: true; rows: CrewPreviewRow[]; dropped: string[]; overflowed: boolean }
  | { ok: false; error: string };

/** What importCrew hands back, so the screen can move straight on to sending them the link. */
export type CrewImport =
  | { ok: true; added: number; invited: number; code: string | null; company: string; firstName: string }
  | { ok: false; error: string };

/** What "Text them for me" hands back. */
export type CrewTextResult = { ok: true; sent: number } | { ok: false; error: string };

/** The worker's notification when a boss adds someone who is already on OnSite. */
export const crewAddedWords = (company: string) =>
  `${company} added you to their crew. They can book you directly. Not your boss? Leave the crew in Me → Settings.`;

/** The boss's notification when an invited number signs up. */
export const crewJoinedWords = (name: string) => `${name} joined your crew.`;
