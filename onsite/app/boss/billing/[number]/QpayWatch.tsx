"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

/** Every 5 s while the page is in front; every 30 s while the boss is off in their bank app; give up after 10 min. */
export const POLL_MS = 5_000;
export const HIDDEN_POLL_MS = 30_000;
export const GIVE_UP_MS = 10 * 60_000;

/**
 * Keeps an eye on QPay while a QR is up. Asks /boss/billing/<number>/status — which settles the QPay invoice,
 * throttled on the server — and refreshes the page the moment the invoice is no longer open, so "Paid" shows
 * without a tap. Coming back to the tab checks straight away. Shows nothing while it's watching.
 */
export function QpayWatch({ number }: { number: string }) {
  const router = useRouter();
  const [stopped, setStopped] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const started = Date.now();
    const hidden = () => document.visibilityState === "hidden";
    const later = (ms: number) => { clearTimeout(timer); if (!done) timer = setTimeout(tick, ms); };

    async function tick() {
      if (done) return;
      if (Date.now() - started > GIVE_UP_MS) { done = true; setStopped(true); return; }
      try {
        const res = await fetch(`/boss/billing/${encodeURIComponent(number)}/status`, {
          cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" },
        });
        if (res.status === 401 || res.status === 404) { done = true; setStopped(true); return; }
        const body = res.ok ? ((await res.json()) as { status?: string }) : null;
        if (body?.status && body.status !== "open") { done = true; router.refresh(); return; }
      } catch {
        /* offline for a moment — the next round tries again */
      }
      later(hidden() ? HIDDEN_POLL_MS : POLL_MS);
    }

    const onVisibility = () => { if (!hidden()) later(0); };
    document.addEventListener("visibilitychange", onVisibility);
    later(POLL_MS);
    return () => { done = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [number, router, round]);

  if (!stopped) return null;
  return (
    <div className="space-y-2">
      <p className="text-steel">Stopped checking after 10 minutes. Paid already? Check again.</p>
      <button type="button" className="btn-ghost" onClick={() => { setStopped(false); setRound((r) => r + 1); }}>
        <RefreshCw size={22} strokeWidth={2.25} aria-hidden />Check again
      </button>
    </div>
  );
}
