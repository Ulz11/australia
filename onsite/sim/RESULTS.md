# Marketplace simulation — results

`python3 sim/marketplace.py` · 8 simulated weeks · 40 subbies, 220 casual workers in Inner-West Sydney,
5 new workers joining a week · averaged over 5 seeds. Bosses post the way subbies post (mostly 5–9pm the
evening before; some at dawn when someone hasn't turned up); workers see their phone the way people do
(minutes in the evening, at smoko on site, at the alarm when asleep).

## Does the engine fill shifts?

Yes. **95% of shifts fill, median 24 minutes after posting, and every evening post is filled by 6am.**
Batch size (2×–8×) and round timing (10–40 min) barely move that — the mechanism is robust. Dawn
emergencies are the weak spot (~67–75%) because the phones it needs to wake are asleep.

## What it cost

About **5–6 notifications per filled spot** and **7–9 per worker per week** — roughly one a day. That is
the "no unnecessary ads" goal holding. A 2× batch saves one notification per spot but starves more
workers; 3× is the right trade.

## What was wrong, and what changed

| | as built | after |
|---|---|---|
| New workers with **no** notification in their first fortnight | **73%** | **27%** |
| Workers never asked at all | 32% | 5% |
| Share of all work taken by the top 10% of workers | 52% | 38% |
| Fill rate | 94.9% | 95.8% |
| No-show rate | 6.9% | 6.4% |
| Dawn-post fill | 68% | 74% |

Two engine changes, both now in `lib/matching.ts` with tests:

1. **One seat per round for someone new.** Ranking by reliability with new workers last (`NULLS LAST`)
   meant they never got a first shift, so they'd leave — and the supply the marketplace depends on would
   leave with them. Now a worker with no history ranks mid-pack, and every multi-spot batch holds one seat
   for someone with fewer than three shifts. No cost in fill rate or no-shows.
2. **Urgency.** A shift starting within three hours asks three times as many workers and widens every
   5 minutes instead of 20.

## What the engine can't fix

- **Dawn.** The remaining gap is people being asleep. For urgent shifts send an SMS, not just a push.
- **Supply ratio.** At 2 workers per boss nobody is starved and nobody is spammed. At 10 per boss a third
  of workers never get asked no matter how the engine ranks — there isn't enough work. Recruit bosses
  before workers; 3–6 workers per boss is the healthy band.
- **No-shows** sit at ~6% regardless; reliability data accrues too slowly over 8 weeks to change it.
  Expect it to fall over months, not weeks.
