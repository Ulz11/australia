/**
 * Running the checks — the half that talks to a register, and so the half that must never
 * reach a browser. lib/verify.ts holds everything the screens need (words, states, dates);
 * this file holds everything that needs a credential. Keep it that way: a client component
 * that imports from here drags lib/whitecard.ts and the WHITE_CARD_* environment with it.
 * tests/integration/privacy.test.ts fails the build's tests if that ever happens.
 *
 * Two rules run through all of it:
 *  - a card is only 'verified' when a check actually ran and actually matched;
 *  - the answer we hand back never repeats the register's name for someone else's card.
 *    Anyone can type a number into the form; the reply must not tell them whose it is.
 */
import { verifyWhiteCard, whitecardConfigured, whitecardChecksPerDay, sameNumber } from "@/lib/whitecard";
import { hit, refund, windowEndsAt } from "@/lib/ratelimit";
import {
  AUTO_KINDS, REGULATOR, canAutoCheck, isExpired, namesMatch,
  type CheckRequest, type CheckResult,
} from "@/lib/verify";

/** One budget for the whole app, one day wide — see whitecardChecksPerDay in lib/whitecard.ts. */
const CHECKS_KEY = "whitecard:all";
const DAY = 86_400;

/**
 * Buy one call at the register, or don't make it.
 *
 * Counted in the same atomic statement that checks it, so a burst of saves can't all slip under
 * the day's ceiling. A call that was made and then failed is NOT handed back — NSW counted it
 * against the quota whatever it answered — but a call we refused to make costs the budget nothing,
 * so a day at the ceiling doesn't run the counter up for ever.
 */
async function spendCheck(): Promise<boolean> {
  const ok = await hit(CHECKS_KEY, whitecardChecksPerDay(), DAY);
  if (!ok) await refund(CHECKS_KEY, DAY);
  return ok;
}

/**
 * When the day's register budget opens again: the end of the window spendCheck's counter is in.
 * null when no window is live (nothing spent yet, or the sweep took it) — the budget is open now.
 * The re-check queue parks a card that the ceiling turned away until then, rather than asking again every run.
 */
export const checksResumeAt = () => windowEndsAt(CHECKS_KEY, DAY);

/** The register's own word. Anything we don't recognise is not a card to send someone on site with. */
const isCurrent = (status?: string | null) => (status ?? "").trim().toLowerCase() === "current";

/**
 * This register holds two things: White Cards and Traffic Control Work Cards, and only the first
 * is the card this app asks for. The live rows say "General Construction Induction Training Card"
 * — never "White Card" — so the gate is the word `induction`. "White Card" is allowed beside it
 * because the register's own sample data uses that wording: if the API ever switches back, a
 * loose gate keeps checking cards, while a strict one would call every White Card in the app a
 * fake overnight. Nothing but a White Card is spelled either way.
 */
const isWhiteCard = (type?: string | null) => /induction|white\s*card/i.test(type ?? "");

/** The register's text, made safe to put in a sentence we show and store. */
const plain = (s: string, max = 60) => s.replace(/\s+/g, " ").trim().slice(0, max);

const regulatorName = (state: string) => REGULATOR[state]?.name ?? "the state regulator";

/** Why a check that was due gave no answer — see CheckResult.retryable in lib/verify.ts. */
type NoAnswer = NonNullable<CheckResult["retryable"]>;

/**
 * NSW: the SafeWork White Card register, via the Service NSW API.
 *  - null           not ours to ask: the keys aren't set, or the card isn't the kind that register holds.
 *                   The caller falls back to a human, and there is nothing to retry.
 *  - "cap_refused"  the day's budget is spent, so we didn't ask.
 *  - "failed"       we asked and nothing usable came back (network, timeout, token, 4xx/5xx, throttled
 *                   with 429/503, a body we can't read).
 * Both of the last two are "couldn't check", never "not on the register" — and they are told apart
 * right here, where each one happens, so the re-check queue never has to guess from the wording.
 */
