import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { Big, Cell, Flag, Row, Section } from "@/components/ui";
import { JobCard } from "@/components/JobCard";
import { Pips } from "@/components/cells";
import { WeekStrip, type StripDay } from "@/components/WeekStrip";
import { weekGaps, type WeekDay, type WeekJob } from "@/lib/weekGaps";
import { bossRecord, SMALL_N, WINDOW_DAYS, fillWords as howLong } from "@/lib/profileStats";
import { fillWords as bookedWords, groupByPost } from "@/lib/posts";
import { fmtTime } from "@/lib/util";
export const dynamic = "force-dynamic";

/**
 * THE FORTNIGHT — the calendar a boss opens to answer one question: is anything short, and when.
 *
 * A fortnight and not a week, because the bill closes on a fortnight (lib/weekGaps.ts has the reasoning)
 * and a seven-day calendar answers "am I covered?" for half the window the money is counted over.
 *
 * ONE ORANGE THING, AND IT IS THE TOP CELL. Orange means "this needs you, now", so it is spent on the one
 * state where now is literally true: a hole on today or tomorrow, which is the last night there is anybody
 * left to ring. A hole eleven days out is real and is drawn `cell-soft` — the volume step /boss already
 * uses for its second-ranked item — because painting both the same colour is exactly the flattening
 * lib/rank.ts was written to end. The strip, the job rows and the two record cells carry no orange at all.
 *
 * THE STRIP IS THE HERO. Fourteen columns of holes used to be drawn 56px tall inside a wide card under a
 * heading — a chart being used as a caption. components/WeekStrip.tsx lays itself out as a full 2x2 in a
 * .bento now, with 80px bars, and a short day is the darkest and tallest mark on the screen in that order.
 * The cell above it keeps its own 2x2 because it carries the one orange and a 64px action bar; everything
 * else on the screen is rows and two 1x1 record tiles.
 *
 * EVERY NUMBER COMES FROM A MODULE, NOT FROM THIS FILE. The fortnight is lib/weekGaps.ts; the 90-day
 * record is lib/profileStats.ts. Nothing here counts anything, so the calendar and /boss can never end up
 * disagreeing about whether Thursday is short.
 *
 * FAIL WHITE, NEVER FAIL GREEN. `weekGaps()` answers with `days: null` when its statement threw rather
 * than with fourteen clear days, and this screen renders that as white and says so. A green "every day is
 * covered" that is really a query that timed out sends a boss home with a hole still in Thursday.
 */

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A job line is full when every spot on it is taken. A book-again fills by definition and is never short. */
const full = (j: { taken: number; spots: number; direct: boolean }) => j.direct || j.taken >= j.spots;

/**
 * Where "Fill Thursday" actually lands today.
 *
 * lib/weekGaps hands back the spec's `/boss/post?day=&project=&role=`, which is build order 39 and does
 * not exist yet — following it would 404 the one button on this screen that has a job to do. lib/bossToday
 * solves the same problem for lib/rank's hrefs with its `LIVE` map; this is that map for one route. The
 * day and the role are dropped because /boss/shifts/new reads neither: it takes `?project=` and nothing
 * else, so the boss lands on the right site with the day still to pick. Delete this the day 39 ships.
 */
const postHref = (d: WeekDay) => {
  const project = new URLSearchParams(d.href.split("?")[1] ?? "").get("project");
  return project ? `/boss/shifts/new?project=${project}` : "/boss/shifts/new";
};

/**
 * The fill donut: ink at the heatmap's full step on the heatmap's empty step.
 *
 * Drawn here rather than added to components/cells.tsx because that file is a shared kit and this is one
 * screen's mark. The two opacities are .hm-3 and .hm-0's numbers — those classes are `fill:` rules and a
 * ring is a `stroke`, so the values are repeated rather than the classes reused. If the heatmap's steps
 * ever move, this moves with them.
 */
function Donut({ part, of, size = 40 }: { part: number; of: number; size?: number }) {
  const r = 16;
  const round = 2 * Math.PI * r;
  const frac = of > 0 ? Math.min(1, Math.max(0, part / of)) : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden className="shrink-0 -rotate-90 block">
      <circle cx={20} cy={20} r={r} fill="none" stroke="currentColor" strokeOpacity={0.16} strokeWidth={7} />
      {frac > 0 && (
        <circle cx={20} cy={20} r={r} fill="none" stroke="currentColor" strokeOpacity={0.92} strokeWidth={7}
          strokeDasharray={`${frac * round} ${round}`} />
      )}
    </svg>
  );
}

