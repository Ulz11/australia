import { Smartphone } from "lucide-react";
import { signOutSession, signOutOtherSessions } from "@/actions/auth";
import type { SessionRow } from "@/lib/session";
import { agoParts } from "@/lib/util";
import { getT } from "@/lib/i18n/server";
import { plural } from "@/lib/i18n";
import { Flag } from "./ui";
import { ConfirmButton } from "./ConfirmButton";

/**
 * Me → "Where you're signed in", for bosses and workers alike. A sign-in is a row now (migration 015), so this
 * is the real list: every phone that can open this account, and a way to end any of them from here.
 */
export async function SessionsSection({ sessions, currentSid }: { sessions: SessionRow[]; currentSid: string }) {
  const t = await getT();                                 // English on a boss screen, the worker's language on theirs
  const others = sessions.filter((s) => s.id !== currentSid).length;
  const when = (d: Date) => { const p = agoParts(d); return t(p.key, { n: p.n }); };
  return (
    <div className="card space-y-3">
      <div className="text-lg font-bold flex items-center gap-2"><Smartphone size={20} strokeWidth={2.25} aria-hidden className="shrink-0" />{t("Where you're signed in")}</div>
      <ul className="divide-y divide-line -my-1">
        {sessions.map((s) => {
          const here = s.id === currentSid;
          return (
            <li key={s.id} className="py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-bold flex items-center gap-2 flex-wrap">
                  {s.label}
                  {here && <Flag tone="dark" icon={null}>{t("This phone")}</Flag>}
                </div>
                <div className="text-sm text-steel">{t("Last used {when}", { when: when(s.last_seen_at) })}</div>
              </div>
              <ConfirmButton action={signOutSession.bind(null, s.id)} className="btn-ghost btn-sm shrink-0"
                title={here ? t("Sign out this phone?") : t("Sign out that {device}?", { device: s.label })}
                details={here
                  ? [t("You'll need a text code, or Face ID, to get back in.")]
                  : [t("That {device} will need a text code, or Face ID, to sign in again.", { device: s.label }), t("Nothing else about your account changes.")]}
                confirmLabel={t("Yes, sign it out")} cancelLabel={t("Leave it")}>{t("Sign out")}</ConfirmButton>
            </li>
          );
        })}
      </ul>
      {others > 0 && (
        <ConfirmButton action={signOutOtherSessions} className="btn-ghost btn-sm"
          title={t("Sign out everywhere else?")}
          details={[plural(t, others, "{n} other sign-in ends.", "{n} other sign-ins end."), t("This phone stays signed in.")]}
          confirmLabel={t("Yes, sign them out")} cancelLabel={t("Leave them")}>{t("Sign out everywhere else")}</ConfirmButton>
      )}
      <p className="text-sm text-steel">{t("Signing out a phone stops it opening OnSite straight away.")}</p>
    </div>
  );
}