async function checkNsw(req: CheckRequest): Promise<CheckResult | NoAnswer | null> {
  if (req.kind !== "WC" || !whitecardConfigured()) return null;
  // The day's budget is charged here because this line is the last thing before a call leaves the
  // building, and this is the only place that calls the register. At the ceiling the answer is
  // "couldn't check", so the worker gets the honest note. Never not_found: a budget of ours is not
  // the register saying anything about their card.
  if (!(await spendCheck())) {
    console.error("White Card checks paused — WHITECARD_CHECKS_PER_DAY reached");
    return "cap_refused";
  }
  const rows = await verifyWhiteCard(req.number);
  if (rows === null) return "failed";                              // couldn't check — never "not on the register"

  const mine = rows.filter((r) => sameNumber(r.licenceNumber, req.number));
  const cards = mine.filter((r) => isWhiteCard(r.licenceType));
  if (!cards.length) {
    // The number is real but it isn't a White Card: say which card it is, so the worker can file it right.
    const other = mine.map((r) => r.licenceType).find(Boolean);
    if (other) return { status: "not_found", via: "safework_nsw", note: `That number is a ${plain(other)}, not a White Card.` };
    if (mine.length)   // a row with no type at all: we can't say it is a White Card, and we won't say it isn't
      return { status: "unchecked", via: "manual", note: "Card details saved. SafeWork NSW didn't say what type of card that number is — we'll confirm it by hand." };
    return { status: "not_found", via: "safework_nsw", note: "SafeWork NSW has no White Card with that number." };
  }
  const rec = cards.find((r) => isCurrent(r.status)) ?? cards[0];  // several cards on one number: the live one wins

  const expiry = rec.expiryDate ?? null;
  const word = rec.status ?? "";
  // The register's name only ever comes back out of here when it is the name we were handed.
  // Otherwise the form becomes a name lookup: type numbers, collect strangers.
  const holder = rec.licensee && namesMatch(rec.licensee, req.holder_name) ? rec.licensee : null;

  if (/^expired$/i.test(word))
    return { status: "expired", via: "safework_nsw", note: `SafeWork NSW shows this card expired${expiry ? ` on ${expiry}` : ""}.`, expires_on: expiry, holder_name: holder };
  if (!isCurrent(word))
    return { status: "not_found", via: "safework_nsw", note: `SafeWork NSW shows this card as ${plain(word, 40) || "not current"}.`, expires_on: expiry, holder_name: holder };
  if (isExpired(expiry))
    return { status: "expired", via: "safework_nsw", note: `Card expired ${expiry}.`, expires_on: expiry, holder_name: holder };
  if (rec.licensee && !holder)
    return { status: "mismatch", via: "safework_nsw", note: "SafeWork NSW has that number under a different name. Check the number printed on the card.", expires_on: expiry, holder_name: null };

  return { status: "verified", via: "safework_nsw", note: "Checked against the SafeWork NSW register.", expires_on: expiry, holder_name: holder };
}

/**
 * Run whatever check is available for this card.
 * Always returns something honest — never a false 'verified'.
 */
export async function checkLicence(req: CheckRequest): Promise<CheckResult> {
  if (isExpired(req.expires_on))
    return { status: "expired", via: "manual", note: `This card ran out on ${req.expires_on}.` };

  const auto = canAutoCheck(req.kind, req.issued_state);
  let retryable: NoAnswer | null = null;
  if (auto) {
    const nsw = await checkNsw(req);
    if (nsw && typeof nsw === "object") return nsw;
    retryable = nsw;
  }
  const reg = regulatorName(req.issued_state);
  if (retryable)                                                             // the check didn't run: say so, don't guess
    return { status: "unchecked", via: "manual", retryable,
      note: `Card details saved. We couldn't reach ${reg} just now — we'll try again soon, and confirm it with ${reg} by hand if we still can't.` };
  const why = auto
    ? `We couldn't reach ${reg} just now`
    : (AUTO_KINDS as readonly string[]).includes(req.kind)
      ? `${req.issued_state} can't be checked automatically yet`
      : `This card isn't on a register we can check`;
  return { status: "unchecked", via: "manual", note: `Card details saved. ${why} — we'll confirm it with ${reg} by hand.` };
}

/** The note a card keeps once the re-check queue has run out of tries: a person takes it from here. */
export const gaveUpNote = (state: string) =>
  `Card details saved. We still couldn't reach ${regulatorName(state)} — we'll confirm it with ${regulatorName(state)} by hand.`;
