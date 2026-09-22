import Link from "next/link";
import { Check, CircleAlert } from "lucide-react";
import { Cell } from "./ui";
import type { TodayItem } from "@/lib/bossToday";

/**
 * THE ONE THING. The 2x2 at the top of /boss, and the whole reason lib/rank.ts exists.
 *
 * The screen it replaces painted every waiting thing the same orange — "3 to approve", "a worker
 * disagrees" and "Needs 2 more" all came back tone "orange" from one `state()` and `Row` drew them
 * identically — so the hole at 6:30 tomorrow read exactly like a licence renewal and got scrolled past.
 * This cell is the one orange thing on the screen. Everything else that is live drops a volume step
 * (cell 2, `.cell-soft`) or becomes a plain white row under "Also waiting".
 *
 * FAIL WHITE, NEVER FAIL GREEN. The green "No." is an assertion of absence built from six queries at
 * once. A green cell that is really a query which timed out is the worst thing this screen can do: the
 * boss puts the phone down and the hole is still there at 6am. So `failed` — lib/rank.ts's
 * `state === "unknown"` — renders white and says we could not check. It never degrades to green, and
 * there is no third path where it might.
 *
 * It is not a link. A 2x2 with two buttons in its foot is two targets and a body; making the body a link
 * as well would nest one target inside another, and the thumb that misses the ink button would quietly do
 * the other thing instead. The ink button is the action; the ghost button is the way in to the detail.
 */
export function HeroCell({ item, failed, action, ghost }: {
  item: TodayItem | null;
  /** lib/rank.ts could not read one of its six inputs. White, and says so. */
  failed?: boolean;
  /**
   * The ink control, when pressing it does something here rather than going somewhere — the hole tenant
   * hands in a form firing `widenSearch`. Left out, the item's own words become a link to its target.
   */
  action?: React.ReactNode;
  ghost?: { label: string; href: string } | null;
}) {
  if (failed || !item) {
    return (
      <Cell span={2} rows={2}>
        <div className="min-w-0">
          <div className="c-label">We couldn&apos;t check just now</div>
          {/* c-prose: this is a sentence, not a figure or a date, so it takes the quiet label colour —
              the same rule /boss/money's failed hero follows, so the two read as one app. */}
          <div className="c-sub c-prose">Pull to refresh. Nothing here is a statement about your jobs — we just
            couldn&apos;t reach the numbers.</div>
        </div>
        {/* A plain anchor, not a Link: this has to ask the server again, and the client router would be
            within its rights to hand back the very page that failed. */}
        <div className="cell-bar"><a href="/boss" className="cell-act">Retry</a></div>
      </Cell>
    );
  }

  // The green one. No bar and no link: there is nothing to press, and a button here would invent a job.
  if (item.key === "clear") {
    return (
      <Cell span={2} rows={2} tone="go">
        <div className="min-w-0">
          <div className="c-label flex items-start gap-2">
            <Check size={24} strokeWidth={2.5} aria-hidden className="shrink-0" />
            <span className="min-w-0">{item.label}</span>
          </div>
          <div className="c-hero mt-1">{item.figure}</div>
          <div className="c-sub">{item.sub}</div>
        </div>
      </Cell>
    );
  }

  // 34px, not the 48px the green cell gets: this one carries a 64px action bar under it, and a figure
  // that pushes the buttons off the bottom of the cell is a figure nobody can act on.
  return (
    <Cell span={2} rows={2} tone="needs">
      <div className="min-w-0">
        <div className="c-label flex items-start gap-2">
          <CircleAlert size={24} strokeWidth={2.5} aria-hidden className="shrink-0" />
          <span className="min-w-0">{item.label}</span>
        </div>
        <div className="c-fig-2 mt-1 truncate">{item.figure}</div>
        {/* Two lines, so a long site name can never push the action bar out of the cell. */}
        <div className="c-sub line-clamp-2">{item.sub}</div>
      </div>
      {(action || item.action || ghost) && (
        <div className="cell-bar">
          {action ?? (item.action && item.href ? <Link href={item.href} className="cell-act">{item.action}</Link> : null)}
          {ghost && <Link href={ghost.href} className="cell-act-ghost">{ghost.label}</Link>}
        </div>
      )}
    </Cell>
  );
}
