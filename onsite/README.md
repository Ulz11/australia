# OnSite — MVP

Construction shift marketplace for Australian subbies and casual workers. Boss drops a site pin, posts a shift in four taps; matching notifies only the workers who are close, free, ticketed and not blocked; worker takes it, clocks in/out on site; boss approves hours; both hold the same record; boss pays outside the app and marks it paid.

Stack: Next.js 15 (App Router, server actions), Postgres + PostGIS (Neon), MapLibre + OpenStreetMap, phone-OTP auth (Twilio, stubbed in dev). Installable PWA — one codebase, boss and worker roles.

## Run it locally

```bash
cp .env.example .env        # fill DATABASE_URL (Neon, with sslmode=require) and SESSION_SECRET
npm install
npm run db:migrate          # applies db/schema.sql (idempotent)
npm run db:seed             # Inner West Sydney demo data (safe to re-run; only touches +6140000… phones)
npm run dev                 # http://localhost:3000
```

Sign in with a seeded phone. With `DEV_SHOW_OTP=1` and no Twilio keys, the code is shown on the login screen.

| Role   | Phone         | Who |
|--------|---------------|-----|
| Boss   | 0400 000 001  | Dave Carter, Marrickville Formwork — 3 sites, 6 crew, 3 weeks of pay history |
| Worker | 0400 000 101  | Batbayar — Marrickville, White Card + forklift, 1 shift waiting on his calendar |
| Boss   | 0400 000 002–005 | Tony, Mick, Sam, Priya — own the other sites on the map |
| Worker | 0400 000 102–118 | 17 more workers (Nepali, Brazilian, Italian, Mongolian, local…) |

Open two browsers (or one normal + one private window) and walk the loop: **Boss** → Projects → *Need workers* → *Find workers*; **Worker** → orange dot on the calendar → tap → *Take it* → Shift tab → *Clock in* / *Clock out*; **Boss** → shift → edit hours → *Approve*; → Workers (Batbayar is now in Casual); → Pay → *Mark paid*; **Worker** → Me → *Owed to me* flips to Paid.

## Control room — the whole project on one screen

`http://localhost:3000/console` (needs `DEMO_CONSOLE=1` in `.env`, which the dev `.env` has).

Both phones side by side on the same live database — pick any seeded boss on the left and any seeded worker
on the right, post a shift, take it, watch the other phone update by itself. Between them, a live feed of
what just happened. Below: the three revenue scenarios with every assumption on a slider, what the
marketplace simulation found, and the project's vitals (environment, database counts, test coverage,
every screen).

How the two phones can be two people on one origin: each frame gets its own session cookie scoped to its
own path (`/boss` or `/worker`). The endpoint that issues them, `/api/console/login`, only exists when
`DEMO_CONSOLE=1` and only accepts seeded demo phones. **Never set `DEMO_CONSOLE=1` in production.**

## Why it's fast

Every screen is **one database round-trip** and every tap is **one statement**:

- The signed cookie carries the user (id, role, name) — reading "who is this" costs no query.
- A page fires all its queries together (`Promise.all`); they pipeline on one connection.
- Actions are single CTE statements (`takeShift`, `approveHours`, `clockOut`, `markPaid`…), not chains of awaits.
- The pool never idle-closes (a fresh TLS handshake to Neon is ~2 s); it's warmed at boot.
- Frequent taps (Free/Busy, Clock in/out, Mark paid) flip on screen instantly and sync behind.
- The map library (300 kB) loads only on screens that show a map.
- The cron ping every 4 min also keeps the free-tier Neon compute awake.

Feel it in production mode (`npm run build && npm start`) — `next dev` compiles pages on first visit and is not representative.

## Simulation

`sim/marketplace.py` runs the matching engine's real rules against 40 subbies and 220 workers behaving like
people for 8 weeks — see `sim/RESULTS.md`. It found that ranking new workers last starved 73% of them of a
first shift; the engine now holds a seat per batch for someone new and goes into urgent mode within three
hours of a start. Re-run it whenever you touch `lib/matching.ts`.

## Tests (TDD from here on)

```bash
npm test          # unit (fast, no DB) + integration (skips itself without DATABASE_URL)
npm run test:watch
```

- `tests/unit/` — the business rules, each written red → green: Award floor (`clampRate`), ticket normalisation (White Card always), batch size (3× open spots), clock-in labels (300 m / 15 min, a label not a gate), pay maths (OT split, rounding, negative hours), phone normalisation, date helpers.
- `tests/integration/bugs.test.ts` — one regression per bug from the strict review (ticket wipe, White Card drop, double-booking race, removed-worker rejoin, cancel leaving bookings, counter-offer flow, overtime maths in notifications, OTP throttle, garbage input…).
- `tests/integration/loop.test.ts` — the whole core loop through the **real server actions** against the seeded DB: post → match → take → clock in/out → approve (edited) → crew auto-add → disagree → paid → same-again → cancel → rematch. Self-cleaning, ~30 s.
- Rules live in `lib/rules.ts` and `lib/award.ts`; actions call them. New behaviour: write the test in `tests/unit` first, watch it fail, then implement.

## What's where

```
db/schema.sql        tables + PostGIS indexes + worker_stats / boss_stats views
db/seed.ts           demo data
tests/               unit + integration (Vitest)
lib/rules.ts         business rules: rate floor, tickets, batch size, clock-in labels
lib/matching.ts      the five gates + ranking + 3×spots batching + 20-min expansion
lib/award.ts         MA000020 casual floor, OT rules, super — update on 1 July each year
lib/session.ts       JWT cookie session; requireRole()
actions/boss.ts      post shift, approve hours, crew, pay, same-again, block…
actions/worker.ts    availability, take shift, clock in/out, disagree, profile
app/boss/*           Projects · Post shift · Live shift · Workers · Pay · Me
app/worker/*         Calendar · Explore (map/list) · Shift · Me (owed, invite)
app/api/cron/expand  hit every 5 min → widens matching on stale open shifts
```

## Deploy (Render + Neon)

1. Push to GitHub. In Render: New → Blueprint → this repo (`render.yaml` sets up the web service + the matching cron).
2. Paste the Neon **pooled** connection string into `DATABASE_URL`. Set `NEXT_PUBLIC_BASE_URL` and the cron's `APP_URL` to your real Render URL.
3. Run once from your machine against prod: `DATABASE_URL=… npm run db:migrate` (and `db:seed` if you want demo data in prod — you probably don't).
4. Add Twilio keys to send real SMS codes. Until then `DEV_SHOW_OTP=1` shows codes on screen — never leave that on in production.

## Rules baked in (the "formal and correct" bits)

- Every shift is **casual employment** with the boss who posts it. Rate can't go under the Building and Construction General On-site Award casual floor (**$35.55/h**, incl. 25% loading). Super **12%** is shown separately.
- **White Card always required.** HRW licence classes LF / WP / DG / SB as chips.
- Award pay mode: 8 ordinary hours, then ×1.5 for 2h, ×2 after. Flat mode: hours × rate. CSV export per week.
- Clock-in works anywhere; the record shows distance from site and time. Boss can edit hours before approving; the worker sees the edit, both numbers stay, and there's an *I disagree* button that tells the boss to call. No locking, no auto-penalties.
- Matching notifies **3× the open spots**, ranked by show-up rate → worked-for-this-boss → distance, and widens every 20 minutes. A 2-person shift wakes up 6 phones.
- Visa type is display-only. No ABN anywhere.

## Not in the MVP (on purpose)

Push notifications (in-app + SMS stub only), ticket verification uploads, chat, ratings text, payroll/STP, admin dashboard, translations. All later.
