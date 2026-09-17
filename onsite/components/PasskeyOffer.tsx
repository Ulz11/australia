"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Check, ScanFace } from "lucide-react";
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { passkeyRegister, passkeyRegisterOptions } from "@/actions/passkeys";
import {
  PASSKEY_OFFER_COOKIE, canAddPasskey, ceremonyEnd, rememberHere, rememberNotNow, saidNotNowRecently, setUpHere, unlockWords,
} from "@/lib/passkeyClient";

type Stage = "ask" | "working" | "done" | "already";

/** Asked once: the cookie goes the moment the sheet decides not to show, or is closed. */
const clearOffer = () => { document.cookie = `${PASSKEY_OFFER_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`; };

/**
 * Once, right after a code sign-in (or onboarding): "Sign in with Face ID next time?" — Set it up / Not now.
 * Only when this phone can, it isn't already set up here, and nobody said "Not now" on this phone in the last 30 days.
 * Mounted by the boss and worker layouts when the offer cookie is there; it clears the cookie whatever it decides.
 */
export function PasskeyOffer({ origin, serverIds }: { origin: string; serverIds: string[] }) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("ask");
  const [msg, setMsg] = useState<{ text: string; warn: boolean } | null>(null);
  const [words, setWords] = useState<ReturnType<typeof unlockWords>>("Face ID or fingerprint");
  const options = useRef<PublicKeyCredentialCreationOptionsJSON | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // Decide once per mount. The cookie stays while the sheet is up: the registration action re-renders this screen,
  // and the layout only keeps this component mounted while the cookie is there.
  const decided = useRef(false);
  useEffect(() => {
    if (decided.current) return;
    decided.current = true;
    (async () => {
      let r = null;
      if (!saidNotNowRecently() && !setUpHere(serverIds) && (await canAddPasskey(origin)))
        r = await passkeyRegisterOptions().catch(() => null);        // fetched now so "Set it up" opens the prompt inside the tap
      if (!r?.ok) return clearOffer();
      options.current = r.options;
      setWords(unlockWords(navigator.userAgent));
      setOpen(true);
    })();
  }, [origin, serverIds]);

  useEffect(() => {
    const d = dialog.current;
    if (!d || !open) return;
    if (!d.open) d.showModal();
    return () => { if (d.open) d.close(); };
  }, [open]);

  const close = () => { clearOffer(); setOpen(false); };
  const notNow = () => { rememberNotNow(); close(); };

  const setUp = async () => {
    setMsg(null);
    setStage("working");
    try {
      let o = options.current;
      if (!o) {
        const r = await passkeyRegisterOptions();
        if (!r.ok) { setMsg({ text: r.error, warn: true }); setStage("ask"); return; }
        o = r.options;
      }
      const response = await startRegistration({ optionsJSON: o });
      const r = await passkeyRegister(response, { touch: navigator.maxTouchPoints > 1 });
      if (r.ok) { rememberHere(r.credentialId); setStage("done"); return; }
      setMsg({ text: r.error, warn: true });
    } catch (e) {
      const end = ceremonyEnd(e);
      if (end === "exists") { rememberHere(...serverIds); setStage("already"); return; }
      setMsg(end === "cancelled" || end === "aborted"
        ? { text: "That didn't finish. Try again, or tap Not now.", warn: false }
        : { text: "This phone couldn't turn it on. You can try again later from Me.", warn: true });
    }
    // A challenge is good for one try: get the next one ready for "Set it up" again.
    options.current = null;
    setStage("ask");
    const next = await passkeyRegisterOptions().catch(() => null);
    if (next?.ok) options.current = next.options;
  };

  if (!open) return null;
  const finished = stage === "done" || stage === "already";
  return (
    <dialog ref={dialog} className="sheet" aria-modal="true" aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); if (stage !== "working") (finished ? close : notNow)(); }}>
      <div className="sheet-panel w-full sm:max-w-md max-h-full overflow-y-auto bg-white rounded-t-3xl sm:rounded-3xl border-t-2 sm:border-2 border-line p-5 space-y-4"
        style={{ paddingBottom: "max(1.25rem, calc(1.25rem + env(safe-area-inset-bottom)))" }}>
        <div aria-hidden className="sm:hidden mx-auto -mt-2 mb-1 h-1.5 w-12 rounded-full bg-line" />
        {finished ? (
          <>
            <div className="flex items-start gap-3">
              <Check size={28} strokeWidth={2.5} aria-hidden className="shrink-0 mt-0.5 text-go" />
              <div className="min-w-0">
                <h2 id={titleId} className="text-2xl font-extrabold leading-tight">{stage === "done" ? "All set" : "This phone is already set up"}</h2>
                <p className="text-steel mt-1">Next time, tap <b className="text-ink">Sign in with Face ID or fingerprint</b>. No code to wait for.</p>
              </div>
            </div>
            <button type="button" className="btn-primary" onClick={close} autoFocus>Done</button>
          </>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <ScanFace size={28} strokeWidth={2.25} aria-hidden className="shrink-0 mt-0.5" />
              <div className="min-w-0">
                <h2 id={titleId} className="text-2xl font-extrabold leading-tight">Sign in with {words} next time?</h2>
                <p className="text-steel mt-1">No code to wait for. Your face and fingerprint stay on your phone — OnSite never sees them.</p>
              </div>
            </div>
            {msg && <p role="status" className={msg.warn ? "text-warn font-semibold" : "font-semibold"}>{msg.text}</p>}
            <div className="space-y-2">
              <button type="button" className="btn-primary" onClick={setUp} disabled={stage === "working"}>{stage === "working" ? "Setting up…" : "Set it up"}</button>
              <button type="button" className="btn-ghost" onClick={notNow} disabled={stage === "working"}>Not now</button>
            </div>
            <p className="text-sm text-steel">This saves a passkey for OnSite on this phone. You can remove it any time in Me.</p>
          </>
        )}
      </div>
    </dialog>
  );
}
