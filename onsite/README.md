# OnSite — MVP

Construction shift marketplace for Australian subbies and casual workers. Boss drops a site pin, posts a shift in four taps; matching notifies only the workers who are close, free, ticketed and not blocked; worker takes it, clocks in/out on site; boss approves hours; both hold the same record; boss pays outside the app and marks it paid.

Stack: Next.js 16 (App Router, server actions, Turbopack), Postgres + PostGIS (Neon), MapLibre 6 + OpenStreetMap, phone-OTP auth (Twilio, stubbed in dev), web push alerts. Installable PWA — one codebase, boss and worker roles.

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
npm run lint      # ESLint CLI (Next 16 dropped `next lint`)
npm run test:watch
```

- `tests/integration/otp.test.ts` — login codes under attack: 40 parallel guesses spend exactly 5, a new code doesn't reset the count, 10 parallel sends send one, a code signs in once, foreign numbers refused.
- `tests/integration/alerts.test.ts` — alerts end to end against a local stand-in push service that decrypts what it receives: encrypted + VAPID-signed push, SMS fallback, urgent shifts pushed and texted, dead phones forgotten, 30-minute expiry, no double sends.
- `tests/integration/privacy.test.ts` — a boss sees a worker's phone, never their visa type or card numbers (plus a source guard for boss screens).
- `tests/unit/whitecard.test.ts` + `tests/unit/verify.test.ts` — the SafeWork NSW register against a stubbed API: token cached, renewed and shared, a failed login never poisoning the cache, 401 retried exactly once, every failure shape (400 included) ending as "couldn't check", a traffic card never passing as a White Card, no stranger's name in any answer, and the register's address fields never leaving the parser.
- `tests/integration/licences.test.ts` — the save-a-card action against a real DB: ten an hour per worker, a burst that can't slip past it, and a refused save that never reaches the register.
- `tests/integration/recheck.test.ts` — the White Card re-check queue against a real DB and a stubbed register: only a check that couldn't complete is queued, the backoff to the last try, a budget refusal that costs no attempt and makes no call, an edit mid-check that throws the stale answer away, two runs never taking the same card, the cron's counts-only summary, and seeded demo cards that claim no check.
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
app/api/cron/expand  hit every 4 min → widens matching on stale open shifts, re-checks queued White Cards, sends any unsent alert
lib/alerts.ts        notifications → web push (+ SMS for shift offers); public/sw.js shows them
lib/otp.ts           login code rules: crypto codes, hashed at rest, 5 wrong guesses an hour
lib/bossQueries.ts   what a boss may see about a worker (never visa type or card numbers)
lib/verify.ts        licence words, states and dates — client-safe, no credentials
lib/licenceCheck.ts  runs the check and maps it to a status; only 'verified' when one ran and matched
lib/licenceRecheck.ts  asks the register again about cards it couldn't answer for (cron, backoff, compare-and-set)
lib/whitecard.ts     SafeWork NSW White Card register over HTTP (address fields dropped at the parser)
```

## Deploy (Render + Neon)

