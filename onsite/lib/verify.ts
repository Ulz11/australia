/**
 * Licence facts and words — the client-safe half.
 *
 * This module is imported by a client component (app/worker/me/Licences.tsx), so it must stay
 * pure: no database, no fetch, no credentials. The code that actually calls a register lives in
 * lib/licenceCheck.ts, which nothing on the client may import — otherwise lib/whitecard.ts
 * (and the WHITE_CARD_* environment it reads) rides into a browser chunk on the back of a
 * `licenceWords` import. tests/integration/privacy.test.ts walks the import graph to keep it so.
 *
 * What's actually possible in Australia, as of Sept 2026:
 *
 *  - There is NO national register for White Cards (general construction induction).
 *    Each state regulator runs its own, and several can only confirm over the phone.
 *  - NSW is the good one: verify.licence.nsw.gov.au carries both White Cards (GCIT)
 *    and high risk work licences. Programmatic access goes through the Service NSW
 *    API portal (api.nsw.gov.au) and needs a registered developer account + key — and
 *    the register behind that API holds only White Cards and Traffic Control Work Cards.
 *  - Commercial aggregators (WorkClear and friends) cover builder/trade/real-estate/
 *    security licences — NOT White Cards and NOT high risk work licences. They don't
 *    solve this problem, whatever the marketing says.
 *
 * So: one provider per source, in lib/licenceCheck.ts. NSW White Cards are wired and
 * switch on the moment the WHITE_CARD_* keys exist (lib/whitecard.ts does the HTTP). NSW
 * high risk work licences are NOT in that register — they, and every other state, fall
 * back to a human check.
 *
 * The rule that matters: a licence is only ever marked 'verified' when a check
 * actually ran and actually matched. We never imply a check we didn't do.
 */
import { todayIso } from "@/lib/util";

export type LicenceKind = "WC" | "LF" | "WP" | "DG" | "SB";
export type LicenceStatus = "unchecked" | "checking" | "verified" | "not_found" | "expired" | "mismatch";

export type CheckRequest = {
  kind: LicenceKind;
  number: string;
  issued_state: string;
  holder_name: string;
  expires_on?: string | null;
};
export type CheckResult = {
  status: LicenceStatus;
  via: string;          // 'safework_nsw' | 'manual' | ...
  note: string;         // one plain sentence, shown to both sides
  expires_on?: string | null;
  holder_name?: string | null;
};

/** States whose registers we can check automatically right now. */
export const AUTO_STATES = ["NSW"] as const;

/** Card types on an automatic register. The NSW register holds White Cards, not HRW licences. */
export const AUTO_KINDS = ["WC"] as const;

/** Will this card be checked the moment it's saved? Pure — the screens ask it too. */
export function canAutoCheck(kind: string, state: string): boolean {
  return (AUTO_KINDS as readonly string[]).includes(kind) && (AUTO_STATES as readonly string[]).includes(state);
}

export const STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"] as const;

/** Where a worker goes to sort out a card themselves, per state. */
export const REGULATOR: Record<string, { name: string; url: string }> = {
  NSW: { name: "SafeWork NSW", url: "https://verify.licence.nsw.gov.au/home/GCIT" },
  VIC: { name: "WorkSafe Victoria", url: "https://www.worksafe.vic.gov.au" },
  QLD: { name: "WorkSafe Queensland", url: "https://www.worksafe.qld.gov.au" },
  WA: { name: "WorkSafe WA", url: "https://www.commerce.wa.gov.au/worksafe" },
  SA: { name: "SafeWork SA", url: "https://www.safework.sa.gov.au" },
  TAS: { name: "WorkSafe Tasmania", url: "https://worksafe.tas.gov.au" },
  ACT: { name: "WorkSafe ACT", url: "https://www.worksafe.act.gov.au" },
  NT: { name: "NT WorkSafe", url: "https://worksafe.nt.gov.au" },
};

/**
 * Is this card past its date? Checked locally regardless of register access.
 *
 * A card is good until the end of its expiry day *on site* — Sydney, not wherever the server
 * happens to run. Comparing days as strings does that in one step: a UTC box (Render is one)
 * comparing `new Date(day + "T23:59:59")` against `now` would keep a card alive for the ten
 * hours after Sydney's midnight, which is a whole working morning on an expired card.
 */
export function isExpired(expires_on?: string | null): boolean {
  const day = String(expires_on ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;   // no date, or one we can't read, is not an expired card
  return day < todayIso();
}

/** Loose name match — middle names, order and punctuation differ between registers. */
export function namesMatch(a: string, b: string): boolean {
  const parts = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
  const A = parts(a), B = parts(b);
  if (!A.length || !B.length) return false;
  const shared = A.filter((w) => B.includes(w)).length;
  return shared >= Math.min(2, Math.min(A.length, B.length));
}

/** Plain words + colour for a licence badge. Never overstates what we know. */
export function licenceWords(l: { status: LicenceStatus; checked_at?: string | null; expires_on?: string | null; issued_state?: string | null }) {
  switch (l.status) {
    case "verified":
      return { tone: "green" as const, label: "Checked ✓", detail: `Confirmed against the ${l.issued_state ?? ""} register${l.checked_at ? ` on ${new Date(l.checked_at).toLocaleDateString("en-AU")}` : ""}.` };
    case "not_found":
      return { tone: "red" as const, label: "Not on the register", detail: "The register has no current card with that number. Worker should bring the card on site." };
    case "expired":
      return { tone: "red" as const, label: "Expired", detail: `Ran out${l.expires_on ? ` on ${l.expires_on}` : ""}. Needs renewing before the next shift.` };
    case "mismatch":
      return { tone: "red" as const, label: "Name doesn't match", detail: "The card number belongs to a different name." };
    case "checking":
      return { tone: "grey" as const, label: "Being checked", detail: "We're confirming this one now." };
    default:
      return { tone: "grey" as const, label: "Card on file, not checked", detail: "Details given by the worker. Ask to see the card on site." };
  }
}
