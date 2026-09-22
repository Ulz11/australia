import Link from "next/link";
import { siteToday } from "@/lib/siteClock";
import { redirect } from "next/navigation";
import { CircleAlert, Eye, EyeOff, MapPin } from "lucide-react";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Big, BigMoney, Cell, Say, Section } from "@/components/ui";
import { ConfirmButton } from "@/components/ConfirmButton";
import { NewCrewCard, type CrewRow } from "@/components/CrewsSection";
import { cancelBooking, takeShift } from "@/actions/worker";
import { TICKETS } from "@/lib/award";
import { openShiftsNear, myBookings } from "@/lib/workerQueries";
import { workerToday, type Shift, type TodayOffer } from "@/lib/workerToday";
import { agoParts, fmtDay, fmtTime, km, numOrNull, todayIso } from "@/lib/util";
import { getLang, getT } from "@/lib/i18n/server";
import { LOCALES, plural, type T } from "@/lib/i18n";
import { Calendar } from "./Calendar";
import { ShiftLive } from "./shift/ShiftLive";
export const dynamic = "force-dynamic";

/**
 * Taking an offer, from a cell that is drawn on the server.
 *
 * `takeShift` redirects to the shift screen when it works. Every refusal it can give except one is already
 * drawn on the cell as words before the tap — a card this worker hasn't got, a shift they're already on,
 * another job that day — and those cells carry no button at all. What is left is the race: the last spot
 * went while this screen sat in a pocket. So the one thing we can honestly say afterwards is that someone
 * was first, and the shift id rides back so the screen only says it about an offer that really has gone.
 */
async function take(shiftId: string) {
  "use server";
  const r = await takeShift(shiftId);
  if (r?.error) redirect(`/worker?gone=${shiftId}`);
}

/** "6:30am", or "6:30am Perth time" when the site keeps a different clock from the one you're reading on. */
const startWords = (t: T, s: { start: string; clockCity: string | null }) =>
  s.clockCity ? t("{time} {city} time", { time: fmtTime(s.start), city: s.clockCity }) : fmtTime(s.start);

