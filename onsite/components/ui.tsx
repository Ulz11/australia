import Link from "next/link";
import { CalendarCheck, Check, CircleAlert, MapPin, Wallet, X, type LucideIcon } from "lucide-react";
import { money } from "@/lib/award";
import { initials } from "@/lib/util";
import { payForShift, type OtTerms } from "@/lib/rules";

/** Colour is never the message on its own: every tone has words, and orange always has an icon too. */
export type Tone = "grey" | "green" | "orange" | "dark" | "red";
const TONE_ICON: Partial<Record<Tone, LucideIcon>> = { orange: CircleAlert };

/** One coloured sentence. The state of a thing, in words a first-day labourer gets. */
export function Say({ tone, title, sub, icon, children }: {
  tone: Tone; title: string; sub?: string; icon?: LucideIcon | null; children?: React.ReactNode;
}) {
  const Icon = icon === null ? null : icon ?? TONE_ICON[tone];
  return (
    <div className={`say-${tone}`}>
      <div className="flex items-start gap-3">
        {Icon && <Icon size={24} strokeWidth={2.25} aria-hidden className="shrink-0 mt-0.5" />}
        <div className="min-w-0 flex-1">
          <div className="say-title">{title}</div>
          {sub && <div className="say-sub">{sub}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

/** A small badge: colour + icon + words, for a state that has to fit on one line. */
export function Flag({ tone = "grey", icon, children, className = "" }: {
  tone?: Tone; icon?: LucideIcon | null; children: React.ReactNode; className?: string;
}) {
  const Icon = icon === null ? null : icon ?? (tone === "orange" ? CircleAlert : tone === "green" ? Check : tone === "red" ? X : undefined);
  // The grey one is a neutral tint rather than `bg-site`: the canvas colour sitting on a white card is
  // a 1.1:1 ghost, so the badge that is supposed to be a badge reads as a stray word.
  const skin = tone === "orange" ? "bg-hv text-ink" : tone === "green" ? "bg-go text-white"
    : tone === "red" ? "bg-warn text-white" : tone === "dark" ? "bg-ink text-white" : "bg-[var(--fill-1)] text-ink";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-bold ${skin} ${className}`}>
      {Icon && <Icon size={16} strokeWidth={2.5} aria-hidden className="shrink-0" />}
      {children}
    </span>
  );
}

/**
 * A face, or the person's initials on a neutral circle. Never an emoji, never a stock icon.
 *
 * A hairline ring instead of the old `border-line`, so a photo of a dark hi-vis jacket still stops
 * somewhere against a white card without a grey hoop being drawn around every crew member.
 */
export function Avatar({ name, photo, size = 48 }: { name: string; photo?: string | null; size?: number }) {
  return (
    <div className="rounded-full bg-[var(--fill-1)] text-slab overflow-hidden shrink-0 flex items-center justify-center font-extrabold"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36), boxShadow: "inset 0 0 0 1px var(--hair)" }}>
      {photo ? <img src={photo} alt="" className="w-full h-full object-cover" /> : <span aria-hidden>{initials(name)}</span>}
    </div>
  );
}

/**
 * A list row: big text left, small text under, something on the right, tap goes somewhere.
 *
 * The tones ring themselves with an inset shadow rather than a 2px border, so a toned row and a plain
 * row in the same list have identical inner geometry and their titles line up. Orange rings in hv-dark,
 * not hv: #FF7A00 on #FFF1E4 measures 2.36:1 and a meaningful edge owes 3:1.
 */
const ROW_RING: Record<"orange" | "green", string> = {
  orange: "inset 0 0 0 1.5px #D96400, var(--shadow-card)",
  green: "inset 0 0 0 1.5px #14803F, var(--shadow-card)",
};

export function Row({ href, title, sub, right, tone }: { href?: string; title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode; tone?: "orange" | "green" }) {
  const cls = `card flex items-center gap-3 ${tone === "orange" ? "bg-hv-soft" : ""} ${href ? "cell-link" : ""}`;
  const style = tone ? { boxShadow: ROW_RING[tone] } : undefined;
  const inner = (
    <>
      <div className="flex-1 min-w-0">
        <div className="text-lg font-bold leading-tight tracking-[-0.01em]">{title}</div>
        {sub && <div className="text-base text-steel mt-0.5">{sub}</div>}
      </div>
      {right && <div className="shrink-0 text-right">{right}</div>}
      {href && <Chev />}
    </>
  );
  return href ? <Link href={href} className={cls} style={style}>{inner}</Link> : <div className={cls} style={style}>{inner}</div>;
}

/**
 * The "this row opens something" arrow. `className` exists for the bento: steel is the right quiet grey
 * on a white row, but on `cell-ink` or `cell-go` it is a grey smudge on a dark block, so a cell hands it
 * the cell's own colour instead.
 */
export function Chev({ className = "text-steel" }: { className?: string }) {
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`shrink-0 ${className}`}><path d="m9 18 6-6-6-6" /></svg>;
}

/**
 * A bento cell's outside: tone, span, where it goes, and the sentence a screen reader gets.
 *
 * `href` wraps the whole cell, not the chevron. The chevron is 22px of decoration and the thumb aiming
 * at it belongs to someone holding a ladder with the other hand, so the target is the whole 88px.
 * That 88px floor comes from `.bento`'s grid-auto-rows and not from any class here — a cell used
 * outside a `.bento` has no minimum height at all.
 */
export type CellTone = "white" | "ink" | "go" | "gos" | "warn" | "warns" | "needs" | "soft";

/**
 * Two of these are laws, not choices.
 *  - `ink` is the press-me colour on every button in the app (globals.css `.btn-primary`), so an ink
 *    cell that goes nowhere is a lie about what happens when you press it. Pair it with an `href` —
 *    that is the whole law, and every ink cell in the app keeps it. They are /boss/money's "Still to
 *    pay" and its unpaid invoices, /boss/shifts/[id]'s "approve their hours", and /worker's "Owed to
 *    me". (This line used to read "exactly two"; the count moved, the rule did not.)
 *  - `needs` is orange, and orange only ever means "this needs you, now" — one per screen, never an
 *    accent, never a highlight on a good number. It always carries an icon and words, which is what
 *    the CircleAlert default below is for.
 * `warn` is the destroyed colour — the red you press in the confirm sheet. A cell is a thing you still
 * have, so if you are reaching for it you almost certainly want `warns`: pulled out, expired, rained off.
 */
const CELL_TONE: Record<CellTone, string> = {
  white: "",
  ink: "cell-ink",
  go: "cell-go",
  gos: "cell-gos",
  warn: "cell-warn",
  warns: "cell-warns",
  needs: "cell-needs",
  soft: "cell-soft",
};

export type CellProps = {
  span?: 1 | 2;
  rows?: 1 | 2 | 3;
  tone?: CellTone;
  hot?: boolean;                 // the old name for tone="needs"; call sites don't churn
  href?: string;
  icon?: LucideIcon;
  /**
   * The cell's content is a drawing — a Heatmap, MonthBars, a SegmentBar, SiteBars, Pips, a RangeBar.
   *
   * It flips the cell: the label goes on top and the drawing takes every pixel underneath, instead of a
   * figure on top and a caption below. That is the whole difference between a chart that is a footnote
   * under a heading and a chart that IS the 2x2 — and a 2x2 here is 188px tall (88 + 12 + 88), which is
   * the room these marks were drawn for.
   */
  viz?: boolean;
  /** What a screen reader hears instead of the figure. Give it a whole sentence, with the who and the when. */
  sr?: string;
};

/**
 * The shell every cell is built from. `label` is 16/700 at full opacity and `sub` is 15/500: the old
 * 14px-at-80% label and 12px-at-60% sub are gone, because at half brightness on a sunlit screen the
 * sub was the line nobody could read and it was carrying the due date.
 *
 * A `sub` that is prose rather than a number wants `<span className="c-prose">` around it — steel for
 * words, full ink for anything a boss has to act on.
 */
export function Cell({
  span = 1, rows = 1, tone = "white", hot, href, icon, viz, sr, label, sub, className = "", children,
}: CellProps & { label?: string; sub?: React.ReactNode; className?: string; children?: React.ReactNode }) {
  const t: CellTone = hot ? "needs" : tone;
  const Icon = t === "needs" ? icon ?? CircleAlert : icon;
  const cls = ["cell", CELL_TONE[t], span === 2 ? "b-w2" : "", rows === 2 ? "b-h2" : rows === 3 ? "b-h3" : "",
    href ? "cell-link" : "", className].filter(Boolean).join(" ");

  const words = (label || sub) ? (
    <div className="min-w-0">
      {label && (
        <div className="c-label flex items-start gap-1.5">
          {Icon && <Icon size={t === "needs" ? 24 : 18} strokeWidth={2.5} aria-hidden className="shrink-0" />}
          <span className="min-w-0">{label}</span>
        </div>
      )}
      {sub && <div className="c-sub">{sub}</div>}
    </div>
  ) : null;

  const body = (
    <>
      {/* Hidden from a screen reader once `sr` is set, or it reads "1991 Still to pay" and has to guess
          who is owed it and since when. The sentence replaces the pieces; it must not repeat them. */}
      <div className={`flex flex-col justify-between flex-1 min-w-0 gap-2${href ? " pr-6" : ""}`}
        aria-hidden={sr ? true : undefined}>
        {viz
          // Label first, drawing underneath, filling what is left. A 2x2 viz cell is the mark at the size
          // it was designed for rather than a 40px strip wedged under a caption.
          ? <>{words}<div className="cell-fill">{children}</div></>
          : <>{children}{words}</>}
      </div>
      {sr && <p className="sr-only">{sr}</p>}
      {/* The cell's own colour at 70%, never steel: steel on `cell-ink` is a grey smudge on a black block.
          70 and not 60, because white at 60% on `cell-go` measures 2.82:1 and on `cell-warn` 2.86:1 —
          under the 3:1 a meaningful mark owes. At 70% the worst tone is go at 3.29:1 and every other
          one clears 4:1. */}
      {href && <Chev className="absolute top-3 right-3 text-current opacity-70" />}
    </>
  );
  return href ? <Link href={href} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

/**
 * The 2x2 a drawing lives in — `Cell` with `viz` and the span already set, so a screen asks for
 * `<Viz label="Days on the tools"><Heatmap …/></Viz>` and gets the mark at full size.
 *
 * `span` and `rows` are still overridable, because a WeekStrip wants 2x1 and a Pips row wants 1x1;
 * the default is the shape most of these marks were drawn for.
 */
export function Viz({ span = 2, rows = 2, ...cell }: CellProps & {
  label?: string; sub?: React.ReactNode; className?: string; children?: React.ReactNode;
}) {
  return <Cell viz span={span} rows={rows} {...cell} />;
}

/**
 * A number in a cell. 30/800 on its own, 34/800 across two columns — a 2-wide cell has the room and a
 * figure that leads the cell should look like it does. `unit` is the word after it ("hours", "km") at
 * 18/700 in the figure's own colour, so "6.5 hours" stays one object rather than a number and a label.
 */
export function Big({ n, unit, label, sub, ...cell }: CellProps & {
  n: string | number; unit?: string; label: string; sub?: React.ReactNode;
}) {
  return (
    // min-w-0: a grid item won't shrink below its content without it, so a long value pushes out of the cell.
    <Cell {...cell} label={label} sub={sub}>
      <div className={`${cell.span === 2 ? "c-fig-2" : "c-fig"} flex items-baseline gap-1 min-w-0`}>
        <span className="truncate">{n}</span>
        {unit && <span className="c-unit shrink-0">{unit}</span>}
      </div>
    </Cell>
  );
}

/**
 * A money tile. Dollars big, cents small: the exact figure in about half the width, because "$1,991.00"
 * at one size overflows a third of a phone screen. `hero` is the number being acted on — 48/800, and the
 * only size at which a boss reads what they owe from arm's length.
 *
 * `n` is DOLLARS, because `money()` here is lib/award's. lib/subscription counts in cents and its helper
 * is `moneyCents`. Feeding cents to this one prints $3,300.00 for a $33 charge, which has already shipped.
 */
export function BigMoney({ n, label, sub, hero, ...cell }: CellProps & {
  n: number; label: string; sub?: React.ReactNode; hero?: boolean;
}) {
  const [dollars, cents] = money(n).split(".");
  return (
    <Cell {...cell} label={label} sub={sub}>
      <div className={`${hero ? "c-hero" : cell.span === 2 ? "c-fig-2" : "c-fig"} min-w-0`}>
        {dollars}<span className="text-[0.5em] align-top">.{cents}</span>
      </div>
    </Cell>
  );
}

export const Money = ({ n }: { n: number }) => <span className="num">{money(n)}</span>;

/**
 * Section heading with a one-line explanation.
 *
 * This is where the sentence goes when a tile has to shrink. A 1x1 holds a figure and two or three
 * words; anything longer belongs here or in the cell's `sr` sentence, never crammed into the tile.
 */
export function Section({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="pt-3 pb-0.5">
      <h2 className="text-[22px] font-bold leading-tight tracking-[-0.02em]">{title}</h2>
      {hint && <div className="text-base text-steel mt-0.5 leading-snug">{hint}</div>}
    </div>
  );
}

/** Field with a label and a one-line hint underneath. 15px on the hint: 14px is chart-axis-only. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-base font-bold mb-1.5">{label}</div>
      {children}
      {hint && <div className="text-[15px] text-steel mt-1.5 leading-snug">{hint}</div>}
    </div>
  );
}

/* Booking state → plain words + colour + icon. The single source for "what's going on with this worker". */
export function bookingWords(b: { status: string; clock_in_at?: string | null; hours_worked?: number | string | null; hours_approved?: number | string | null; disputed_at?: string | null }, start: string, rate: number, terms?: OtTerms, tz = "Australia/Sydney") {
  const t = (d: string) => new Date(d).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", timeZone: tz });
  const owed = () => terms ? payForShift(Number(b.hours_approved), rate, terms).gross : Number(b.hours_approved) * rate;
  switch (b.status) {
    case "accepted": return { tone: "grey" as const, icon: CalendarCheck, title: `Coming at ${start}`, sub: "Said yes. Will clock in on site." };
    case "clocked_in": return { tone: "green" as const, icon: MapPin, title: `On site since ${t(b.clock_in_at!)}`, sub: "Working now." };
    case "clocked_out": return { tone: "orange" as const, icon: CircleAlert, title: `Finished · ${Number(b.hours_worked)} hours`, sub: "Check the hours and approve." };
    // Approved and owed is information. A worker who disagrees is waiting on you — that one is orange.
    case "approved": return b.disputed_at
      ? { tone: "orange" as const, icon: CircleAlert, title: `${Number(b.hours_approved)} hours approved · ${money(owed())}`, sub: "They disagree with these hours — give them a call." }
      : { tone: "dark" as const, icon: Wallet, title: `Approved ${Number(b.hours_approved)} hours · ${money(owed())}`, sub: "Owed. Mark paid in Pay when you've paid." };
    case "paid": return b.disputed_at
      ? { tone: "orange" as const, icon: CircleAlert, title: `Paid · ${money(owed())}`, sub: "They disagree with the hours — give them a call." }
      : { tone: "green" as const, icon: Check, title: `Paid · ${money(owed())}`, sub: `${Number(b.hours_approved)} hours. Done.` };
    case "cancelled": return { tone: "red" as const, icon: X, title: "Pulled out", sub: "We're asking other workers." };
    default: return { tone: "grey" as const, icon: undefined, title: b.status, sub: "" };
  }
}
