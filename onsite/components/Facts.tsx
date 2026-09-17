import Link from "next/link";
import { Chev } from "./ui";

/** One line of the record: what it is on the left, the number on the right, tabular so a column lines up. */
export type Fact = { label: React.ReactNode; value: React.ReactNode; sub?: string; href?: string };

export function Facts({ title, hint, facts, foot }: { title?: string; hint?: string; facts: Fact[]; foot?: React.ReactNode }) {
  return (
    <div className="card">
      {title && <div className="text-lg font-bold">{title}</div>}
      {hint && <div className="text-base text-steel">{hint}</div>}
      <div className={`divide-y divide-line ${title || hint ? "mt-1" : ""}`}>
        {facts.map((f, i) => {
          const inner = (
            <>
              <div className="min-w-0 flex-1">
                <div className="font-bold leading-tight">{f.label}</div>
                {f.sub && <div className="text-sm text-steel">{f.sub}</div>}
              </div>
              <div className="shrink-0 num font-extrabold text-lg">{f.value}</div>
              {f.href && <Chev />}
            </>
          );
          const cls = "py-2.5 flex items-center gap-3";
          return f.href
            ? <Link key={i} href={f.href} className={cls}>{inner}</Link>
            : <div key={i} className={cls}>{inner}</div>;
        })}
      </div>
      {foot && <p className="text-sm text-steel pt-2">{foot}</p>}
    </div>
  );
}
