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
  const skin = tone === "orange" ? "bg-hv text-ink" : tone === "green" ? "bg-go text-white"
    : tone === "red" ? "bg-warn text-white" : tone === "dark" ? "bg-ink text-white" : "bg-site text-ink";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm font-bold ${skin} ${className}`}>
      {Icon && <Icon size={16} strokeWidth={2.5} aria-hidden className="shrink-0" />}
      {children}
    </span>
  );
}

/** A face, or the person's initials on a neutral circle. Never an emoji, never a stock icon. */
export function Avatar({ name, photo, size = 48 }: { name: string; photo?: string | null; size?: number }) {
  return (
    <div className="rounded-full bg-site border border-line text-slab overflow-hidden shrink-0 flex items-center justify-center font-extrabold"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}>
      {photo ? <img src={photo} alt="" className="w-full h-full object-cover" /> : <span aria-hidden>{initials(name)}</span>}
    </div>
  );
}

/** A list row: big text left, small text under, something on the right, tap goes somewhere. */
export function Row({ href, title, sub, right, tone }: { href?: string; title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode; tone?: "orange" | "green" }) {
  const cls = `card flex items-center gap-3 ${tone === "orange" ? "border-hv border-2 bg-hv-soft" : tone === "green" ? "border-go border-2" : ""}`;
  const inner = (
    <>
      <div className="flex-1 min-w-0">
        <div className="text-lg font-bold leading-tight">{title}</div>
        {sub && <div className="text-base text-steel mt-0.5">{sub}</div>}
      </div>
      {right && <div className="shrink-0 text-right">{right}</div>}
      {href && <Chev />}
    </>
  );
  return href ? <Link href={href} className={cls}>{inner}</Link> : <div className={cls}>{inner}</div>;
}

/** The "this row opens something" arrow. */
export function Chev() {
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-steel"><path d="m9 18 6-6-6-6" /></svg>;
}

export function Big({ n, label, hot, icon, sub }: { n: string | number; label: string; hot?: boolean; icon?: LucideIcon; sub?: string }) {
  const Icon = hot ? icon ?? CircleAlert : icon;
  return (
    // min-w-0: a grid item won't shrink below its content without it, so a long value pushes out of the card.
    <div className={`rounded-2xl p-4 min-w-0 ${hot ? "bg-hv text-ink" : "bg-white border border-line"}`}>
      <div className="text-3xl font-extrabold num leading-none">{n}</div>
      <div className="text-sm font-semibold mt-1 opacity-80 flex items-center gap-1.5">
        {Icon && <Icon size={16} strokeWidth={2.5} aria-hidden className="shrink-0" />}{label}
      </div>
      {sub && <div className="text-xs mt-0.5 opacity-60">{sub}</div>}
    </div>
  );
}

/**
 * A money tile. Dollars big, cents small: the exact figure in about half the width, because
 * "$1,991.00" at one size overflows a third of a phone screen. `hero` is the number being acted on.
 */
export function BigMoney({ n, label, hot, hero, icon, sub }: { n: number; label: string; hot?: boolean; hero?: boolean; icon?: LucideIcon; sub?: string }) {
  const [dollars, cents] = money(n).split(".");
  const Icon = hot ? icon ?? CircleAlert : icon;
  return (
    <div className={`rounded-2xl p-4 min-w-0 ${hot ? "bg-hv text-ink" : "bg-white border border-line"}`}>
      <div className={`num font-extrabold leading-none tracking-tight ${hero ? "text-4xl" : "text-[clamp(1.25rem,6.5vw,1.875rem)]"}`}>
        {dollars}<span className="text-[0.5em] align-top">.{cents}</span>
      </div>
      <div className="text-sm font-semibold mt-1 opacity-80 flex items-center gap-1.5">
        {Icon && <Icon size={16} strokeWidth={2.5} aria-hidden className="shrink-0" />}{label}
      </div>
      {sub && <div className="text-xs mt-0.5 opacity-60">{sub}</div>}
    </div>
  );
}

export const Money = ({ n }: { n: number }) => <span className="num">{money(n)}</span>;

/** Section heading with a one-line explanation. */
export function Section({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="pt-2">
      <div className="text-xl font-extrabold">{title}</div>
      {hint && <div className="text-base text-steel">{hint}</div>}
    </div>
  );
}

/** Field with a label and a one-line hint underneath. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-base font-bold mb-1.5">{label}</div>
      {children}
      {hint && <div className="text-sm text-steel mt-1">{hint}</div>}
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
