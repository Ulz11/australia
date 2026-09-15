/**
 * Licence checking.
 *
 * What's actually possible in Australia, as of Sept 2026:
 *
 *  - There is NO national register for White Cards (general construction induction).
 *    Each state regulator runs its own, and several can only confirm over the phone.
 *  - NSW is the good one: verify.licence.nsw.gov.au carries both White Cards (GCIT)
 *    and high risk work licences. Programmatic access goes through the Service NSW
 *    API portal (api.nsw.gov.au) and needs a registered developer account + key.
 *  - Commercial aggregators (WorkClear and friends) cover builder/trade/real-estate/
 *    security licences — NOT White Cards and NOT high risk work licences. They don't
 *    solve this problem, whatever the marketing says.
 *
 * So: this module has one provider per source. NSW is wired and switches on the
 * moment NSW_LICENCE_API_KEY exists. Everywhere else falls back to a human check.
 *
 * The rule that matters: a licence is only ever marked 'verified' when a check
 * actually ran and actually matched. We never imply a check we didn't do.
 */

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

/** Is this card past its date? Checked locally regardless of register access. */
export function isExpired(expires_on?: string | null): boolean {
  if (!expires_on) return false;
  return new Date(expires_on + "T23:59:59") < new Date();
}

/**
 * NSW: SafeWork register via the Service NSW licence API.
 * Needs NSW_LICENCE_API_KEY. Until that's set this returns null and we fall back
 * to a human check — deliberately, rather than guessing at a result.
 */
async function checkNsw(req: CheckRequest): Promise<CheckResult | null> {
  const key = process.env.NSW_LICENCE_API_KEY;
  const base = process.env.NSW_LICENCE_API_URL;
  if (!key || !base) return null;
  try {
    const url = new URL(base);
    url.searchParams.set("licenceNumber", req.number);
    url.searchParams.set("licenceType", req.kind === "WC" ? "GCIT" : "HRW");
    const res = await fetch(url, { headers: { apikey: key, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;                       // treat any hiccup as "couldn't check"
    const j = (await res.json()) as Record<string, unknown> & { results?: Record<string, unknown>[]; licence?: Record<string, unknown> };
    const rec = Array.isArray(j?.results) ? j.results[0] : j?.licence ?? j;
    if (!rec) return { status: "not_found", via: "safework_nsw", note: "SafeWork NSW has no card with that number." };

    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    const expiry = str(rec.expiryDate) ?? str(rec.expires_on);
    const name = str(rec.licenceHolderName) ?? str(rec.holderName);
    const live = (str(rec.status) ?? str(rec.licenceStatus) ?? "").toLowerCase();

    if (live.includes("cancel") || live.includes("suspend"))
      return { status: "not_found", via: "safework_nsw", note: `SafeWork NSW shows this card as ${live}.`, expires_on: expiry, holder_name: name };
    if (isExpired(expiry))
      return { status: "expired", via: "safework_nsw", note: `Card expired ${expiry}.`, expires_on: expiry, holder_name: name };
    if (name && !namesMatch(name, req.holder_name))
      return { status: "mismatch", via: "safework_nsw", note: `That card is registered to a different name (${name}).`, expires_on: expiry, holder_name: name };

    return { status: "verified", via: "safework_nsw", note: "Checked against the SafeWork NSW register.", expires_on: expiry, holder_name: name };
  } catch {
    return null;
  }
}

/** Loose name match — middle names, order and punctuation differ between registers. */
export function namesMatch(a: string, b: string): boolean {
  const parts = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
  const A = parts(a), B = parts(b);
  if (!A.length || !B.length) return false;
  const shared = A.filter((w) => B.includes(w)).length;
  return shared >= Math.min(2, Math.min(A.length, B.length));
}

/**
 * Run whatever check is available for this card.
 * Always returns something honest — never a false 'verified'.
 */
export async function checkLicence(req: CheckRequest): Promise<CheckResult> {
  if (isExpired(req.expires_on))
    return { status: "expired", via: "manual", note: `This card ran out on ${req.expires_on}.` };

  if (req.issued_state === "NSW") {
    const nsw = await checkNsw(req);
    if (nsw) return nsw;
  }
  const reg = REGULATOR[req.issued_state]?.name ?? "the state regulator";
  return {
    status: "unchecked",
    via: "manual",
    note: `Card details saved. ${req.issued_state} can't be checked automatically yet — we'll confirm it with ${reg} by hand.`,
  };
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
