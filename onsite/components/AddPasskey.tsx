"use client";
import { useEffect, useRef, useState } from "react";
import { ScanFace } from "lucide-react";
import { sendSignal, startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { passkeyRegister, passkeyRegisterOptions } from "@/actions/passkeys";
import { OPTIONS_FRESH_MS, canAddPasskey, ceremonyEnd, rememberHere } from "@/lib/passkeyClient";

/**
 * Me → "Add this phone". Shown only where this phone can make a passkey; the list above it (server-rendered) is
 * there either way, so a phone that can't still lets someone remove the ones they have.
 *
 * On every visit it also tells the phone which of this person's passkeys OnSite still accepts, so one removed
 * here (or on another phone) stops being offered. Browsers that can't take that hint ignore it.
 */
export function AddPasskey({ origin, rpID, userID, serverIds, first }: {
  origin: string; rpID: string; userID: string; serverIds: string[]; first: boolean;
}) {
  const [can, setCan] = useState<boolean | null>(null);
  const [working, setWorking] = useState(false);
  const [msg, setMsg] = useState<{ text: string; warn: boolean } | null>(null);
  const ready = useRef<{ options: PublicKeyCredentialCreationOptionsJSON; at: number } | null>(null);
  const accepted = serverIds.join(" ");

  useEffect(() => {
    let live = true;
    (async () => {
      const ok = await canAddPasskey(origin);
      if (!live) return;
      setCan(ok);
      if (!ok) return;
      // Fetched now so the tap opens the prompt straight away (older iPhones insist on that).
      const r = await passkeyRegisterOptions().catch(() => null);
      if (live && r?.ok) ready.current = { options: r.options, at: Date.now() };
    })();
    return () => { live = false; };
  }, [origin]);

  useEffect(() => {
    if (!window.PublicKeyCredential) return;
    sendSignal({ signalName: "allAcceptedCredentials", rpID, userID, allAcceptedCredentialIDs: accepted ? accepted.split(" ") : [] }).catch(() => {});
  }, [rpID, userID, accepted]);

  const add = async () => {
    setMsg(null);
    setWorking(true);
    const cached = ready.current && Date.now() - ready.current.at < OPTIONS_FRESH_MS ? ready.current.options : null;
    ready.current = null;                                              // one challenge, one try
    try {
      let o = cached;
      if (!o) {
        const r = await passkeyRegisterOptions();
        if (!r.ok) return setMsg({ text: r.error, warn: true });
        o = r.options;
      }
      const response = await startRegistration({ optionsJSON: o });
      const r = await passkeyRegister(response, { touch: navigator.maxTouchPoints > 1 });
      if (!r.ok) return setMsg({ text: r.error, warn: true });
      rememberHere(r.credentialId);
      setMsg({ text: "Done. Next time, sign in with Face ID or your fingerprint — no code to wait for.", warn: false });
    } catch (e) {
      const end = ceremonyEnd(e);
      if (end === "exists") { rememberHere(...serverIds); setMsg({ text: "This phone is already set up.", warn: false }); }
      else if (end === "cancelled" || end === "aborted") setMsg({ text: "That didn't finish. Tap Add this phone to try again.", warn: false });
      else setMsg({ text: "This phone couldn't turn it on. Try again later, or keep using a text code.", warn: true });
    } finally {
      setWorking(false);
    }
  };

  if (can === null) return null;
  if (!can) return <p className="text-steel">This browser can&apos;t use Face ID or fingerprint sign-in.</p>;
  return (
    <div className="space-y-2">
      <button type="button" onClick={add} disabled={working} className={first ? "btn-primary" : "btn-ghost"}>
        <ScanFace size={24} strokeWidth={2.25} aria-hidden className="shrink-0" />
        {working ? "Setting up…" : "Add this phone"}
      </button>
      {msg && <p role="status" className={msg.warn ? "text-warn font-semibold" : "font-semibold"}>{msg.text}</p>}
    </div>
  );
}
