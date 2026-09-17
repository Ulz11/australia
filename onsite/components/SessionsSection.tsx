import { Smartphone } from "lucide-react";
import { signOutSession, signOutOtherSessions } from "@/actions/auth";
import type { SessionRow } from "@/lib/session";
import { ago } from "@/lib/util";
import { Flag } from "./ui";
import { ConfirmButton } from "./ConfirmButton";

/**
 * Me → "Where you're signed in", for bosses and workers alike. A sign-in is a row now (migration 015), so this
 * is the real list: every phone that can open this account, and a way to end any of them from here.
 */
export function SessionsSection({ sessions, currentSid }: { sessions: SessionRow[]; currentSid: string }) {
  const others = sessions.filter((s) => s.id !== currentSid).length;
  return (
    <div className="card space-y-3">
      <div className="text-lg font-bold flex items-center gap-2"><Smartphone size={20} strokeWidth={2.25} aria-hidden className="shrink-0" />Where you&apos;re signed in</div>
      <ul className="divide-y divide-line -my-1">
        {sessions.map((s) => {
          const here = s.id === currentSid;
          return (
            <li key={s.id} className="py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-bold flex items-center gap-2 flex-wrap">
                  {s.label}
                  {here && <Flag tone="dark" icon={null}>This phone</Flag>}
                </div>
                <div className="text-sm text-steel">Last used {ago(s.last_seen_at)}</div>
              </div>
              <ConfirmButton action={signOutSession.bind(null, s.id)} className="btn-ghost btn-sm shrink-0"
                title={here ? "Sign out this phone?" : `Sign out that ${s.label}?`}
                details={here
                  ? ["You'll need a text code, or Face ID, to get back in."]
                  : [`That ${s.label} will need a text code, or Face ID, to sign in again.`, "Nothing else about your account changes."]}
                confirmLabel="Yes, sign it out" cancelLabel="Leave it">Sign out</ConfirmButton>
            </li>
          );
        })}
      </ul>
      {others > 0 && (
        <ConfirmButton action={signOutOtherSessions} className="btn-ghost btn-sm"
          title="Sign out everywhere else?"
          details={[`${others} other sign-in${others === 1 ? "" : "s"} end.`, "This phone stays signed in."]}
          confirmLabel="Yes, sign them out" cancelLabel="Leave them">Sign out everywhere else</ConfirmButton>
      )}
      <p className="text-sm text-steel">Signing out a phone stops it opening OnSite straight away.</p>
    </div>
  );
}
