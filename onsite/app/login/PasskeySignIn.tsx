"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanFace } from "lucide-react";
import { WebAuthnAbortService, sendSignal, startAuthentication, type AuthenticationResponseJSON, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { passkeyLoginOptions, passkeySignIn } from "@/actions/passkeys";
import { useT } from "@/components/Lang";
import { OPTIONS_FRESH_MS, PASSKEY_WORDS, canAutofillPasskey, canSignInWithPasskey, ceremonyEnd, forgetHere, rememberHere } from "@/lib/passkeyClient";

type Msg = { text: string; warn: boolean } | null;

/**
 * "Sign in with Face ID or fingerprint" under the phone form, and the same passkeys offered in the keyboard's
 * suggestions when the phone box is focused (conditional mediation), where the browser can.
 *
 * Sign-in options are fetched before anyone taps, so the tap opens the Face ID prompt with nothing in between —
 * iPhones before iOS 17.4 only allow that prompt inside the tap itself. The button and the autofill share one
 * challenge; a challenge lives 5 minutes, so a page left open is re-armed with a fresh one.
 *
 * `onAutofill(true)` asks the form to put `webauthn` on the phone box. Autofill starts only once it is there and
 * only in browsers that support it; anywhere else the box keeps its plain `tel`.
 */
export function PasskeySignIn({ origin, rpID, invite, autofill, onAutofill }: {
  origin: string; rpID: string; invite?: string; autofill: boolean; onAutofill: (on: boolean) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [prompting, setPrompting] = useState(false);
  /** Signed in and on our way out. Latched, so the button doesn't flick back while the next screen loads. */
  const [leaving, setLeaving] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  // The words for every way this can end live in lib/passkeyClient; the reason picks one and t() says it in
  // whatever language the login screen is in.
  const t = useT();
  /** Only touched from effects and taps. `modal`: the button's prompt is up, so autofill must not cancel it. */
  const s = useRef({ options: null as PublicKeyCredentialRequestOptionsJSON | null, at: 0, alive: false, modal: false, autofill: false });

  const fresh = () => (s.current.options && Date.now() - s.current.at < OPTIONS_FRESH_MS ? s.current.options : null);

  /** `loud`: someone tapped, so a refusal gets a sentence. Fetches in the background fail quietly — the code is right there. */
  async function fetchOptions(loud = false) {
    s.current.options = null;
    const r = await passkeyLoginOptions().catch(() => null);
    if (!s.current.alive) return null;
    if (!r?.ok) { if (loud) setMsg({ text: t(PASSKEY_WORDS[r?.reason ?? "failed"]), warn: true }); return null; }
    Object.assign(s.current, { options: r.options, at: Date.now() });
    return r.options;
  }

  /** Listen in the phone box. Anything that ends it without a choice — us cancelling it, mostly — is silent. */
  async function arm() {
    if (!s.current.alive || !s.current.autofill || s.current.modal) return;
    const o = fresh() ?? (await fetchOptions());
    if (!o || !s.current.alive || s.current.modal) return;
    let response: AuthenticationResponseJSON;
    try { response = await startAuthentication({ optionsJSON: o, useBrowserAutofill: true }); } catch { return; }
    submit(response);
  }

  /**
   * Send what the phone signed. On success the action hands back where to go and we go there, saying nothing:
   * the button stays on "Signing you in…" until the next screen lands, so there is never a message between the
   * two. Anything else is a real failure — say why and start listening again.
   */
  function submit(response: AuthenticationResponseJSON) {
    s.current.options = null;                                         // that challenge is spent either way
    rememberHere(response.id);
    setMsg(null);
    start(async () => {
      const r = await passkeySignIn(response, invite).catch(() => ({ ok: false as const, reason: "failed" as const, error: PASSKEY_WORDS.failed }));
      if (!r || !s.current.alive) return;
      if (r.ok) { setLeaving(true); router.push(r.to); return; }
      if (r.reason === "unknown") {
        forgetHere(response.id);
        // Ask the phone to stop offering a passkey we no longer accept. Best effort: a browser that can't, ignores it.
        sendSignal({ signalName: "unknownCredential", rpID, credentialID: response.id }).catch(() => {});
      }
      setMsg({ text: t(PASSKEY_WORDS[r.reason]), warn: true });
      arm();
    });
  }

  async function prompt(o: PublicKeyCredentialRequestOptionsJSON) {
    s.current.modal = true;
    setPrompting(true);
    let response: AuthenticationResponseJSON | null = null;
    try {
      response = await startAuthentication({ optionsJSON: o });       // takes over from the autofill request, same challenge
    } catch (e) {
      const end = ceremonyEnd(e);
      if (end === "cancelled") setMsg({ text: t(PASSKEY_WORDS.cancelled), warn: false });
      else if (end !== "aborted") setMsg({ text: t(PASSKEY_WORDS.failed), warn: true });
    }
    s.current.modal = false;
    setPrompting(false);
    if (response) submit(response);
    else arm();
  }

  function tap() {
    setMsg(null);
    const o = fresh();
    if (o) prompt(o);                                                 // nothing awaited between the tap and the prompt
    else fetchOptions(true).then((later) => { if (later) prompt(later); });
  }

  useEffect(() => {
    s.current.alive = true;
    const me = s.current;
    (async () => {
      if (!(await canSignInWithPasskey(origin)) || !me.alive) return;
      setSupported(true);
      if (await canAutofillPasskey(origin)) onAutofill(true);
      else fetchOptions();                                            // no autofill: still have the button's challenge ready
    })();
    return () => {
      me.alive = false;
      WebAuthnAbortService.cancelCeremony();                          // off the phone step: stop listening
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin]);

  useEffect(() => {
    s.current.autofill = autofill;
    if (!autofill) return;
    const first = setTimeout(arm, 0);                                 // once the box carries `webauthn` in the DOM
    const again = setInterval(() => { if (!s.current.modal) { s.current.options = null; arm(); } }, OPTIONS_FRESH_MS);
    return () => { clearTimeout(first); clearInterval(again); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autofill]);

  if (!supported) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-steel" aria-hidden><span className="h-px flex-1 bg-line" />{t("or")}<span className="h-px flex-1 bg-line" /></div>
      <button type="button" onClick={tap} disabled={prompting || pending || leaving} className="btn-ghost px-4">
        <ScanFace size={26} strokeWidth={2.25} aria-hidden className="shrink-0" />
        {/* Two even lines on a narrow phone rather than one word hanging on its own. */}
        <span className="text-balance">{pending || leaving ? t("Signing you in…") : t("Sign in with Face\u00a0ID or fingerprint")}</span>
      </button>
      {msg && <p role="status" className={msg.warn ? "text-warn font-semibold" : "font-semibold"}>{msg.text}</p>}
    </div>
  );
}
