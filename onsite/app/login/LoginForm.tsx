"use client";
import { useActionState } from "react";
import { authAction, type AuthState } from "@/actions/auth";

/** `demo`: codes show on screen instead of going by text (lib/flags.ts), so don't promise a text. */
export function LoginForm({ invite, demo = false }: { invite?: string; demo?: boolean }) {
  const [s, act, pending] = useActionState(authAction, { step: "phone" } as AuthState);
  if (s.step === "phone")
    return (
      <form action={act} className="space-y-3">
        <input type="hidden" name="step" value="phone" />
        <label className="text-lg font-bold block">Your mobile number</label>
        <input name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="0412 345 678" className="input text-2xl" required autoFocus />
        {s.error && <p className="text-warn font-semibold">{s.error}</p>}
        <button className="btn-primary text-xl" disabled={pending}>{pending ? (demo ? "Getting your code…" : "Sending…") : demo ? "Get my code" : "Text me a code"}</button>
      </form>
    );
  return (
    <form action={act} className="space-y-3">
      <input type="hidden" name="step" value="code" /><input type="hidden" name="phone" value={s.phone} /><input type="hidden" name="invite" value={invite ?? ""} />
      <label className="text-lg font-bold block">{s.devCode ? `Type the 6-digit code for ${s.phone}` : `Type the 6-digit code we texted to ${s.phone}`}</label>
      <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} placeholder="123456" className="input text-3xl tracking-[0.3em] font-mono text-center" required autoFocus />
      {s.devCode && <p className="text-steel">Your code is<b className="font-mono text-ink text-xl">{s.devCode}</b></p>}
      {s.error && <p className="text-warn font-semibold">{s.error}</p>}
      <button className="btn-primary text-xl" disabled={pending}>{pending ? "Checking…" : "Sign in"}</button>
    </form>
  );
}
