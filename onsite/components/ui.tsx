import Link from "next/link";
import { money } from "@/lib/award";
import { payForShift, type OtTerms } from "@/lib/rules";

/** One coloured sentence. The state of a thing, in words a first-day labourer gets. */
export function Say({ tone, title, sub, children }: { tone: "grey" | "green" | "orange" | "dark" | "red"; title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className={`say-${tone}`}>
      <div className="say-title">{title}</div>
      {sub && <div className="say-sub">{sub}</div>}
      {children}
    </div>
  );
}

/** A list row: big text left, small text under, something on the right, tap goes somewhere. */
export function Row({ href, title, sub, right, tone }: { href?: string; title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode; tone?: "orange" | "green" }) {
  const cls = `card flex items-center gap-3 ${tone === "orange" ? "border-hv border-2" : tone === "green" ? "border-go border-2" : ""}`;
  const inner = (
    <>
      <div className="flex-1 min-w-0">
        <div className="text-lg font-bold leading-tight">{title}</div>
        {sub && <div className="text-base text-steel mt-0.5">{sub}</div>}
      </div>
      {right && <div className="shrink-0 text-right">{right}</div>}
      {href && <span className="text-steel text-2xl leading-none">›</span>}
    </>
  );
  return href ? <Link href={href} className={cls}>{inner}</Link> : <div className={cls}>{inner}</div>;
}

export function Big({ n, label, hot }: { n: string | number; label: string; hot?: boolean }) {
  return (
    <div className={`rounded-2xl p-4 ${hot ? "bg-hv text-ink" : "bg-white border border-line"}`}>
      <div className="text-3xl font-extrabold num leading-none">{n}</div>
      <div className="text-sm font-semibold mt-1 opacity-80">{label}</div>
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

/* Booking state → plain words + colour. The single source for "what's going on with this worker". */
export function bookingWords(b: { status: string; clock_in_at?: string | null; hours_worked?: number | string | null; hours_approved?: number | string | null; disputed_at?: string | null }, start: string, rate: number, terms?: OtTerms, tz = "Australia/Sydney") {
  const t = (d: string) => new Date(d).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", timeZone: tz });
  const owed = () => terms ? payForShift(Number(b.hours_approved), rate, terms).gross : Number(b.hours_approved) * rate;
  switch (b.status) {
    case "accepted": return { tone: "grey" as const, title: `Coming at ${start}`, sub: "Said yes. Will clock in on site." };
    case "clocked_in": return { tone: "green" as const, title: `On site since ${t(b.clock_in_at!)}`, sub: "Working now." };
    case "clocked_out": return { tone: "orange" as const, title: `Finished · ${Number(b.hours_worked)} hours`, sub: "Check the hours and approve." };
    case "approved": return { tone: "dark" as const, title: `Approved ${Number(b.hours_approved)} hours · ${money(owed())}`, sub: b.disputed_at ? "Worker disagrees — give them a call." : "Owed. Mark paid in Pay when you've paid." };
    case "paid": return { tone: "green" as const, title: `Paid · ${money(owed())}`, sub: `${Number(b.hours_approved)} hours. Done.` };
    case "cancelled": return { tone: "red" as const, title: "Pulled out", sub: "We're asking other workers." };
    default: return { tone: "grey" as const, title: b.status, sub: "" };
  }
}
