"use client";
import { useEffect, useOptimistic, useState, useTransition } from "react";
import { Check } from "lucide-react";
import { clockIn, clockOut, cancelBooking, workerLogCall } from "@/actions/worker";
import { LazyMap } from "@/components/LazyMap";
import { CallLink } from "@/components/CallLink";
import { ConfirmButton } from "@/components/ConfirmButton";
import { fmtDay, fmtTime, km, TZ } from "@/lib/util";

type B = { id: string; status: string; day: string; start_time: string; hours: number; rate: number; role: string; note: string | null; site: string; address: string; lat: number; lng: number; boss_name: string; boss_phone: string; boss_id: string; company: string; clock_in_at: string | null; clock_out_at: string | null; clock_in_dist_m: number | null; hours_worked: number | null; hours_approved: number | null };

export function ShiftLive({ b, primary, today }: { b: B; primary: boolean; today: string }) {
  const [pending, start] = useTransition();
  const [now, setNow] = useState(() => Date.now());
  // Status flips on screen immediately; the GPS lookup and the server happen behind it.
  const [status, setStatus] = useOptimistic(b.status);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  const elapsed = b.clock_in_at ? (now - new Date(b.clock_in_at).getTime()) / 36e5 : 0;
  const t = (d: string) => new Date(d).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", timeZone: TZ });

  function doClockIn() {
    start(async () => {
      setStatus("clocked_in");
      const pos = await new Promise<GeolocationPosition | null>((res) => {
        if (!navigator.geolocation) return res(null);
        navigator.geolocation.getCurrentPosition((p) => res(p), () => res(null), { enableHighAccuracy: true, timeout: 4000, maximumAge: 60000 });
      });
      await clockIn(b.id, pos?.coords.latitude ?? null, pos?.coords.longitude ?? null);
    });
  }
  const doClockOut = () => start(async () => { setStatus("clocked_out"); await clockOut(b.id); });

  return (
    <div className="space-y-3">
      <div className="card">
        <div className="label">{b.day === today ? "Today" : fmtDay(b.day)} · {fmtTime(b.start_time)} start</div>
        <div className="text-2xl font-extrabold">{b.site}</div>
        <div className="text-steel">{b.address}</div>
        <div className="mt-2 text-lg">{b.role} · {b.hours} hours · <b className="num">${b.rate.toFixed(2)}/h</b></div>
        <div className="text-steel">Boss: {b.boss_name}{b.company ? ` (${b.company})` : ""}{b.note ? <> · “{b.note}”</> : null}</div>
      </div>

      {status === "accepted" && (
        <>
          <button className="btn-primary text-2xl min-h-[80px]" onClick={doClockIn} disabled={pending}>Clock in</button>
          <div className="text-steel text-center">Tap when you get to the site. Works anywhere — the boss just sees how far away you were.</div>
        </>
      )}
      {status === "clocked_in" && (
        <div className="say-green text-center">
          <div className="say-sub">On site{b.clock_in_at ? ` since ${t(b.clock_in_at)}` : ""}</div>
          <div className="text-6xl font-extrabold num my-2">{elapsed.toFixed(1)}h</div>
          {b.clock_in_dist_m != null && <div className="say-sub mb-3">You clocked in {km(b.clock_in_dist_m)} from the site.</div>}
          <button className="btn bg-white text-ink w-full text-2xl min-h-[72px]" onClick={doClockOut} disabled={pending}>Clock out</button>
          <div className="say-sub mt-2">Tap when you finish. Your hours go to the boss.</div>
        </div>
      )}
      {/* Nothing is waiting on the worker here — the hours are with the boss now. Grey, with a tick. */}
      {status === "clocked_out" && (
        <div className="say-grey">
          <div className="flex items-start gap-3">
            <Check size={24} strokeWidth={2.25} aria-hidden className="shrink-0 mt-0.5 text-go" />
            <div className="min-w-0 flex-1">
              <div className="say-sub">Done for the day</div>
              <div className="say-title">{Number(b.hours_worked ?? 0) || "…"} hours sent to {b.boss_name.split(" ")[0]}</div>
              <div className="say-sub">About ${(Number(b.hours_worked ?? 0) * b.rate).toFixed(0)}. Once the boss approves it, it shows in Me, under Owed to me.</div>
            </div>
          </div>
        </div>
      )}

      {primary && <LazyMap center={[b.lng, b.lat]} zoom={14} pins={[{ id: "s", lat: b.lat, lng: b.lng, kind: "place", label: b.site }]} className="h-40" />}

      <div className="grid grid-cols-2 gap-2">
        <CallLink phone={b.boss_phone} name={b.boss_name} onCall={workerLogCall.bind(null, b.boss_id, b.id)} className="btn-ghost btn-sm w-full" />
        {status === "accepted" && (
          <ConfirmButton action={cancelBooking.bind(null, b.id)} className="btn-danger btn-sm w-full"
            title="Pull out of this shift?"
            details={[
              `${b.boss_name.split(" ")[0]} gets a message straight away.`,
              "Your spot goes back out to other workers nearby.",
              "It counts on your record as pulling out — bosses see how often that happens.",
            ]}
            confirmLabel="Yes, pull out" cancelLabel="Keep my shift">Can't make it</ConfirmButton>
        )}
      </div>
    </div>
  );
}
