import { ScanFace } from "lucide-react";
import { removePasskey } from "@/actions/passkeys";
import { relyingParty, userHandleB64, type PasskeyRow } from "@/lib/passkeys";
import { TZ } from "@/lib/util";
import { ConfirmButton } from "./ConfirmButton";
import { AddPasskey } from "./AddPasskey";

const day = (d: Date) => d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: TZ });

/**
 * Me → "Face ID and fingerprint sign-in", for bosses and workers alike. The page loads the rows with its other
 * queries (lib/passkeys.ts listPasskeys), so this adds no round trip. Nothing shows when passkeys are off.
 */
export function PasskeysSection({ userId, passkeys }: { userId: string; passkeys: PasskeyRow[] }) {
  const rp = relyingParty();
  if (!rp) return null;
  return (
    <div className="card space-y-3">
      <div className="text-lg font-bold flex items-center gap-2"><ScanFace size={20} strokeWidth={2.25} aria-hidden className="shrink-0" />Face ID and fingerprint sign-in</div>
      {passkeys.length === 0
        ? <p>Sign in with Face ID or your fingerprint instead of waiting for a text code. Turn it on for each phone you use.</p>
        : (
          <ul className="divide-y divide-line -my-1">
            {passkeys.map((p) => (
              <li key={p.id} className="py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-bold">{p.label}</div>
                  <div className="text-sm text-steel">Added {day(p.created_at)} · {p.last_used_at ? `Last used ${day(p.last_used_at)}` : "Not used yet"}</div>
                </div>
                <ConfirmButton action={removePasskey.bind(null, p.id)} className="btn-ghost btn-sm shrink-0"
                  title={`Remove Face ID sign-in for this ${p.label}?`}
                  details={[
                    `That ${p.label} will need a text code to sign in to OnSite.`,
                    "Signs out anywhere that used this Face ID to sign in.",
                    "You can turn it on again from Me on that phone.",
                  ]}
                  confirmLabel="Yes, remove" cancelLabel="Keep it">Remove</ConfirmButton>
              </li>
            ))}
          </ul>
        )}
      <AddPasskey origin={rp.origin} rpID={rp.rpID} userID={userHandleB64(userId)} serverIds={passkeys.map((p) => p.credential_id)} first={passkeys.length === 0} />
      <p className="text-sm text-steel">This keeps a passkey for OnSite on your phone. Your face and fingerprint never leave the phone.</p>
    </div>
  );
}