/** One job line, said the way /boss says it: what the work is, then how full it is, then whose clock it runs on. */
function jobWords(j: WeekJob) {
  return (
    <>
      {j.spots} × {j.role}
      <br />
      <Flag tone={full(j) ? "green" : "grey"} className="mt-1 align-middle">
        {j.direct ? "Booked direct" : full(j) ? "All spots taken" : bookedWords(j.taken, j.spots)}
      </Flag>
      {j.tzWords && <span className="ml-1.5 align-middle text-steel">{j.tzWords}</span>}
    </>
  );
}

/**
 * One day's panel, rendered on the server and handed to the strip whole.
 *
 * Fourteen of these are built per request and thirteen of them are never looked at. That is the trade:
 * ~14 days of job rows in the payload once, against a round trip every time a thumb moves one column on a
 * site with no signal. The rows are the same `Row` and `JobCard` shapes /boss draws, with `groupByPost`
 * intact, so a job posted as "2 carpenters and 1 forklift driver" reads as one job here too.
 */
function DayPanel({ d }: { d: WeekDay }) {
  const heading = d.when.charAt(0).toUpperCase() + d.when.slice(1);
  const jobs = groupByPost(d.jobs.map((j) => ({ ...j, id: j.shiftId, post_id: j.postId })));

  if (d.jobs.length === 0) {
    return (
      <>
        <Section title={heading} />
        <Empty>
          <div className="text-ink font-extrabold text-xl mb-1">Nothing on this day</div>
          <div className="mb-4">No job posted for {d.when}.</div>
          <Link href={postHref(d)} className="btn-primary">Post a job</Link>
        </Empty>
      </>
    );
  }

  const hint = [
    plural(d.jobs.length, "job"),
    d.spots > 0 ? `${d.taken} of ${d.spots} spots` : null,
    d.onSite > 0 ? `${plural(d.onSite, "worker")} on site` : null,
  ].filter(Boolean).join(" · ");

  return (
    <>
      <Section title={heading} hint={hint} />
      {/* The day's own one thing, in lib/weekGaps' words. Grey, not orange: the cell at the top of the
          screen already holds the single orange, and this line repeats for whichever day is selected. */}
      {d.need && <p className="text-steel text-base">{d.need}</p>}
      <div className="space-y-2">
        {jobs.map(({ key, lines }) => {
          const s = lines[0];
          if (lines.length === 1) {
            return (
              <Row key={key} href={`/boss/shifts/${s.id}`} title={`${fmtTime(s.start)} · ${s.site}`}
                sub={jobWords(s)} />
            );
          }
          return (
            <JobCard key={key} title={`${fmtTime(s.start)} · ${s.site}`}
              sub={`${plural(lines.length, "kind")} of worker`}
              tone={lines.every(full) ? "green" : undefined}
              lines={lines.map((l) => ({
                id: l.id,
                title: `${l.spots} × ${l.role}`,
                tone: full(l) ? "green" : undefined,
                sub: l.direct ? "Booked direct" : bookedWords(l.taken, l.spots),
              }))} />
          );
        })}
      </div>
      {/* Posting for the day you are looking at, labelled with that day. The strip's own tap only selects. */}
      <Link href={postHref(d)} className="btn-ghost">Post another job for {d.when}</Link>
    </>
  );
}

