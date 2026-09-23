"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BellRing, Check, Map as MapIcon, X } from "lucide-react";
import { LazyMap } from "@/components/LazyMap";
import type { Pin } from "@/components/MapPicker";
import { Section } from "@/components/ui";
import type { S } from "../Calendar";
import { OfferSheet } from "../OfferSheet";
import { takeShift } from "@/actions/worker";
import { money, TICKETS } from "@/lib/award";
import { otInWords, payForShift, type OtTerms } from "@/lib/rules";
import { fmtDay, fmtTime, km, todayIso } from "@/lib/util";
import { plural } from "@/lib/i18n";
import { useT, useLocale } from "@/components/Lang";

/**
 * The interactive half of the map tab: search, the opt-in map, and the shifts themselves as cells.
 *
 * WHY THE MAP IS OFF UNTIL SOMEBODY ASKS FOR IT. There is no tile source configured, so MapPicker draws
 * raster tiles from tile.openstreetmap.org, and that project's usage policy is explicit that it is not
 * there to be the first paint of a commercial app. It is also 300 kB of map library and a screenful of
 * imagery on a phone with one bar of signal in a lunch shed. The cells above this component answer "is
 * there work near me" on their own, so the map is what it should have been all along: a bonus, one press
 * away, in exactly the place it already sat. The legend goes with it, word for word — without it, colour
 * is the only message on 280px of raster tile, and colour is never allowed to be the message on its own.
 *
 * WHAT USED TO BE HERE. A Map/List segmented control that only ever hid the map (the list rendered under
 * both), which is a two-button control for a one-button job. It is now the one button, and it says which
 * way it will go.
 */

type XS = S & { project_id: string; avail: string };

export function Explore({ home, radiusKm, sites, shifts, q }: { home: [number, number]; radiusKm: number; sites: { id: string; name: string; lat: number; lng: number }[]; shifts: XS[]; q: string }) {
  const [mapOn, setMapOn] = useState(false);
  const [site, setSite] = useState<string | null>(null);
  const [query, setQuery] = useState(q);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  const today = todayIso();
  const t = useT();
  const locale = useLocale();
  const counts = useMemo(() => { const m: Record<string, number> = {}; for (const s of shifts) if (!s.mine) m[s.project_id] = (m[s.project_id] ?? 0) + 1; return m; }, [shifts]);
  // A site is orange only where a shift on it was offered to this worker; open work nobody asked them about is ink.
  const offered = useMemo(() => { const m: Record<string, number> = {}; for (const s of shifts) if (!s.mine && s.notified) m[s.project_id] = (m[s.project_id] ?? 0) + 1; return m; }, [shifts]);
  const pins: Pin[] = [{ id: "home", lat: home[1], lng: home[0], kind: "home" as const }, ...sites.map((s) => ({
    id: s.id, lat: s.lat, lng: s.lng, label: s.name,
    count: offered[s.id] ?? counts[s.id] ?? 0,
    kind: (offered[s.id] ? "offer" : counts[s.id] ? "work" : "site") as Pin["kind"],
  }))];
  const list = (site ? shifts.filter((s) => s.project_id === site) : shifts).filter((s) => !s.mine);
  const take = (id: string) => start(async () => { setErr(null); const r = await takeShift(id); if (r?.error) setErr(r.error); });

  return (
    <div className="space-y-4">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); router.push(`/worker/explore?q=${encodeURIComponent(query)}`); }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Search: forklift, concreter, Newtown…")} className="input" />
        <button className="btn-dark btn-sm">{t("Go")}</button>
      </form>

      <div className="bento">
        {/* Not ink: ink is the press-me colour of every button in the app and it is spent on money, not on
            a picture. A white cell that says which way it is about to go is enough of a promise. */}
        <button type="button" onClick={() => setMapOn((v) => !v)} aria-expanded={mapOn}
          className="cell cell-link b-w2 text-left">
          <div className="min-w-0">
            <div className="c-label flex items-start gap-1.5">
              <MapIcon size={18} strokeWidth={2.5} aria-hidden className="shrink-0" />
              <span className="min-w-0">{mapOn ? t("Hide the map") : t("Show the map")}</span>
            </div>
            <div className="c-sub c-prose">{t("Pins for every site with work near you.")}</div>
          </div>
        </button>

        {mapOn && (
          // cell-frame is the one place bg-site is allowed to hold something, because it is map chrome and
          // never carries a figure. The legend is the cell's foot, which is where the spec puts it.
          <div className="cell cell-frame b-w2 b-h3 gap-2">
            <LazyMap center={home} zoom={radiusKm > 30 ? 9 : 11} radiusKm={radiusKm} pins={pins}
              onPinClick={(id) => setSite(id === "home" ? null : id)} className="h-64 rounded-xl overflow-hidden" />
            <div className="c-sub px-2 pb-1">
              {t("Black dot is home.")} <b>{t("Orange pins are shifts a boss offered you.")}</b> {t("White pins have work open to anyone — tap one. Grey dots are sites with nothing open right now.")}
            </div>
          </div>
        )}
      </div>

      {site && (
        <div className="flex items-center justify-between gap-2">
          <div className="text-lg font-bold truncate">{sites.find((s) => s.id === site)?.name}</div>
          <button className="btn-ghost btn-sm shrink-0" onClick={() => setSite(null)}>{t("Show all")}</button>
        </div>
      )}

      {list.length === 0 ? (
        <div className="bento">
          <div className="cell b-w2">
            <div className="min-w-0">
              <div className="c-label">{t("Nothing open")}</div>
              <div className="c-sub c-prose">{site ? t("Nothing open at this site right now.") : t("No open shifts within your travel distance right now.")}</div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <Section title={plural(t, list.length, "{n} shift you could take", "{n} shifts you could take")} />
          <div className="bento">
            {list.map((s) => <ShiftCell key={s.id} s={s} today={today} locale={locale} pending={pending} onTake={() => take(s.id)} />)}
          </div>
        </>
      )}
      {err && <div className="say-red"><div className="say-title">{err}</div></div>}
    </div>
  );
}

