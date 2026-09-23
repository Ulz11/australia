import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { getT } from "@/lib/i18n/server";

/**
 * The bar at the top, in the two shapes an app has.
 *
 * A ROOT screen — Jobs, Money, Workers, Me — has nowhere to go back to, so it spends that room on a large
 * title: 32/700 at -0.02em, which is where this screen's hierarchy starts. A PUSHED screen has Back to
 * carry, so it gets the compact 19/700 centre title instead and is 16px *shorter* than the old 64px bar.
 * The large title on the four root screens is therefore paid for out of the drill-downs and not out of
 * the content budget.
 *
 * The bar itself is a material, not a colour: 72% canvas under a 20px blur, with a hairline separator and
 * a solid fallback for browsers with no backdrop-filter (globals.css `.mat`). Ink on the worst substrate
 * it can sit over — a full-width `.cell-ink` scrolling under it — still measures 8.70:1.
 *
 * Async only for the one word in it: "Back" reads in the worker's language, and English on a boss screen.
 */
export async function Header({ title, back, right }: { title: string; back?: string; right?: React.ReactNode }) {
  const t = await getT();
  return (
    <header className={`hdr mat ${back ? "hdr-sub" : "hdr-root"}`}>
      <div className="hdr-row">
        {back && (
          <Link href={back} className="hdr-back" aria-label={t("Back")}>
            <ChevronLeft size={24} strokeWidth={2.5} aria-hidden />
            <span className="truncate">{t("Back")}</span>
          </Link>
        )}
        <h1 className="hdr-title">{title}</h1>
        {right && <div className="shrink-0 flex items-center gap-2">{right}</div>}
      </div>
    </header>
  );
}

/**
 * The scroll body under the bar. pb-32 clears the fixed TabBar (64px) plus its safe-area inset plus the
 * air a last card needs so its shadow is not cut off by the bar's blur.
 */
export function Page({ children }: { children: React.ReactNode }) {
  return <main className="max-w-md mx-auto px-4 py-4 pb-32 space-y-4">{children}</main>;
}

/** Nothing here yet. A card, so an empty list still has the shape of the list it will become. */
export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="card text-center text-steel text-lg py-8 px-6 leading-snug">{children}</div>;
}
