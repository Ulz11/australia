"""
OnSite marketplace simulation.

Question: does the matching engine actually fill shifts for real people, at what cost in
notifications, and who does it leave behind?

This runs the engine's real rules (lib/matching.ts) against agents that behave like
Inner-West Sydney subbies and casual workers:

  Gates   distance <= worker radius; worker marked that day free; tickets subset;
          not blocked; not already asked.
  Rank    reliability score DESC (new workers last), worked-for-this-boss-before DESC,
          distance ASC.
  Batch   3 x open spots per round; next round 20 min later if spots remain.

Time is simulated in 5-minute ticks over 8 weeks. Run:  python3 sim/marketplace.py
Change RANKING / BATCH / ROUND at the bottom to test alternatives.
"""
from __future__ import annotations
import math, random, statistics, heapq
from dataclasses import dataclass, field

TICK = 5                      # minutes
DAYS = 56
MIN_PER_DAY = 1440

# ───────────────────────────────────────────── the world (Inner West Sydney)
def km(a, b):
    """Rough planar distance in km at Sydney's latitude."""
    return math.hypot((a[0] - b[0]) * 111.0, (a[1] - b[1]) * 92.5)

@dataclass
class Worker:
    id: int
    home: tuple
    radius: float
    tickets: set
    reliability: float           # true P(turns up | accepted)
    keen: float                  # base P(accept | sees it)
    joined_day: int
    free_prob: float             # P(marks a given day free)
    # history the engine can see
    past: int = 0
    showed: int = 0
    cancels: int = 0
    worked_for: set = field(default_factory=set)
    free: set = field(default_factory=set)
    booked: dict = field(default_factory=dict)    # day -> shift id
    notified_total: int = 0
    notified_first_day: int | None = None

    @property
    def score(self):             # exactly what worker_stats + the ORDER BY see
        return None if self.past == 0 else round(100 * self.showed / self.past)

@dataclass
class Boss:
    id: int
    site: tuple
    posts_per_week: float
    rate: float
    ticket_share: float          # P(a shift needs a licence beyond White Card)

@dataclass
class Shift:
    id: int
    boss: Boss
    day: int
    start_min: int               # minutes from midnight
    spots: int
    tickets: set
    rate: float
    posted_at: int               # absolute minute
    notified: set = field(default_factory=set)
    accepted: list = field(default_factory=list)
    rounds: int = 0
    last_round_at: int = -10**9
    filled_at: int | None = None
    outcome: str = "open"        # open | filled | partial | unfilled
    showed_up: int = 0
    no_shows: int = 0

# ───────────────────────────────────────────── agent behaviour
def phone_delay(minute_of_day: int) -> int:
    """Minutes until a worker actually sees a notification, by time of day."""
    h = minute_of_day / 60
    if 22 <= h or h < 5.5:                        # asleep: sees it when the alarm goes
        wake = 5.75 * 60 + random.uniform(0, 45)
        return int((wake - minute_of_day) % MIN_PER_DAY)
    if 6.5 <= h < 15.5:                          # on the tools: smoko/lunch
        return int(random.choice([10, 30, 60, 90, 120, 150]))
    return int(random.expovariate(1 / 8))        # evening / early: phone in hand

def accept_prob(w: Worker, s: Shift, dist: float) -> float:
    p = w.keen
    if s.boss.id in w.worked_for: p += 0.15       # knows the boss
    if dist > 20: p -= 0.15
    p += min(0.20, (s.rate - 35.55) * 0.03)       # a better rate pulls
    if s.day in w.booked: return 0.0              # already working that day
    return max(0.0, min(0.95, p))