export default async function Week() {
  const u = await requireRole("boss");
  const [t, rec] = await Promise.all([weekGaps(u.id), bossRecord(u.id)]);

  /**
   * Spec 3.5 and 3.6 add `jobsPosted`, `jobsFilled` and `firstYesMin` to `pulse` (lib/profileStats.ts,
   * build order 26). They are read through `Partial` so this screen compiles and ships either side of that
   * change, and when they are absent the two cells below render white and say they could not be counted.
   *
   * They are deliberately NOT backed off onto `pulse.spots / pulse.taken / pulse.fillMin`, which are there
   * today. Those are the exact figures the two corrections exist to retire: `spots` makes two 5-spot jobs
   * look like ten posting decisions, and `fillMin` drops never-filled shifts from its own denominator, so
   * it gets *more* flattering as a boss's fill rate gets worse. A biased number under an honest label is
   * worse than no number, so this waits.
   */
  const pulse = rec.pulse as typeof rec.pulse &
    Partial<{ jobsPosted: number; jobsFilled: number; firstYesMin: number | null }>;
  const posted = pulse.jobsPosted;
  const filled = pulse.jobsFilled;
  const firstYes = pulse.firstYesMin;
  /** Jobs that never filled at all: the censored half of "how fast the first yes came" (spec 3.6). */
  const never = posted != null && filled != null ? posted - filled : null;

  const record = (
    <div className="bento">
      {/* DID MY JOBS FILL — jobs, never spots. Two 5-spot jobs are two decisions, not ten. */}
      {posted == null || filled == null ? (
        <Cell label="Did my jobs fill" sub={<span className="c-prose">Couldn&apos;t count just now.</span>} />
      ) : posted === 0 ? (
        <Cell label="Did my jobs fill"
          sub={<span className="c-prose">No jobs in the last {WINDOW_DAYS} days.</span>} />
      ) : posted < SMALL_N ? (
        // Under the floor there is no arc: a 3-of-4 arc *is* the 75% claim, whatever the caption says.
        <Cell label="Did my jobs fill" sub={`${filled} of ${posted} filled`}
          sr={`${filled} of your last ${plural(posted, "job")} filled. Too few to put a percentage on.`}>
          <Pips n={filled} of={posted} />
        </Cell>
      ) : (
        <Cell label="Did my jobs fill" sub={`${filled} of your last ${posted}`}
          sr={`${filled} of your last ${posted} jobs filled.`}>
          <div className="flex items-center gap-2 min-w-0">
            <Donut part={filled} of={posted} />
            <span className="c-fig truncate">{Math.round((100 * filled) / posted)}%</span>
          </div>
        </Cell>
      )}

      {/* FIRST YES — the median, and the jobs it could say nothing about. No advice: quietly pulling every
          boss toward the middle is the worst thing this cell could do to them.

          The label is two words because a 1x1 cell's label budget is 18 characters and "How fast the first
          yes came" is 27 — it wrapped to three lines and shoved the figure out of the tile. The figure, the
          sentence under it and the spoken version all still say the whole thing. */}
      {posted == null || firstYes === undefined ? (
        <Cell label="First yes"
          sub={<span className="c-prose">Couldn&apos;t count just now.</span>} />
      ) : posted === 0 ? (
        <Cell label="First yes"
          sub={<span className="c-prose">No jobs in the last {WINDOW_DAYS} days.</span>} />
      ) : firstYes == null ? (
        <Cell label="First yes"
          sub={<span className="c-prose">Nobody has said yes to one yet.</span>} />
      ) : posted < SMALL_N ? (
        <Cell label="First yes" sub={howLong(firstYes)}
          sr={`${plural(posted, "job")} so far — too few to take a middle from. The first yes came in about ${howLong(firstYes)}.`}>
          <Pips n={filled ?? 0} of={posted} />
        </Cell>
      ) : (
        <Big n={howLong(firstYes).split(" ")[0]} unit={howLong(firstYes).split(" ")[1]}
          label="First yes"
          sub={never && never > 0 ? `${never} of ${posted} never filled` : `across your last ${posted} jobs`}
          sr={`Half your jobs got their first yes inside ${howLong(firstYes)}.${
            never && never > 0 ? ` ${never} of your last ${posted} never filled at all.` : ""}`} />
      )}
    </div>
  );

  // The statement threw. White, and it says so — it never degrades to a clear fortnight.
  if (!t.days || !t.totals) {
    return (
      <>
        <Header title="This fortnight" back="/boss" />
        <Page>
          <div className="bento">
            <Cell span={2} rows={2}>
              <div className="min-w-0">
                <div className="c-label">We couldn&apos;t check just now</div>
                <div className="c-sub">Nothing here is a statement about your jobs — we just couldn&apos;t
                  reach the numbers.</div>
              </div>
              {/* A plain anchor, not a Link: this has to ask the server again, and the client router would
                  be within its rights to hand back the very page that failed. */}
              <div className="cell-bar"><a href="/boss/week" className="cell-act">Retry</a></div>
            </Cell>
          </div>
          {record}
        </Page>
      </>
    );
  }

  const days = t.days;
  const totals = t.totals;
  const worst = totals.worstDay ? days.find((d) => d.day === totals.worstDay) ?? null : null;

  /**
   * The one orange, and the only condition that earns it: something is short on today or tomorrow.
   *
   * "Inside 24 hours" is read as those two columns rather than as an hour count, and that is deliberate.
   * Every row on this screen already *is* a whole day; working out a real 24-hour cutoff would mean
   * comparing each job's start against now in its own site's zone, in a page, on a pooler whose session
   * runs in GMT — which is the bug lib/siteClock.ts exists to route around and is not one to reintroduce
   * for a shade of orange. Tomorrow's late start is a few hours past the line; today's and tomorrow's
   * holes are the ones there is still somebody to ring about tonight, which is what the colour means.
   */
  const soon = days.slice(0, 2).some((d) => d.gap > 0);
  const covered = totals.gap === 0 && totals.withJobs > 0;

  // `level` is deliberately not passed any more: the strip draws the shortfall as height and prints the
  // figure under the bar, and its ink now says only which of three cases a column is (short / covered /
  // nothing booked). A level shipped to fourteen columns and read by nothing is a type telling a lie.
  const strip: StripDay[] = days.map((d) => ({
    day: d.day, short: d.short, when: d.when, isToday: d.isToday,
    gap: d.gap, jobs: d.jobs.length, sr: d.sr,
  }));
  // Opens on the day with the biggest hole in it — the reason this screen exists. Today when nothing is short.
  const initial = Math.max(0, days.findIndex((d) => d.day === totals.worstDay));

  return (
    <>
      <Header title="This fortnight" back="/boss" />
      <Page>
        <div className="bento">
          {/* No `sr` on this cell: `Cell` hides its whole body from a screen reader once `sr` is set, and
              the button in the foot goes with it. The label, figure and sentence are all real text, so
              they are the spoken version too — the same reason components/HeroCell.tsx passes none. */}
          <Cell span={2} rows={2} tone={covered ? "go" : soon ? "needs" : totals.gap > 0 ? "soft" : "white"}>
            <div className="min-w-0">
              <div className="c-label flex items-start gap-2">
                {soon && <CircleAlert size={24} strokeWidth={2.5} aria-hidden className="shrink-0" />}
                <span className="min-w-0">
                  {covered ? "Every day is covered" : totals.gap > 0 ? "Still to fill" : "Nothing booked"}
                </span>
              </div>
              <div className="c-fig-2 mt-1 flex items-baseline gap-1 min-w-0">
                <span className="truncate">{totals.gap > 0 ? totals.gap : totals.withJobs}</span>
                <span className="c-unit shrink-0">
                  {totals.gap > 0 ? (totals.gap === 1 ? "spot" : "spots") : totals.withJobs === 1 ? "day booked" : "days booked"}
                </span>
              </div>
              <div className="c-sub line-clamp-3">{totals.sentence}</div>
            </div>
            {worst && (
              <div className="cell-bar">
                <Link href={postHref(worst)} className="cell-act">Fill {worst.when}</Link>
              </div>
            )}
          </Cell>
        </div>

        {totals.withJobs === 0 ? (
          <Empty>
            <div className="text-ink font-extrabold text-xl mb-1">Nothing on this fortnight</div>
            <div className="mb-4">Post a job and the days fill in here.</div>
            <Link href="/boss/shifts/new" className="btn-primary">Post a job</Link>
          </Empty>
        ) : (
          <WeekStrip days={strip} worstGap={totals.worstGap} initial={initial}
            panels={days.map((d) => <DayPanel key={d.day} d={d} />)} />
        )}

        <Section title="Your record" hint={`Your last ${WINDOW_DAYS} days of posting. Nobody else sees these.`} />
        {record}

        {/* Said out loud, at the bottom. A screen that quietly drops a number it could not fetch is a
            screen that lies by omission. */}
        {t.couldNotCheck.length > 0 && (
          <p className="text-steel text-base">Couldn&apos;t check {t.couldNotCheck.join(", ")} just now.</p>
        )}
      </Page>
    </>
  );
}
