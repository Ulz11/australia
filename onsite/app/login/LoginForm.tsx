"use client";
import { useActionState, useState } from "react";
import { authAction, type AuthState } from "@/actions/auth";
import { useT } from "@/components/Lang";
import { PasskeySignIn } from "./PasskeySignIn";

/**
 * `demo`: codes show on screen instead of going by text (lib/flags.ts), so don't promise a text.
 * `passkeys`: Face ID / fingerprint sign-in is on for this site (lib/passkeys.ts); null keeps the page as it was.
 */
export function LoginForm({ invite, demo = false, passkeys = null }: { invite?: string; demo?: boolean; passkeys?: { origin: string; rpID: string } | null }) {
  const [s, act, pending] = useActionState(authAction, { step: "phone" } as AuthState);
  // `webauthn` joins `tel` only once this browser can offer passkeys in the box's suggestions (PasskeySignIn).
  const [autofill, setAutofill] = useState(false);
  const t = useT();
  if (s.step === "phone")
    return (
      <div className="space-y-4">
        <form action={act} className="space-y-3">
          <input type="hidden" name="step" value="phone" />
          <label className="text-lg font-bold block">{t("Your mobile number")}</label>
          <input name="phone" type="tel" inputMode="tel" autoComplete={autofill ? "tel webauthn" : "tel"} placeholder="0412 345 678" className="input text-2xl" required autoFocus />
          {s.error && <p className="text-warn font-semibold">{s.error}</p>}
          <button className="btn-primary text-xl" disabled={pending}>
            {pending ? (demo ? t("Getting your code…") : t("Sending…")) : demo ? t("Get my code") : t("Text me a code")}
          </button>
        </form>
        {passkeys && <PasskeySignIn origin={passkeys.origin} rpID={passkeys.rpID} invite={invite} autofill={autofill} onAutofill={setAutofill} />}
      </div>
    );
  return (
    <form action={act} className="space-y-3">
      <input type="hidden" name="step" value="code" /><input type="hidden" name="phone" value={s.phone} /><input type="hidden" name="invite" value={invite ?? ""} />
      <label className="text-lg font-bold block">
        {s.devCode ? t("Type the 6-digit code for {phone}", { phone: s.phone ?? "" }) : t("Type the 6-digit code we texted to {phone}", { phone: s.phone ?? "" })}
      </label>
      <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} placeholder="123456" className="input text-3xl tracking-[0.3em] font-mono text-center" required autoFocus />
      {s.devCode && <p className="text-steel">{t("Your code is")}<b className="font-mono text-ink text-xl">{s.devCode}</b></p>}
      {s.error && <p className="text-warn font-semibold">{s.error}</p>}
      <button className="btn-primary text-xl" disabled={pending}>{pending ? t("Checking…") : t("Sign in")}</button>
    </form>
  );
}