export default async function WorkerHome({ searchParams }: { searchParams: Promise<{ gone?: string }> }) {
  const u = await requireRole("worker");
  const today = todayIso();
  // Started, not awaited: workerToday takes the promise and puts its own five statements in the same batch,
  // so the whole screen is one trip to the database rather than one trip per cell.
  const nearP = openShiftsNear(u.id);
  const [t, lang, { gone }] = await Promise.all([getT(), getLang(), searchParams]);
  const [day, [w], avail, bookingsAll, notes, crews, near] = await Promise.all([
    workerToday(u.id, nearP, today),
    // usual_days is the pattern; `pattern_live` is whether it still counts (worker_free() stops it after 14 quiet
    // days), and `any_days` says whether this worker has ever answered for a single day — a first-timer sees
    // Mon–Fri offered in the card, unsaved.
    sql`SELECT w.home IS NOT NULL AS has_home, w.usual_days,
               u.last_seen_at IS NOT NULL AND u.last_seen_at > now() - interval '14 days' AS pattern_live,
               EXISTS (SELECT 1 FROM availability a WHERE a.worker_id = w.user_id) AS any_days
        FROM workers w JOIN users u ON u.id = w.user_id WHERE w.user_id = ${u.id}`,
    sql`SELECT day::text, status FROM availability WHERE worker_id = ${u.id} AND day >= ${siteToday()} - 45`,
    myBookings(u.id),
    sql`SELECT id, kind, body FROM notifications WHERE user_id = ${u.id} AND read_at IS NULL AND kind NOT IN ('shift_match','crew_added','crew_joined') ORDER BY created_at DESC LIMIT 3`,
    // Crews a boss put this worker on in the last week. Said once, on the screen, with the way out beside it —
    // rather than as a notification they can only read.
    sql<CrewRow[]>`SELECT ci.boss_id, bo.company, us.name AS boss_name
       FROM crew_invites ci JOIN bosses bo ON bo.user_id = ci.boss_id JOIN users us ON us.id = ci.boss_id
       JOIN crew c ON c.boss_id = ci.boss_id AND c.worker_id = ${u.id}
       WHERE ci.worker_id = ${u.id} AND ci.joined_at > now() - interval '7 days'
       ORDER BY ci.joined_at DESC LIMIT 2`,
    nearP,
  ]);
  const locale = LOCALES[lang];
  const hello = t("G'day, {name}", { name: u.name?.split(" ")[0] ?? "" });

  /**
   * On site, or due there in the morning: the shift is the screen and nothing else is on it. The 80px
   * Clock in already sits where the thumb lands, and a second thing to aim at beside it is how a worker
   * holding a ladder with the other hand taps the wrong one.
   *
   * `primary` is false so no map loads here: the tile source is still unset, and an empty grey rectangle
   * on the home screen is worse than no map at all.
   */
  if (day.live) {
    const b = day.live;
    return (
      <>
        <Header title={hello} />
        <Page>
          <ShiftLive today={today} primary={false} b={{
            id: b.id, status: b.status, day: b.day, start_time: b.start, hours: b.hours, rate: b.rate,
            role: b.role, note: b.note, site: b.site, address: b.address, lat: b.lat, lng: b.lng,
            boss_name: b.bossName, boss_phone: b.bossPhone, boss_id: b.bossId, company: b.company ?? "",
            clock_in_at: b.clockInAt?.toISOString() ?? null, clock_out_at: b.clockOutAt?.toISOString() ?? null,
            clock_in_dist_m: b.clockInDistM, hours_worked: b.hoursWorked, hours_approved: b.hoursApproved,
          }} />
        </Page>
      </>
    );
  }

  const free = day.free;
  const bookings = bookingsAll.filter((b) => ["accepted", "clocked_in", "clocked_out"].includes(b.status));
  // Bosses find a worker through `worker_free()` and a home on the row — matching needs both, so the cell
  // is green only when both are true, and says which one is missing when it isn't.
  const seen = free.hasHome && free.free > 0;

  return (
    <>
      <Header title={hello} />
      <Page>
        {!w.has_home && (
          <Link href="/worker/me/settings" className="block">
            <Say tone="orange" icon={MapPin} title={t("Tell us where you live")} sub={t("Tap here. We only show shifts near you.")} />
          </Link>
        )}

        {crews.map((c) => <NewCrewCard key={c.boss_id} crew={c} />)}

        {day.tomorrow && (
          <div className="bento">
            <TomorrowCell t={t} s={day.tomorrow} locale={locale} />
          </div>
        )}

        <Section title={day.offersTotal > 0 ? t("Offers for you · {n}", { n: day.offersTotal }) : t("Offers for you")}
          hint={day.offersTotal > 0 ? t("A boss picked you for these. First to take it gets it.") : undefined} />
        {/* Only when that offer really is off the list. Anything else it could have been is still drawn on
            the cell it came from, and a guess here would be the app telling a worker a story. */}
        {gone && !day.offerIds.includes(gone) && <Say tone="grey" title={t("Someone took that one first.")} />}
        <div className="bento">
          {day.offers.length === 0
            ? <Cell span={2} label={t("No offers right now.")}
                sub={<span className="c-prose">{t("Mark the days you're free below and we'll buzz you when a boss nearby needs someone.")}</span>} />
            : day.offers.map((o) => <OfferCell key={o.id} t={t} o={o} today={today} locale={locale} />)}
        </div>

        {/*
          THE INTERLOCK. Three answers, three shapes, two grid rows: the money runs down the left as a 1x2
          and the two things about being findable stack beside it as 1x1s. It used to be three full-width
          cards in a column, which is the layout a bento is supposed to replace.

          Order here is grid order: the tall one is placed first so the two short ones fill the column beside
          it, and anything full-width comes last so it lands on a clean row of its own.
        */}
        <div className="bento">
          {/* The number a worker opens the app for, so it is the one ink cell on the screen — and ink is the
              press-me colour, so it goes somewhere: the names of who owes it are on Me. A 1x2 rather than a
              1x1 because it is the tallest object in the group and the figure should look like it: the money
              sits at the top of the tile and who owes it at the foot, with the room to say both. */}
          <BigMoney rows={2} tone="ink" href="/worker/me" n={day.owed.dollars} label={t("Owed to me")}
            sub={day.owed.bosses === 0
              ? t("When a boss approves your hours, it lands here.")
              : plural(t, day.owed.bosses, "{n} boss · oldest {when}", "{n} bosses · oldest {when}",
                { when: day.owed.since ? whenWords(t, day.owed.since) : "" })} />

          {/* It goes to the days; it never sets one. A cell you can flip by mis-tapping is how a gloved
              thumb takes a worker off every boss's list for a week without knowing it. */}
          <Big href="#your-days" n={free.free} label={t("Free days")}
            sub={plural(t, free.jobs, "{n} job near you", "{n} jobs near you")} />

          {/* A 1x1, so the sentence gets cut: what is left on the tile is the state and the count, and the
              part about the pattern going quiet after fourteen days is what a screen reader is told. The
              sr sentence sits inside the link, so what is spoken is still a link to the days. */}
          <Cell tone={seen ? "gos" : "white"} icon={seen ? Eye : EyeOff}
            href={seen ? undefined : free.hasHome ? "#your-days" : "/worker/me/settings"}
            label={seen ? t("Bosses can see you") : t("Bosses can't see you")}
            sub={seen
              ? <span className="num">{plural(t, free.free, "{n} free day this week", "{n} free days this week")}</span>
              : free.hasHome ? t("Say which days you're free.") : t("Tap here. We only show shifts near you.")}
            sr={seen
              ? `${t("Bosses can see you")} ${plural(t, free.free, "{n} free day this week", "{n} free days this week")}. ${t("Keep opening OnSite and it stays that way.")}`
              : undefined} />

          {/* A card that has run out is not paperwork: it is jobs that quietly stop being offered. Full
              width and last, so it lands on its own row under the pair above rather than splitting them.
              Hidden while there is no home on the row, because then the orange at the top of this screen is
              the one thing worth tapping, and two orange things is none. */}
          {day.card && free.hasHome && (
            <Cell span={2} tone={day.card.expired ? "warns" : "soft"} icon={CircleAlert} href="/worker/me/edit"
              label={day.card.expired
                ? t("{card} has run out", { card: day.card.name })
                : t("{card} expires {date}", { card: day.card.name, date: fmtDay(day.card.expiresOn, locale) })}
              sub={day.card.jobs > 0
                ? plural(t, day.card.jobs, "{n} job near you needs it", "{n} jobs near you need it")
                : t("Add the new one.")} />
          )}
        </div>

        <Link href="/worker/explore" className="btn-ghost">{t("Find work near me")}</Link>

        {notes.map((n) => <Say key={n.id} tone={n.kind === "paid" ? "green" : n.kind === "removed" || n.kind === "cancelled" ? "red" : "dark"} title={n.body} />)}

        {/*
          The days stay on this screen until /worker/week exists to hold them (build order 45). They are the
          only place in the app a worker can say they are free, and the two cells above both count what this
          control writes — so moving them out first would leave a screen that reports a number nobody can
          change. `scroll-mt` keeps the sticky header off the heading when the Free days cell jumps here.
        */}
        <div id="your-days" className="scroll-mt-20 space-y-4">
          <Section title={t("Your days")} hint={t("Set the days you're usually free, then change any single day below.")} />
          <Calendar
            usualDays={(w.usual_days ?? []).map(Number)}
            patternLive={w.pattern_live}
            first={(w.usual_days ?? []).length === 0 && !w.any_days}
            availability={Object.fromEntries(avail.map((a) => [a.day, a.status]))}
            shifts={near.map((s) => ({ id: s.id, day: s.day, start_time: s.start_time, hours: Number(s.hours), rate: Number(s.rate), role: s.role, site: s.site, dist_m: s.dist_m, boss: s.company || s.boss_name, spots: s.spots, taken: s.taken, tickets_ok: s.tickets_ok, notified: s.notified, mine: s.mine, tickets_required: s.tickets_required, approve_h: numOrNull(s.approve_hours_avg), pay_d: numOrNull(s.pay_days_avg), ot_mode: s.ot_mode, ot_after_hours: Number(s.ot_after_hours), ot_multiplier: s.ot_multiplier == null ? null : Number(s.ot_multiplier), allow_offers: s.allow_offers, offered: s.offered }))}
            bookings={bookings.map((b) => ({ id: b.id, day: b.day, start_time: b.start_time, site: b.site, hours: Number(b.hours), status: b.status }))}
          />
        </div>
      </Page>
    </>
  );
}