def make_world(n_workers=220, n_bosses=40, seed=1):
    random.seed(seed)
    centre = (-33.905, 151.16)
    workers = []
    for i in range(n_workers):
        home = (centre[0] + random.gauss(0, 0.045), centre[1] + random.gauss(0, 0.055))
        tickets = {"WC"}
        for t, share in (("LF", .25), ("WP", .10), ("DG", .08), ("SB", .12)):
            if random.random() < share: tickets.add(t)
        rel = min(0.995, max(0.55, random.betavariate(9, 1)))       # mean ~0.9, a few flaky
        keen = random.uniform(0.25, 0.65)
        workers.append(Worker(i, home, random.choice([15, 20, 25, 25, 30, 40]), tickets, rel, keen, 0, random.uniform(0.35, 0.8)))
    bosses = []
    for i in range(n_bosses):
        site = (centre[0] + random.gauss(0, 0.035), centre[1] + random.gauss(0, 0.045))
        bosses.append(Boss(i, site, random.choice([1, 2, 3, 3, 4, 6]), random.choice([35.55, 36, 36, 38, 40, 42]), 0.25))
    return workers, bosses

# ───────────────────────────────────────────── the engine (mirrors lib/matching.ts)
def candidates(s: Shift, workers, ranking: str):
    pool = []
    for w in workers:
        if w.joined_day > s.day: continue
        d = km(w.home, s.boss.site)
        if d > w.radius: continue                              # 1 distance
        if s.day not in w.free: continue                       # 2 free that day
        if not s.tickets <= w.tickets: continue                # 3 tickets
        if w.id in s.notified: continue                        # 5 not already asked
        if any(w.id == a for a in s.accepted): continue
        pool.append((w, d))
    if ranking == "current":
        # ORDER BY score DESC NULLS LAST, worked_before DESC, dist ASC
        pool.sort(key=lambda x: (-(x[0].score if x[0].score is not None else -1), -(s.boss.id in x[0].worked_for), x[1]))
    elif ranking == "explore":
        # same, but new workers (no history) get a fair prior instead of the bottom
        pool.sort(key=lambda x: (-(x[0].score if x[0].score is not None else 85), -(s.boss.id in x[0].worked_for), x[1]))
    elif ranking == "explore+slot":
        pool.sort(key=lambda x: (-(x[0].score if x[0].score is not None else 85), -(s.boss.id in x[0].worked_for), x[1]))
        # guarantee one seat per round for someone with < 3 shifts, if any exist
        newbies = [p for p in pool if p[0].past < 3]
        if newbies and newbies[0] not in pool[:3]:
            pool.remove(newbies[0]); pool.insert(min(2, len(pool)), newbies[0])
    return pool

URGENT_MIN = 180              # a shift starting within 3 hours is urgent

def urgent(s: Shift, now: int) -> bool:
    return (s.day * MIN_PER_DAY + s.start_min) - now <= URGENT_MIN

def run_round(s: Shift, workers, now: int, batch_mult: int, ranking: str, log, urgency=False):
    remaining = s.spots - len(s.accepted)
    if remaining <= 0: return
    pool = candidates(s, workers, ranking)
    mult = batch_mult * (3 if urgency and urgent(s, now) else 1)
    for w, d in pool[: remaining * mult]:
        s.notified.add(w.id)
        w.notified_total += 1
        if w.notified_first_day is None: w.notified_first_day = now // MIN_PER_DAY
        seen_at = now + phone_delay(now % MIN_PER_DAY)
        heapq.heappush(log, (seen_at, w.id * 100000 + s.id, w.id, s.id, d))
    s.rounds += 1
    s.last_round_at = now

