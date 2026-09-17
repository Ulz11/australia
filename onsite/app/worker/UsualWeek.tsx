"use client";
import { useState, useTransition } from "react";
import { setUsualDays } from "@/actions/worker";
import { useT } from "@/components/Lang";

/** ISO weekdays, in the order a week is read. The label is a key: every language gets its own three letters. */
export const DAYS: [number, string][] = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"]];
/** What a first-time worker sees ticked before they have said anything. Nothing is saved until they tap Save. */
export const WEEKDAYS = [1, 2, 3, 4, 5];

/**
 * "Your usual week" — the card above the month. Most workers work the same days most weeks, and until now a
 * day nobody had tapped meant busy, so most of them were invisible to every boss most of the time.
 *
 * `first` is a worker who has neither a pattern nor a single day answered: Mon–Fri come pre-highlighted so the
 * usual answer is one tap away, but **nothing applies until they tap Save**. Nobody is made available silently.
 */
export function UsualWeek({ days, first }: { days: number[]; first: boolean }) {
  const [on, setOn] = useState<number[]>(() => (days.length === 0 && first ? WEEKDAYS : days));
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const t = useT();
  const dirty = on.join() !== days.join();

  const toggle = (d: number) => { setSaved(false); setOn((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort())); };

  return (
    <div className="card space-y-3">
      <div className="text-lg font-bold">{t("Your usual week")}</div>
      <p className="text-steel">{t("Days you're usually free. Bosses see you on these days without you tapping each one. Tap any day below to change just that day.")}</p>
      <div className="grid grid-cols-4 gap-2">
        {DAYS.map(([iso, label]) => (
          <button key={iso} type="button" aria-pressed={on.includes(iso)} onClick={() => toggle(iso)}
            className={`chip justify-center w-full ${on.includes(iso) ? "bg-ink text-white border-ink" : ""}`}>{t(label)}</button>
        ))}
      </div>
      <button className="btn-dark" disabled={pending || (!dirty && !first)}
        onClick={() => start(async () => { await setUsualDays(on); setSaved(true); })}>
        {pending ? t("Saving…") : saved && !dirty ? t("Saved") : t("Save")}
      </button>
      <p className="text-sm text-steel">{t("Stops after 14 days without opening the app, so nobody's shown someone who's moved on.")}</p>
    </div>
  );
}