1. Push to GitHub. In Render: New → Blueprint → this repo (`render.yaml` sets up the web service + the matching cron).
2. Paste the Neon **pooled** connection string into `DATABASE_URL`. Set `NEXT_PUBLIC_BASE_URL` and the cron's `APP_URL` to your real Render URL.
3. Run once from your machine against prod: `DATABASE_URL=… npm run db:migrate` (and `db:seed` if you want demo data in prod — you probably don't).
4. Add Twilio keys to send real SMS codes. Until then `DEV_SHOW_OTP=1` shows codes on screen — never leave that on in production.

## Phone alerts

Every notification row is an outbox. After the tap that wrote it, `lib/alerts.ts` pushes it to each phone the person turned alerts on for (Me → Phone alerts, or the nudge on the home screen), and texts **shift offers** when no push landed or the shift starts within 3 hours. Anything unsent after 30 minutes is dropped — a stale "shift near you" is worse than none. The 4-minute cron is the backup sender, and a send that dies mid-way is retried after 2 minutes. Texts never carry words a boss typed (fixed wording plus the shift's date and time), each person gets at most 5 a day, one boss at most a fifth of `SMS_ALERTS_PER_HOUR` (default 500) so nobody can drain the budget and silence everyone else, and a boss can post at most 40 shifts an hour. A text is stamped the moment it lands, so a retry never buys a second one; a text the provider refused is retried, and any budget it charged is handed back so a refusal never eats someone's allowance. With no Twilio keys, `npm run dev` logs the message instead of sending it; a production build refuses to pretend — it logs that nothing was sent (never the message, which can be a login code) and the alert is retried until it expires. Signing out switches that phone's alerts off (the subscription is remembered in a cookie, so it works without JavaScript). Push needs `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`; only real push services (Google, Apple, Mozilla, Microsoft) are accepted as endpoints. On iPhone, alerts work once OnSite is added to the Home Screen (iOS 16.4+).

## Maps

MapLibre 6 runs its tile worker from separate files that bundlers can't locate, so `scripts/copy-maplibre-worker.mjs` copies them from `node_modules` to `public/maplibre/<version>/` on install, dev and build (git-ignored), and `components/MapPicker.tsx` points MapLibre at them.

## Login codes

Codes come from the crypto RNG and only an HMAC is stored. Five wrong guesses per number per hour — counted in the same statement that checks them, and not reset by asking for a new code. One code a minute and five an hour per number (signing in doesn't reset that), ten an hour per connection (IPv6 counted per /64), and `OTP_SENDS_PER_HOUR` (default 1000) real sends across the app — refused requests don't count, so hammering one number can't lock everyone else out. Australian mobiles only. Known trade-off: anyone can spend a number's five guesses and lock it out of *new* sign-ins for up to an hour (existing sessions are unaffected).

## Licence checks (SafeWork NSW)

`lib/whitecard.ts` talks to the Service NSW **Holders of White Cards and Traffic Control Work Cards Register** (`api.onegov.nsw.gov.au`): Basic auth → bearer token (cached, renewed a minute early, concurrent callers share one login, dropped and retried once on a 401; a token that is inside the renew minute is kept in use if the login endpoint blips) → `GET /wcregister/v1/verify?licenceNumber=…`. `lib/licenceCheck.ts` turns the answer into a badge — Current, the right sort of card, and the name matches → **verified**; Suspended / Refused / Cancelled → **not on the register**, in the register's own word; expired by status or date → **expired**; a different name against that number → **name doesn't match**. That register also holds **Traffic Control Work Cards**, so the card type is checked too: a live White Card row says "General Construction Induction Training Card", and a number that turns out to be a traffic card is *not* a White Card. The register's `/browse` and `/details` endpoints are never called: searching by name hands back other people's cards.

A card is expired at the end of its expiry day **in Sydney** (`lib/util.ts` `TZ`), not on the server's clock — a UTC box would keep a dead card green through the whole Sydney morning.

Anyone signed in can type any number into that form, so the answer never says whose card it is: a name mismatch says only that the number is under a different name, and the register's name is carried back only when it is the name the worker gave. Saving a card is capped at **10 an hour per worker** (`LICENCE_SAVES_PER_HOUR`, the same atomic counter as the login codes); over that the save is refused before the register is asked anything.

**The quota.** API NSW's free tier is **2,500 calls a month**, no per-day figure is published, and there is no sandbox — every key hits production. So on top of the per-worker cap the whole app spends at most `WHITECARD_CHECKS_PER_DAY` register calls a day (default **70**, ≈2,100 a month, leaving headroom for re-checks and `npm run whitecard:ping`). It's charged in `lib/licenceCheck.ts` in the same atomic statement that checks it, immediately before the call goes out: a call that was made and then failed still counts (NSW counted it), a call we refused to make costs nothing. At the ceiling — and whenever the register throttles us, which is **429 or 503** (the sibling NSW gateway answers a spent quota with a 503) — the answer is *couldn't check*, never *not on the register*, and it is never retried on the spot: the card stays unchecked and goes on the re-check queue below.

**Only NSW White Cards are checked automatically.** That register doesn't hold high risk work licences (LF / WP / DG / SB), and no other state has an API, so everything else stays a human check and shows as "on file, not checked". A call that didn't come back — network, timeout, 5xx, 429, a body we can't read, a 401 twice — is *couldn't check*, never *not on the register*: the card stays unchecked and goes on the re-check queue.

**Re-checks.** A NSW White Card whose check couldn't complete — the register or its token service down, a timeout, a 4xx/5xx, 429/503, or the day's budget spent — is not left unchecked for ever. `checkLicence` says so explicitly (`retryable: "failed" | "cap_refused"`, never read off the note's wording) and `saveLicence` queues the card (`licences.recheck_at`, migration 007); any other save — a real answer, another state, a high risk work licence — takes it off the queue. The 4-minute cron runs `recheckLicences()` (`lib/licenceRecheck.ts`) before it delivers alerts, at most **5 cards a run**:

| | wait before the next try |
|---|---|
| save that couldn't check | 5 min |
| re-check 1 fails | 15 min |
| re-check 2 fails | 1 h |
| re-check 3 fails | 3 h |
| re-check 4 fails | 6 h |
| re-check 5 fails | 12 h |
| re-check 6 fails | 24 h |
| re-check 7 fails | off the queue: stays *unchecked* with the by-hand note, and joins the control room's "cards to check by hand" |

A re-check the **daily budget** turns away asked nothing, so it costs no attempt: the card waits until the budget window rolls over (at least 15 min), and the rest of that run's cards wait with it without asking again. A real answer is written exactly as a save would write it (the worker's own name stays on the card), `workers.tickets` is recomputed, and the worker gets one push — never a text — saying "Your White Card checked out with SafeWork NSW." or the same plain sentence a save would have shown (never the register's name for the card). Cards are claimed with `FOR UPDATE SKIP LOCKED` and a 10-minute lease, so two runs never ask about the same card and a run that dies doesn't hot-loop; every write-back is a compare-and-set on the card as claimed, so an answer about a card the worker has since edited or removed is dropped. The cron's JSON carries `licences: { claimed, verified, not_found, expired, mismatch, retrying, gave_up, cap_deferred }` — counts only. Demo cards from `npm run db:seed` are all *unchecked* and never queued: no quota is spent on made-up numbers.

The register sends each holder's home address, suburb, postcode, vehicle registration and business names with every record. They are dropped at the parser in `lib/whitecard.ts` and carried no further — not into the database, not into a log, not onto a screen. Nothing in that file logs at all: URLs there carry card numbers.

Credentials go in `.env` as `WHITE_CARD_API_KEY`, `WHITE_CARD_API_SECRET`, and the optional `WHITE_CARD_AUTH_HEADER` (the ready-made `Basic …` value the portal shows; sent as pasted, otherwise derived from key:secret). `npm run whitecard:ping` proves them against the live register in at most three calls — it tries both auth variants and says which one was accepted, masking everything sensitive. It is uncapped (run by hand, a few calls at a time) but it spends 2–3 of the month's 2,500, so never loop it.

## Payments (QPay)

`lib/qpay.ts` talks to the QPay merchant API v2 (token → invoice → payment check); `lib/billing.ts` stores invoices in `qpay_invoices` (migration 004); QPay calls `/api/qpay/callback/<invoice>/<hmac>`, which marks an invoice paid **only after QPay's own `/payment/check` confirms it** — at most one check per invoice per 10 s. A lost callback is caught by the 4-minute cron, which re-checks open invoices on a widening gap for 24 h. Amounts are whole MNT — nothing converts AUD. Credentials go in `.env` as `QPAY_USERNAME`, `QPAY_PASSWORD`, `QPAY_INVOICE_CODE`; `npm run qpay:ping` proves they work without raising an invoice. Nothing in the UI charges anyone yet — what to charge, and when, is still a product decision.

## Rules baked in (the "formal and correct" bits)

- Every shift is **casual employment** with the boss who posts it. Rate can't go under the Building and Construction General On-site Award casual floor (**$35.55/h**, incl. 25% loading). Super **12%** is shown separately.
- **White Card always required.** HRW licence classes LF / WP / DG / SB as chips. NSW White Cards are checked against the SafeWork register as they're saved; everything else is confirmed by hand.
- Award pay mode: 8 ordinary hours, then ×1.5 for 2h, ×2 after. Flat mode: hours × rate. CSV export per week.
- Clock-in works anywhere; the record shows distance from site and time. Boss can edit hours before approving; the worker sees the edit, both numbers stay, and there's an *I disagree* button that tells the boss to call. No locking, no auto-penalties.
- Matching notifies **3× the open spots**, ranked by show-up rate → worked-for-this-boss → distance, and widens every 20 minutes. A 2-person shift wakes up 6 phones.
- Visa type is display-only. No ABN anywhere.

## Not in the MVP (on purpose)

Ticket verification uploads, chat, ratings text, payroll/STP, admin dashboard, translations. All later.