/**
 * One shift, as a cell. The same facts ShiftCard carries and the same two actions, in the bento's shapes.
 *
 * NOT ShiftCard. That one lives in app/worker/Calendar.tsx and is a card — 2xl type, its own border, a
 * full-width ink button — which is right on the calendar's day panel and wrong inside a two-column grid
 * where every other thing on the screen is a cell. Take and the deal request call exactly the same
 * `takeShift()` and the same `OfferSheet`, with the same disabled rules, so the behaviour is unchanged.
 *
 * ONE CHANGE TO THE NUMBERS, DELIBERATE: the day's pay is `payForShift()` and no longer `rate × hours`
 * rounded. Multiplying skips the Award floor and the overtime split, so on any day over 8 h or under
 * $35.55 it prints a figure the offer screen, the boss's approve screen and lib/workerToday all disagree
 * with — the same 10 h at $34 read $340 here and $391 there, and a worker had no way to know which one to
 * believe. lib/workerToday.ts names this file's old `Math.round(rate * hours)` as one of the three.
 *
 * `cell-soft` for an offer rather than full orange: orange means "this needs you, now" and there is one of
 * those on a screen. Four offered shifts painted the loudest colour are four claims on the same "now", and
 * the words carry it anyway.
 */
function ShiftCell({ s, today, locale, pending, onTake }: { s: XS; today: string; locale: string; pending: boolean; onTake: () => void }) {
  const t = useT();
  const [offering, setOffering] = useState(false);
  const left = s.spots - s.taken;
  // The White Card is on every shift and in every worker's list, so naming it adds a line and no news.
  const need = s.tickets_required.filter((k) => k !== "WC");
  const canTake = s.tickets_ok && left > 0;
  const terms: OtTerms = { ot_mode: (s.ot_mode ?? "award") as OtTerms["ot_mode"], ot_after_hours: s.ot_after_hours ?? 8, ot_multiplier: s.ot_multiplier ?? null };
  const [dollars, cents] = money(payForShift(s.hours, s.rate, terms).gross).split(".");
  const spots = left > 1 ? ` · ${t("{n} spots", { n: left })}` : left === 1 && s.spots > 1 ? ` · ${t("last spot")}` : "";

  return (
    <div className={`cell b-w2 ${s.notified ? "cell-soft" : ""}`}>
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="c-label">{s.day === today ? t("Today") : fmtDay(s.day, locale)}</span>
          <span className={`text-[15px] leading-[1.25] font-medium shrink-0 ${s.avail === "free" ? "text-go" : "text-steel"}`}>
            {s.avail === "free" ? t("You're free") : t("You said busy — taking it is fine")}
          </span>
        </div>

        {s.notified && (
          <div className="c-label flex items-start gap-1.5">
            <BellRing size={18} strokeWidth={2.5} aria-hidden className="shrink-0" />
            <span className="min-w-0">{t("Offered to you")}</span>
          </div>
        )}

        <div className="c-fig-2 flex items-baseline gap-1.5 min-w-0">
          <span className="truncate">{dollars}<span className="text-[0.5em] align-top">.{cents}</span></span>
          <span className="c-unit shrink-0">{t("for the day")}</span>
        </div>

        <div className="min-w-0">
          <div className="c-label">{s.role} · {s.site}</div>
          <div className="c-sub num">
            {t("{time} start", { time: fmtTime(s.start_time) })} · {t("{n} hours", { n: s.hours })} · {t("${rate} an hour", { rate: s.rate.toFixed(2) })}
          </div>
          <div className="c-sub num">{t("{km} from home", { km: km(s.dist_m) })} · {s.boss}{spots}</div>

          {need.length > 0 && (
            <div className={`c-sub font-bold flex items-start gap-1.5 ${s.tickets_ok ? "text-go" : "text-warn"}`}>
              {s.tickets_ok
                ? <><Check size={20} strokeWidth={2.5} aria-hidden className="shrink-0" /><span className="min-w-0">{t("You have the {cards} licence", { cards: need.map((k) => TICKETS[k] ?? k).join(", ") })}</span></>
                : <><X size={20} strokeWidth={2.5} aria-hidden className="shrink-0" /><span className="min-w-0">{t("Needs {cards} licence — you don't", { cards: need.map((k) => TICKETS[k] ?? k).join(", ") })}</span></>}
            </div>
          )}

          {s.ot_mode && (
            <div className="c-sub rounded-lg bg-black/5 px-2.5 py-1.5">
              <b>{t("Overtime agreed up front:")}</b> {otInWords(terms, s.rate)}
            </div>
          )}

          {(s.approve_h != null || s.pay_d != null) && (
            <div className="c-sub c-prose num">
              {t("This boss")} {s.approve_h != null ? t("approves hours in about {n} h", { n: s.approve_h }) : ""}{s.approve_h != null && s.pay_d != null ? ", " : ""}{s.pay_d != null ? t("pays in about {n} days", { n: s.pay_d }) : ""}.
            </div>
          )}

          {canTake && s.allow_offers !== false && s.offered && !offering && (
            <div className="c-sub c-prose">{t("You've asked for a different deal — waiting on the boss.")}</div>
          )}
        </div>

        {/* The sheet is a form, not a modal, so it opens inside the cell and the foot bar stands down —
            two "Take it" buttons on screen while somebody is typing a counter-offer is two answers to one
            question. Cancel on the sheet brings the bar straight back. */}
        {offering && (
          <OfferSheet shift={{ id: s.id, rate: s.rate, hours: s.hours, start_time: s.start_time, site: s.site }}
            onClose={() => setOffering(false)} />
        )}
      </div>

      {!offering && (
        <div className="cell-bar">
          <button type="button" className="cell-act disabled:opacity-40 disabled:pointer-events-none"
            onClick={onTake} disabled={pending || !canTake}>
            {!s.tickets_ok ? t("Can't take — licence needed") : left <= 0 ? t("Filled") : t("Take it")}
          </button>
          {canTake && s.allow_offers !== false && !s.offered && (
            <button type="button" className="cell-act-ghost" onClick={() => setOffering(true)}>
              {t("Ask for a different deal")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
