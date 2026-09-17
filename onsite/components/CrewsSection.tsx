"use client";
import { HardHat } from "lucide-react";
import { leaveCrew } from "@/actions/worker";
import { ConfirmButton } from "./ConfirmButton";
import { useT } from "./Lang";

export type CrewRow = { boss_id: string; company: string; boss_name: string | null };

/**
 * Me → Settings → "Crews you're in". A crew list only decides who can book this worker directly; leaving one
 * is their business and the boss is not told (actions/worker.ts leaveCrew).
 */
export function CrewsSection({ crews }: { crews: CrewRow[] }) {
  const t = useT();
  return (
    <div className="card space-y-3">
      <div className="text-lg font-bold flex items-center gap-2"><HardHat size={20} strokeWidth={2.25} aria-hidden className="shrink-0" />{t("Crews you're in")}</div>
      {crews.length === 0
        ? <p className="text-steel">{t("Nobody has you on their crew list yet. A boss you work for can add you, and then book you without going through matching.")}</p>
        : (
          <ul className="divide-y divide-line -my-1">
            {crews.map((c) => (
              <li key={c.boss_id} className="py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-bold truncate">{c.company}</div>
                  <div className="text-sm text-steel">{t("They can book you directly.")}</div>
                </div>
                <ConfirmButton action={leaveCrew.bind(null, c.boss_id)} className="btn-ghost btn-sm shrink-0"
                  title={t("Leave {company}'s crew?", { company: c.company })}
                  details={[t("They can't book you directly any more."), t("Their shifts still reach you through matching."), t("They aren't told.")]}
                  confirmLabel={t("Yes, leave")} cancelLabel={t("Stay")}>{t("Leave")}</ConfirmButton>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

/** The one-line version for a worker's first days: "You're on Dave's Concreting's crew list." */
export function NewCrewCard({ crew }: { crew: CrewRow }) {
  const t = useT();
  return (
    <div className="say-dark">
      <div className="flex items-start gap-3">
        <HardHat size={24} strokeWidth={2.25} aria-hidden className="shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="say-title">{t("You're on {company}'s crew list.", { company: crew.company })}</div>
          <div className="say-sub">{t("They can book you directly.")}</div>
        </div>
      </div>
      <div className="mt-3">
        <ConfirmButton action={leaveCrew.bind(null, crew.boss_id)} className="btn bg-white text-ink w-full"
          title={t("Leave {company}'s crew?", { company: crew.company })}
          details={[t("They can't book you directly any more."), t("Their shifts still reach you through matching."), t("They aren't told.")]}
          confirmLabel={t("Yes, leave")} cancelLabel={t("Stay")}>{t("Leave")}</ConfirmButton>
      </div>
    </div>
  );
}
