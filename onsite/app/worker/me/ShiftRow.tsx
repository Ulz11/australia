import { Check, CircleAlert } from "lucide-react";
import { StatusPill } from "@/components/StatusPill";
import { ConfirmButton } from "@/components/ConfirmButton";
import { CallLink } from "@/components/CallLink";
import { disagree, workerLogCall } from "@/actions/worker";
import { fmtDay } from "@/lib/util";
import { money } from "@/lib/award";
import type { HistoryRow } from "@/lib/profileStats";
import type { T } from "@/lib/i18n";

/**
 * One shift on the worker's record: day, site, boss, what it paid. Shared by the ten most recent on
 * /worker/me and the full list on /worker/me/shifts, so a change to the row happens once.
 *
 * `loud` is the orange law reaching a list: orange means "this needs you, now" and a screen gets one. A row
 * cannot know how many of its neighbours are also shouting, or what the bento above it already spent the
 * colour on, so the screen picks the one row that gets it and every other mismatch draws `say-soft` — same
 * words, same icon, same two buttons, one step quieter.
 *
 * `t` arrives as a prop rather than from `await getT()` here, because this row is drawn inside a `.map()`
 * on two different screens and both of them already hold the one cached dictionary for the request.
 */
export function ShiftRow({ h, t, gross, loud = true }: { h: HistoryRow; t: T; gross: (h: HistoryRow) => number; loud?: boolean }) {
  const first = h.boss_name.split(" ")[0];
  return (
    <div className="py-3">
      <div className="flex justify-between items-center gap-2">
        <div><div className="font-bold">{fmtDay(h.day)} · {h.site}</div><div className="text-sm text-steel">{h.boss_name}{h.company ? ` · ${h.company}` : ""}</div></div>
        <div className="text-right num"><div className="font-extrabold text-lg">{h.hours_approved != null ? money(gross(h)) : "—"}</div><StatusPill s={h.status} view="worker" /></div>
      </div>
      {/* Hours that don't match are waiting on this worker to say something — orange until they do. */}
      {h.hours_approved != null && Number(h.hours_approved) !== Number(h.hours_worked) && (
        <div className={`mt-2 ${h.disputed_at ? "say-grey" : loud ? "say-orange" : "say-soft"}`}>
          <div className="flex items-start gap-3">
            {h.disputed_at
              ? <Check size={22} strokeWidth={2.25} aria-hidden className="shrink-0 mt-0.5 text-go" />
              : <CircleAlert size={22} strokeWidth={2.25} aria-hidden className="shrink-0 mt-0.5" />}
            <div className="min-w-0 flex-1">
              <div className="font-bold">{t("Boss approved {n}h. You recorded {worked}h.", { n: Number(h.hours_approved), worked: Number(h.hours_worked) })}</div>
              <div className="say-sub">{h.disputed_at ? t("You've told them you disagree. Both numbers stay on record.") : t("Both numbers stay on record. Best fix: ring them.")}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <CallLink phone={h.boss_phone} name={h.boss_name} onCall={workerLogCall.bind(null, h.boss_id, h.id)} className="btn bg-white text-ink btn-sm w-full" />
            {!h.disputed_at && (
              <ConfirmButton action={disagree.bind(null, h.id)} className="btn bg-white text-ink btn-sm w-full" danger={false}
                title={t("Tell {name} you disagree?", { name: first })}
                details={[
                  t("{name} gets a message that you disagree with the {n}h approved for {day}.",
                    { name: first, n: Number(h.hours_approved), day: fmtDay(h.day) }),
                  t("Both numbers stay on record: you recorded {n}h.", { n: Number(h.hours_worked) }),
                  t("Nothing is changed by itself — the two of you sort out the number."),
                ]}
                confirmLabel={t("Yes, tell them")} cancelLabel={t("Not now")}>{t("I disagree")}</ConfirmButton>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The rows that would take the screen's one orange: hours that don't match and nothing said about it yet.
 * A row the worker has already disputed is grey whatever the screen decides, so it never asks for the colour.
 * Both screens pass the newest of these to `loud`.
 */
export const wantsAnAnswer = (h: HistoryRow) =>
  h.hours_approved != null && Number(h.hours_approved) !== Number(h.hours_worked) && !h.disputed_at;
