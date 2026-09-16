"use client";
import { useEffect, useState, useTransition } from "react";
import { BellRing } from "lucide-react";
import { removePushSubscription, savePushSubscription, sendTestAlert } from "@/actions/alerts";

type State = "checking" | "unsupported" | "ios-install" | "blocked" | "off" | "on";

const keyBytes = (b64url: string) => {
  const s = (b64url + "=".repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const plain = (sub: PushSubscription) => JSON.parse(JSON.stringify(sub));
/** Same fingerprint the server sends, computed here — the endpoint itself never needs to leave the browser. */
const fingerprint = async (endpoint: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint))))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Turn phone alerts on or off. `compact` is the one-line nudge for the home screen: it only shows
 * when alerts are off and could be turned on, and disappears once they are.
 */
export function AlertsToggle({ publicKey, role, compact, savedPush }: { publicKey: string; role: "boss" | "worker"; compact?: boolean; savedPush?: string }) {
  const [state, setState] = useState<State>("checking");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    (async () => {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      const installed = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
        return setState(ios && !installed ? "ios-install" : "unsupported");
      const reg = await navigator.serviceWorker.register("/sw.js");
      if (Notification.permission === "denied") return setState("blocked");
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return setState("off");
      // Re-point the phone at whoever is signed in. savedPush fingerprints what the server already holds for
      // THIS person, so a second account on the same phone is registered instead of quietly inheriting alerts.
      if (savedPush !== (await fingerprint(sub.endpoint))) await savePushSubscription(plain(sub), navigator.userAgent);
      setState("on");
    })().catch(() => setState("unsupported"));
  }, [savedPush]);

  const turnOn = () => start(async () => {
    setMsg(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return setState(perm === "denied" ? "blocked" : "off");
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
      const r = await savePushSubscription(plain(sub), navigator.userAgent);
      if (!r.ok) { await sub.unsubscribe(); return setMsg(r.error ?? "Couldn't turn alerts on. Try again."); }
      setState("on");
    } catch {
      setMsg("This phone wouldn't turn alerts on. Check its notification settings and try again.");
    }
  });

  const turnOff = () => start(async () => {
    setMsg(null);
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) { await removePushSubscription(sub.endpoint); await sub.unsubscribe(); }
    setState("off");
  });

  const test = () => start(async () => {
    const r = await sendTestAlert();
    setMsg(r.ok ? "Sent — it should buzz in a few seconds." : r.error ?? "Couldn't send a test.");
  });

  const what = role === "worker" ? "when a shift near you comes up" : "when workers take, finish or ask about a shift";

  if (compact) {
    if (state !== "off" && state !== "ios-install") return null;
    // A nudge, not an alarm: alerts are worth turning on, but nothing is waiting on this worker here.
    return (
      <div className="card flex items-start gap-3">
        <BellRing size={24} strokeWidth={2.25} aria-hidden className="shrink-0 mt-0.5 text-steel" />
        <div className="min-w-0 flex-1">
          <div className="text-lg font-bold leading-tight">Get a buzz {what}</div>
          {state === "ios-install"
            ? <div className="text-steel mt-0.5">On iPhone: tap Share, then <b>Add to Home Screen</b>. Open OnSite from there and turn alerts on.</div>
            : <><div className="text-steel mt-0.5">Shifts go to whoever answers first. Alerts reach you even with the app closed.</div>
                <button onClick={turnOn} disabled={pending} className="btn-dark btn-sm mt-2">{pending ? "Turning on…" : "Turn on alerts"}</button></>}
          {msg && <div className="text-sm font-semibold mt-1">{msg}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="card space-y-2">
      <div className="text-lg font-bold flex items-center gap-2"><BellRing size={20} strokeWidth={2.25} aria-hidden className="shrink-0" />Phone alerts</div>
      {state === "checking" && <p className="text-steel">Checking this phone…</p>}
      {state === "on" && <p>On for this phone. You'll get a buzz {what}.</p>}
      {state === "off" && <p>Off. Turn them on to get a buzz {what}{role === "worker" ? " — shifts go to whoever answers first" : ""}.</p>}
      {state === "blocked" && <p>Blocked in this browser's settings. Allow notifications for OnSite there, then come back.</p>}
      {state === "ios-install" && <p>On iPhone, alerts need OnSite on your Home Screen: tap Share, then <b>Add to Home Screen</b>, open it from there and turn alerts on.</p>}
      {state === "unsupported" && <p>This browser can't show alerts.{role === "worker" ? " We'll text you shift offers instead." : ""}</p>}
      {state === "off" && <button onClick={turnOn} disabled={pending} className="btn-primary">{pending ? "Turning on…" : "Turn on alerts"}</button>}
      {state === "on" && (
        <div className="grid grid-cols-2 gap-2">
          <button onClick={test} disabled={pending} className="btn-dark btn-sm w-full">Send me a test</button>
          <button onClick={turnOff} disabled={pending} className="btn-ghost btn-sm w-full">Turn off</button>
        </div>
      )}
      {msg && <p className="text-sm font-semibold">{msg}</p>}
    </div>
  );
}
