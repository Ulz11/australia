import { ScanFace } from "lucide-react";
import { removePasskey } from "@/actions/passkeys";
import { relyingParty, userHandleB64, type PasskeyRow } from "@/lib/passkeys";
import { TZ } from "@/lib/util";
import { LOCALES } from "@/lib/i18n";
import { getLang, getT } from "@/lib/i18n/server";
import { ConfirmButton } from "./ConfirmButton";
import { AddPasskey } from "./AddPasskey";

const day = (d: Date, locale: string) => d.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", timeZone: TZ });

/**
 * Me → "Face ID and fingerprint sign-in", for bosses and workers alike. The page loads the rows with its other
 * queries (lib/passkeys.ts listPasskeys), so this adds no round trip. Nothing shows when passkeys are off.
 */
export async function PasskeysSection({ userId, passkeys }: { userId: string; passkeys: PasskeyRow[] }) {
  const rp = relyingParty();
  if (!rp) return null;
  const [lang, t] = await Promise.all([getLang(), getT()]);   // English on a boss screen, the worker's language on theirs
  const locale = LOCALES[lang];
  return (
    <div className="card space-y-3">
      <div className="text-lg font-bold flex items-center gap-2"><ScanFace size={20} strokeWidth={2.25} aria-hidden className="shrink-0" />{t("Face ID and fingerprint sign-in")}</div>
      {passkeys.length === 0
        ? <p>{t("Sign in with Face ID or your fingerprint instead of waiting for a text code. Turn it on for each phone you use.")}</p>
        : (
          <ul className="divide-y divide-line -my-1">
            {passkeys.map((p) => (
              <li key={p.id} className="py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-bold">{p.label}</div>
                  <div className="text-sm text-steel">{t("Added {when}", { when: day(p.created_at, locale) })} · {p.last_used_at ? t("Last used {when}", { when: day(p.last_used_at, locale) }) : t("Not used yet")}</div>
                </div>
                <ConfirmButton action={removePasskey.bind(null, p.id)} className="btn-ghost btn-sm shrink-0"
                  title={t("Remove Face ID sign-in for this {device}?", { device: p.label })}
                  details={[
                    t("That {device} will need a text code to sign in to OnSite.", { device: p.label }),
                    t("Signs out anywhere that used this Face ID to sign in."),
                    t("You can turn it on again from Me on that phone."),
                  ]}
                  confirmLabel={t("Yes, remove")} cancelLabel={t("Keep it")}>{t("Remove")}</ConfirmButton>
              </li>
            ))}
          </ul>
        )}
      <AddPasskey origin={rp.origin} rpID={rp.rpID} userID={userHandleB64(userId)} serverIds={passkeys.map((p) => p.credential_id)} first={passkeys.length === 0} />
      <p className="text-sm text-steel">{t("This keeps a passkey for OnSite on your phone. Your face and fingerprint never leave the phone.")}</p>
    </div>
  );
}