/** "6 days ago", in the reader's language, out of the shape lib/util already splits for translation. */
function whenWords(t: T, d: Date) {
  const { key, n } = agoParts(d);
  return t(key, { n });
}

/**
 * Tomorrow, from the evening before: what it pays, where, when on that site's clock, and the two things
 * a worker can do about it. The money is `payForShift()` — the Award floor and the overtime split — so it
 * is the same figure the offer showed and the same figure the boss will approve.
 *
 * No green border on "confirmed": accepting is the only yes this app records today, so a border that is
 * always on would encode nothing. It comes back when there is an "I'm coming" to be on the other side of.
 */
function TomorrowCell({ t, s, locale }: { t: T; s: Shift; locale: string }) {
  return (
    <BigMoney span={2} rows={2} n={s.pay} label={t("Tomorrow")} sub={
      <>
        <div>{t("{site} · {time} · {n} h", { site: s.site, time: startWords(t, s), n: s.hours })}</div>
        {s.distM != null && <div className="c-prose">{t("{km} from home", { km: km(s.distM) })}</div>}
        <div className="cell-bar">
          <Link href="/worker/shift" className="cell-act min-h-[56px]">{t("Open my shift")}</Link>
          <ConfirmButton action={cancelBooking.bind(null, s.id)} className="cell-act-ghost min-h-[56px] w-full"
            danger title={t("Pull out of this shift?")}
            details={[
              t("{name} gets a message straight away.", { name: s.bossName.split(" ")[0] }),
              t("Your spot goes back out to other workers nearby."),
              t("It counts on your record as pulling out — bosses see how often that happens."),
            ]}
            confirmLabel={t("Yes, pull out")} cancelLabel={t("Keep my shift")}>{t("Can't make it")}</ConfirmButton>
        </div>
        <p className="sr-only">{fmtDay(s.day, locale)}</p>
      </>
    } />
  );
}