# ───────────────────────────────────────────── simulation loop
def simulate(batch_mult=3, round_min=20, ranking="current", seed=1, n_workers=220, n_bosses=40, verbose=False, urgency=False):
    workers, bosses = make_world(n_workers, n_bosses, seed)
    shifts: list[Shift] = []
    open_shifts: list[Shift] = []
    events: list[tuple] = []          # heap of (at, seq, worker, shift, dist)
    seq = 0
    stats = dict(notif=0, accepts=0, spots=0, filled_spots=0, no_shows=0, cancels=0)
    next_id = 0
    join_pool = 0

    # workers mark availability a week ahead, refreshed daily
    def mark_free(w, day0):
        for d in range(day0, day0 + 8):
            if d not in w.free and d not in w.booked and random.random() < w.free_prob:
                w.free.add(d)

    for w in workers: mark_free(w, 0)

    for now in range(0, DAYS * MIN_PER_DAY, TICK):
        day, mod = divmod(now, MIN_PER_DAY)

        if mod == 0:
            for w in workers: mark_free(w, day)
            # a few new workers join each week
            join_pool += 5 / 7
            while join_pool >= 1:
                join_pool -= 1
                nw = make_world(1, 0, seed + 1000 + day + len(workers))[0][0]
                nw.id = len(workers); nw.joined_day = day
                mark_free(nw, day); workers.append(nw)

        # bosses post: mostly the evening before, some days ahead, some at dawn
        for b in bosses:
            if random.random() < b.posts_per_week / 7 / (MIN_PER_DAY / TICK) * 3:   # spread across the day, weighted below
                h = mod / 60
                if 17 <= h < 21: lead = 1
                elif 5 <= h < 7: lead = 0
                elif 9 <= h < 16: lead = random.choice([1, 2, 3])
                else: continue
                sday = day + lead
                if sday >= DAYS: continue
                spots = random.choices([1, 2, 3], [.6, .3, .1])[0]
                tix = {"WC"} | ({random.choice(["LF", "WP", "DG", "SB"])} if random.random() < b.ticket_share else set())
                s = Shift(next_id, b, sday, 390, spots, tix, b.rate, now); next_id += 1
                shifts.append(s); open_shifts.append(s); stats["spots"] += spots
                run_round(s, workers, now, batch_mult, ranking, events, urgency)

        # widen the net on stale open shifts (the cron) — every 5 ticks is plenty
        if mod % 25 == 0:
            for s in open_shifts:
                gap = 5 if (urgency and urgent(s, now)) else round_min
                if len(s.accepted) < s.spots and now - s.last_round_at >= gap and now < s.day * MIN_PER_DAY + s.start_min:
                    run_round(s, workers, now, batch_mult, ranking, events, urgency)

        # workers see notifications and decide
        due = []
        while events and events[0][0] <= now:
            due.append(heapq.heappop(events))
        for _, _, wid, sid, d in due:
            w, s = workers[wid], shifts[sid]
            stats["notif"] += 1
            if s.outcome != "open" or len(s.accepted) >= s.spots: continue
            if random.random() < accept_prob(w, s, d):
                s.accepted.append(wid); w.booked[s.day] = sid; w.free.discard(s.day)
                w.worked_for.add(s.boss.id); stats["accepts"] += 1
                if len(s.accepted) >= s.spots:
                    s.outcome = "filled"; s.filled_at = now

        # shift starts: who turned up?
        started = [s for s in open_shifts if now >= s.day * MIN_PER_DAY + s.start_min]
        if started:
            open_shifts = [s for s in open_shifts if s not in started]
        for s in started:
            if s.outcome in ("open", "filled"):
                for wid in s.accepted:
                    w = workers[wid]; w.past += 1
                    if random.random() < w.reliability:
                        w.showed += 1; s.showed_up += 1; stats["filled_spots"] += 1
                    else:
                        s.no_shows += 1; stats["no_shows"] += 1
                if s.outcome == "open":
                    s.outcome = "partial" if s.accepted else "unfilled"

    # ─────────────────────────────────────────── measure against the goals
    done = [s for s in shifts if s.outcome != "open"]
    filled = [s for s in done if s.outcome == "filled"]
    ttf = [(s.filled_at - s.posted_at) / 60 for s in filled]
    evening = [s for s in filled if 17 <= (s.posted_at % MIN_PER_DAY) / 60 < 21]
    dawn = [s for s in done if 5 <= (s.posted_at % MIN_PER_DAY) / 60 < 7]
    late_joiners = [w for w in workers if w.joined_day >= 7]
    starved = [w for w in late_joiners if w.notified_first_day is None or w.notified_first_day - w.joined_day > 14]
    active = [w for w in workers if w.notified_total > 0]
    return dict(
        shifts=len(done), spots=stats["spots"],
        fill_rate=len(filled) / max(1, len(done)),
        spot_fill=sum(len(s.accepted) for s in done) / max(1, stats["spots"]),
        turned_up=stats["filled_spots"] / max(1, stats["spots"]),
        ttf_median_h=statistics.median(ttf) if ttf else None,
        ttf_p90_h=sorted(ttf)[int(len(ttf) * .9)] if ttf else None,
        evening_fill_by_6am=sum(1 for s in evening if s.filled_at - s.posted_at < 12 * 60) / max(1, len(evening)),
        dawn_fill=sum(1 for s in dawn if s.outcome == "filled") / max(1, len(dawn)),
        notif_per_filled_spot=stats["notif"] / max(1, sum(len(s.accepted) for s in done)),
        notif_per_worker_per_week=stats["notif"] / max(1, len(active)) / (DAYS / 7),
        rounds_avg=statistics.mean(s.rounds for s in done) if done else 0,
        no_show_rate=stats["no_shows"] / max(1, sum(len(s.accepted) for s in done)),
        new_worker_starved=len(starved) / max(1, len(late_joiners)),
        workers_never_asked=sum(1 for w in workers if w.notified_total == 0 and w.joined_day < DAYS - 14) / len(workers),
        top10_share=(lambda xs: sum(sorted(xs, reverse=True)[: max(1, len(xs) // 10)]) / max(1, sum(xs)))([sum(1 for s in done for a in s.accepted if a == w.id) for w in workers]),
    )

def fmt(r):
    return (f"  fill {r['fill_rate']*100:5.1f}%  spots {r['spot_fill']*100:5.1f}%  turned-up {r['turned_up']*100:5.1f}%  "
            f"| median fill {r['ttf_median_h']:.1f}h  p90 {r['ttf_p90_h']:.1f}h  | evening→6am {r['evening_fill_by_6am']*100:4.0f}%  dawn {r['dawn_fill']*100:4.0f}%\n"
            f"  notifs/spot {r['notif_per_filled_spot']:.1f}  per-worker/wk {r['notif_per_worker_per_week']:.1f}  rounds {r['rounds_avg']:.1f}  "
            f"| no-show {r['no_show_rate']*100:.1f}%  | new workers starved {r['new_worker_starved']*100:.0f}%  never asked {r['workers_never_asked']*100:.0f}%  top-10% take {r['top10_share']*100:.0f}% of work")

if __name__ == "__main__":
    import sys
    seeds = [1, 2, 3]
    def avg(runs):
        keys = [k for k in runs[0] if isinstance(runs[0][k], (int, float)) and runs[0][k] is not None]
        return {k: statistics.mean(r[k] for r in runs) for k in keys}

    print("=" * 100)
    print("AS BUILT — 3x spots, 20-min rounds, rank by reliability (new workers last)")
    print(fmt(avg([simulate(3, 20, "current", s) for s in seeds])))

    print("\n" + "=" * 100 + "\nBATCH SIZE (rank as built)")
    for m in (2, 3, 5, 8):
        print(f"{m}x spots"); print(fmt(avg([simulate(m, 20, "current", s) for s in seeds])))

    print("\n" + "=" * 100 + "\nROUND TIMING (3x, rank as built)")
    for rm in (10, 20, 40):
        print(f"{rm} min"); print(fmt(avg([simulate(3, rm, "current", s) for s in seeds])))

    print("\n" + "=" * 100 + "\nRANKING")
    for rk in ("current", "explore", "explore+slot"):
        print(rk); print(fmt(avg([simulate(3, 20, rk, s) for s in seeds])))

    print("\n" + "=" * 100 + "\nURGENCY — 3x normally, 9x + 5-min rounds when the shift starts within 3h (explore+slot)")
    for u in (False, True):
        print("urgency-aware" if u else "flat"); print(fmt(avg([simulate(3, 20, "explore+slot", s, urgency=u) for s in seeds])))

    print("\n" + "=" * 100 + "\nSUPPLY — workers per boss (3x, 20 min, explore+slot)")
    for nw in (80, 150, 220, 400):
        print(f"{nw} workers / 40 bosses = {nw/40:.1f} : 1"); print(fmt(avg([simulate(3, 20, "explore+slot", s, n_workers=nw) for s in seeds])))
