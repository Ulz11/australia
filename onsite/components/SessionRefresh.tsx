"use client";
import { useEffect } from "react";

const KEY = "onsite:session-refreshed-at";
export const REFRESH_EVERY_MS = 6 * 60 * 60 * 1000;

/** Due unless the last ask was under 6 hours ago. A timestamp from the future (a clock set back) counts as due. */
export const refreshDue = (last: number, now: number) => !(last > 0 && last <= now && now - last < REFRESH_EVERY_MS);

let lastHere = 0;   // storage blocked (private mode, full): still at most once per 6 h per loaded app

/**
 * Keeps this browser signed in (app/api/session/refresh). Mounted once in the boss and worker layouts; asks at
 * most every 6 hours per browser, never waits for the answer, never retries, shows nothing.
 */
export function SessionRefresh() {
  useEffect(() => {
    const now = Date.now();
    let last = lastHere;
    try { last = Math.max(last, Number(localStorage.getItem(KEY)) || 0); } catch { /* storage blocked */ }
    if (!refreshDue(last, now)) return;
    lastHere = now;
    try { localStorage.setItem(KEY, String(now)); } catch { /* storage blocked */ }
    fetch("/api/session/refresh", { method: "POST", credentials: "same-origin", cache: "no-store" }).catch(() => {});
  }, []);
  return null;
}
