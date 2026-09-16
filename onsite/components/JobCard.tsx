import Link from "next/link";

export type JobLine = { id: string; title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode; tone?: "orange" | "green" };

/**
 * One job with several kinds of worker (lib/posts.ts): when, where and how long said once, then a row per kind
 * of worker that opens its own shift. A job with one kind of worker is still a plain Row.
 */
export function JobCard({ title, sub, lines, tone }: { title: React.ReactNode; sub?: React.ReactNode; lines: JobLine[]; tone?: "orange" | "green" }) {
  return (
    <div className={`card p-0 overflow-hidden ${tone === "orange" ? "border-hv border-2" : tone === "green" ? "border-go border-2" : ""}`}>
      <div className="px-4 pt-4 pb-3">
        <div className="text-lg font-bold leading-tight">{title}</div>
        {sub && <div className="text-base text-steel mt-0.5">{sub}</div>}
      </div>
      <ul className="border-t border-line divide-y divide-line">
        {lines.map((l) => (
          <li key={l.id}>
            <Link href={`/boss/shifts/${l.id}`} className="flex items-center gap-3 px-4 py-3 min-h-[64px]">
              <span aria-hidden className={`w-1.5 self-stretch rounded-full shrink-0 ${l.tone === "orange" ? "bg-hv" : l.tone === "green" ? "bg-go" : "bg-line"}`} />
              <div className="flex-1 min-w-0">
                <div className="text-base font-bold leading-tight">{l.title}</div>
                {l.sub && <div className="text-sm text-steel mt-0.5">{l.sub}</div>}
              </div>
              {l.right && <div className="shrink-0 text-right">{l.right}</div>}
              <span className="text-steel text-2xl leading-none">›</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