/**
 * One offer. White, because an offer is work on the table and not a job to do — the screen's orange belongs
 * to the one thing that is actually stuck. `.cell-soft` only inside the last hour, when it has nearly
 * stopped being an offer, and it says so in words beside the colour.
 *
 * There is no Take button when the answer is already no: `bookWorker` refuses a shift that clashes with one
 * this worker has already said yes to, and refuses a card they haven't got. A button that is certain to
 * fail is worse than the sentence explaining why it isn't there.
 */
function OfferCell({ t, o, today, locale }: { t: T; o: TodayOffer; today: string; locale: string }) {
  const blocked = !o.ticketsOk || o.clash;
  const label = t("{day} · {time}", { day: o.day === today ? t("Today") : fmtDay(o.day, locale), time: fmtTime(o.start) });
  return (
    <BigMoney span={2} tone={o.soon ? "soft" : "white"} n={o.pay} label={label} sub={
      <>
        <div>{t("{n} h · {role}", { n: o.hours, role: o.role })}</div>
        {o.distM != null && <div className="c-prose">{t("{km} from home", { km: km(o.distM) })}</div>}
        {o.soon && <div>{t("Starts within the hour.")}</div>}
        {o.lastSpot && <div>{t("Last spot")}</div>}
        {!o.ticketsOk && <div className="text-warn font-bold">{t("Needs {cards} — that one isn't on your cards", { cards: o.missing.map((c) => TICKETS[c] ?? c).join(", ") })}</div>}
        {o.ticketsOk && o.clash && <div className="text-warn font-bold">{t("You already have a shift that day.")}</div>}
        {!blocked && (
          <div className="cell-bar">
            {/* The whole 56px foot, not a 132px corner of it: this is the tap the screen exists for. */}
            <form action={take.bind(null, o.id)}>
              <button className="cell-act min-h-[56px] w-full">{t("Take it")}</button>
            </form>
          </div>
        )}
      </>
    } />
  );
}
