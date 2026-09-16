# OnSite — MVP

Construction shift marketplace for Australian subbies and casual workers. Boss drops a site pin, posts a shift in four taps; matching notifies only the workers who are close, free, ticketed and not blocked; worker takes it, clocks in/out on site; boss approves hours; both hold the same record; boss pays outside the app and marks it paid.

Stack: Next.js 16 (App Router, server actions, Turbopack), Postgres + PostGIS (Neon), MapLibre 6 + OpenStreetMap, phone-OTP auth (ClickSend SMS, stubbed in dev), web push alerts. Runs on Vercel in Sydney against Neon in Sydney. Installable PWA — one codebase, boss and worker roles.

## Run it locally

```bash
cp .env.example .env        # fill DATABASE_URL (Neon, with sslmode=require) and SESSION_SECRET
npm install
npm run db:migrate          # applies db/schema.sql (idempotent)
npm run db:seed             # Inner West Sydney demo data (safe to re-run; only touches +6140000… phones)
npm run dev                 # http://localhost:3000
```

Sign in with a seeded phone. With `DEV_SHOW_OTP=1` and no SMS provider keys, the code is shown on the login screen.

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
`DEMO_CONSOLE=1` and only accepts seeded demo phones. **Never set `DEMO_CONSOLE=1` in real production** — on a Vercel
production deployment (`VERCEL_ENV=production`) both demo switches, `DEMO_CONSOLE` and `DEV_SHOW_OTP`, are ignored
unless that deployment is also declared a demo with `DEMO_SITE=1` (`lib/flags.ts`, the only place either is read).

## Why it's fast

Every screen is **one database round-trip** and every tap is **one statement**:

- The signed cookie carries the user (id, role, name) — reading "who is this" costs no query.
- A page fires all its queries together (`Promise.all`); they pipeline on one connection.
- Actions are single CTE statements (`takeShift`, `approveHours`, `clockOut`, `markPaid`…), not chains of awaits.
- On a long-lived server the pool never idle-closes (a fresh TLS handshake to Neon is ~2 s) and is warmed at boot. On Vercel, whose Fluid compute suspends idle instances, idle connections close after 15 s and none lives past 5 min, and nothing connects at import (`lib/db.ts`).
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

- `tests/integration/beta.test.ts` — the closed beta against a real DB: with `BETA_INVITE_ONLY=1` a number that is neither invited nor an account is refused in one sentence with no text, no code row and no app-wide or per-number budget spent, while the connection *is* charged (so the guest list can't be probed for free); invited numbers and existing accounts still get codes; the mobile API answers 403 with the same sentence; the first sign-in stamps the invite once; the `beta:invite` helpers.
- `tests/integration/consent.test.ts` — onboarding refuses without the privacy box (server-side, whatever the form sends), stamps `privacy_accepted_at` / `privacy_version` when it's ticked, and seeded demo users count as having agreed.
- `tests/unit/sms.test.ts` — ClickSend against a stubbed API: the documented request (Basic auth, `messages[]`, no `from` unless `CLICKSEND_FROM`), success only on HTTP 200 *and* the message's own `SUCCESS`, `INSUFFICIENT_CREDIT` / `INVALID_RECIPIENT` / HTTP errors / network failure / the 8 s timeout all `sent: false`, provider choice, and no number, message or credential in any log line (Twilio too).
- `tests/unit/routeGuards.test.ts` — source guard: no proxy, and every page, layout and route under `/boss`, `/worker`, `/onboarding` turns signed-out visitors away itself; every boss/worker action checks the role first. `tests/unit/flags.test.ts` — demo switches forced off in Vercel production, and nothing else reads them. `tests/unit/launch.test.ts` — the Vercel pool settings, `vercel.json`, the privacy contact, `beta:invite` arguments.
- `tests/integration/otp.test.ts` — login codes under attack: 40 parallel guesses spend exactly 5, a new code doesn't reset the count, 10 parallel sends send one, a code signs in once, foreign numbers refused.
- `tests/integration/alerts.test.ts` — alerts end to end against a local stand-in push service that decrypts what it receives: encrypted + VAPID-signed push, SMS fallback, urgent shifts pushed and texted, dead phones forgotten, 30-minute expiry, no double sends.
- `tests/integration/privacy.test.ts` — a boss sees a worker's phone, never their visa type or card numbers (plus a source guard for boss screens).
- `tests/unit/whitecard.test.ts` + `tests/unit/verify.test.ts` — the SafeWork NSW register against a stubbed API: token cached, renewed and shared, a failed login never poisoning the cache, 401 retried exactly once, every failure shape (400 included) ending as "couldn't check", a traffic card never passing as a White Card, no stranger's name in any answer, and the register's address fields never leaving the parser.
- `tests/integration/licences.test.ts` — the save-a-card action against a real DB: ten an hour per worker, a burst that can't slip past it, and a refused save that never reaches the register, and the app-wide 15-minute register pause after a failed call (a real row, lifted on time).
- `tests/integration/recheck.test.ts` — the White Card re-check queue against a real DB and a stubbed register: only a check that couldn't complete is queued, the backoff to the last try, a budget refusal that costs no attempt and makes no call, a register pause that asks nothing and burns no attempt (and a failure mid-run that defers the rest of the batch), an edit mid-check that throws the stale answer away, two runs never taking the same card, the cron's counts-only summary, and seeded demo cards that claim no check.
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
lib/sms.ts           one text via ClickSend (or Twilio); never logs the number or the message
lib/beta.ts          closed-beta guest list (BETA_INVITE_ONLY) — scripts/beta-invite.ts manages it
lib/flags.ts         DEMO_CONSOLE / DEV_SHOW_OTP, forced off on a Vercel production deployment unless DEMO_SITE=1
lib/privacy.ts       PRIVACY_VERSION and the /privacy contact (app/privacy/page.tsx)
lib/bossQueries.ts   what a boss may see about a worker (never visa type or card numbers)
lib/verify.ts        licence words, states and dates — client-safe, no credentials
lib/licenceCheck.ts  runs the check and maps it to a status; only 'verified' when one ran and matched
lib/licenceRecheck.ts  asks the register again about cards it couldn't answer for (cron, backoff, compare-and-set)
lib/whitecard.ts     SafeWork NSW White Card register over HTTP (address fields dropped at the parser)
```

## Deploy (Vercel + Neon, Sydney)

Live at **https://onsite-au.vercel.app** — Vercel project `onsite-beta`, root directory `onsite`, deployed automatically from `main`. **It is currently an open demo, not real production:** there is no text provider yet, so `DEMO_SITE=1` + `DEV_SHOW_OTP=1` show sign-in codes on screen and anyone can sign up (the login screen and `/privacy` say so, including that anyone who types a number can open that account). To go live with texts: set the ClickSend variables, remove `DEMO_SITE` and `DEV_SHOW_OTP`, and decide on `BETA_INVITE_ONLY`. Data stays in Australia: the database is Neon in **Sydney**, and `vercel.json` pins every function to **Sydney** (`"regions": ["syd1"]`). There is no proxy/middleware (Vercel would run it in every region): each signed-in page, route and action checks the session itself.

1. **Database.** A Neon project in AWS Sydney. The app uses the **pooled** connection string; migrations use the **direct** one.
2. **Migrations** run from your machine, not at build: `DATABASE_URL=<direct URL> npm run db:migrate`. `db/migrate.ts` re-applies every file and each is idempotent, so apply a release's migrations *before* it deploys (this release needs 008: sign-in reads `beta_invites`). **Never run `npm run db:seed` against production** — it is demo data.
   On networks with broken IPv6 and high latency, Node may need `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=3000` to connect.
3. **Environment variables** (Vercel → Project → Settings → Environment Variables, Production):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Neon **pooled** URL (Sydney) |
   | `SESSION_SECRET` | 32+ random characters |
   | `CRON_SECRET` | random; Vercel Cron sends it as `Authorization: Bearer …` |
   | `NEXT_PUBLIC_BASE_URL` | `https://onsite-au.vercel.app` (inlined at build) |
   | `SMS_PROVIDER` | `clicksend` |
   | `CLICKSEND_USERNAME`, `CLICKSEND_API_KEY` | ClickSend API credentials |
   | `CLICKSEND_FROM` | leave unset: texts go from ClickSend's shared number until a sender is registered |
   | `BETA_INVITE_ONLY` | `1` for a closed beta; unset for the open demo |
   | `DEMO_SITE`, `DEV_SHOW_OTP` | `1` and `1` for the open demo (codes on screen); unset both for real production |
   | `PRIVACY_CONTACT_EMAIL`, `BUSINESS_NAME` | the contact line on `/privacy` (both, or the page shows none) |
   | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | web push (`npx web-push generate-vapid-keys`) |
   | `WHITE_CARD_API_KEY`, `WHITE_CARD_API_SECRET` (`WHITE_CARD_AUTH_HEADER` optional) | SafeWork NSW register |
   | `OTP_SENDS_PER_HOUR`, `SMS_ALERTS_PER_HOUR`, `WHITECARD_CHECKS_PER_DAY` | beta limits — see below |
   | `DEMO_CONSOLE` | leave unset (ignored in production unless `DEMO_SITE=1`) |

4. **Cron.** `vercel.json` calls `GET /api/cron/expand` every 4 minutes (production deployments only): widens matching, reconciles QPay, re-checks queued White Cards, sends unsent alerts, and keeps the Neon compute awake.
5. **Invites.** With `BETA_INVITE_ONLY=1`, only numbers on the guest list — or that already have an account — get a login code. Manage the list from your machine:
   `DATABASE_URL=<direct URL> npm run beta:invite -- 0412345678 [--role worker|boss] [--note "…"]`, `-- --list`, `-- --remove 0412345678`. Removing a number stops a new sign-up, not an existing account.

### Beta limits

Set on Vercel; the defaults apply when unset.

| What | Variable | Default |
|---|---|---|
| Login-code texts the whole app sends in an hour | `OTP_SENDS_PER_HOUR` | 1000 |
| Shift-offer texts the whole app sends in an hour (one boss may use a fifth) | `SMS_ALERTS_PER_HOUR` | 500 |
| SafeWork NSW register calls in a day | `WHITECARD_CHECKS_PER_DAY` | 70 |

Fixed in code: 40 code requests an hour per connection, 5 codes an hour and 1 a minute per number, 150 code tries an hour per connection, 5 shift-offer texts a day per person, 40 shift posts an hour per boss, 10 card saves an hour per worker, 5 re-checks per cron run, and a 15-minute pause on all register calls after one fails.

## Phone alerts

Every notification row is an outbox. After the tap that wrote it, `lib/alerts.ts` pushes it to each phone the person turned alerts on for (Me → Phone alerts, or the nudge on the home screen), and texts **shift offers** when no push landed or the shift starts within 3 hours. Anything unsent after 30 minutes is dropped — a stale "shift near you" is worse than none. The 4-minute cron is the backup sender, and a send that dies mid-way is retried after 2 minutes. Texts never carry words a boss typed (fixed wording plus the shift's date and time), each person gets at most 5 a day, one boss at most a fifth of `SMS_ALERTS_PER_HOUR` (default 500) so nobody can drain the budget and silence everyone else, and a boss can post at most 40 shifts an hour. A text is stamped the moment it lands, so a retry never buys a second one; a text the provider refused is retried, and any budget it charged is handed back so a refusal never eats someone's allowance. Texts go through ClickSend (`SMS_PROVIDER`, `CLICKSEND_USERNAME`, `CLICKSEND_API_KEY`, optional `CLICKSEND_FROM`; Twilio still works if chosen) and only count as sent when ClickSend accepts that message — `INSUFFICIENT_CREDIT`, an invalid recipient or an HTTP error is a failure. ClickSend says it pauses texts that contain links for new customers until approved, and shift-offer texts carry one when `NEXT_PUBLIC_BASE_URL` is set. With no SMS provider, `npm run dev` logs the message instead of sending it; a production build refuses to pretend — it logs that nothing was sent (never the message, which can be a login code) and the alert is retried until it expires. Signing out switches that phone's alerts off (the subscription is remembered in a cookie, so it works without JavaScript). Push needs `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`; only real push services (Google, Apple, Mozilla, Microsoft) are accepted as endpoints. On iPhone, alerts work once OnSite is added to the Home Screen (iOS 16.4+).

## Maps

MapLibre 6 runs its tile worker from separate files that bundlers can't locate, so `scripts/copy-maplibre-worker.mjs` copies them from `node_modules` to `public/maplibre/<version>/` on install, dev and build (git-ignored), and `components/MapPicker.tsx` points MapLibre at them.

## Login codes

Codes come from the crypto RNG and only an HMAC is stored. Five wrong guesses per number per hour — counted in the same statement that checks them, and not reset by asking for a new code. One code a minute and five an hour per number (signing in doesn't reset that), 40 an hour per connection (IPv6 counted per /64), and `OTP_SENDS_PER_HOUR` (default 1000) real sends across the app — refused requests don't count, so hammering one number can't lock everyone else out. Australian mobiles only. **Closed beta:** with `BETA_INVITE_ONLY=1` a number that is neither on `beta_invites` nor an existing account gets one sentence — no text, no code row, nothing from the app-wide or per-number budgets — but the request still counts against its connection's 40 an hour, so the guest list can't be probed for free. The web form and `POST /api/v1/auth/request-code` (403 for this refusal) share the gate in `requestCode`; the first successful sign-in stamps `beta_invites.first_signed_in_at`. Known trade-off: anyone can spend a number's five guesses and lock it out of *new* sign-ins for up to an hour (existing sessions are unaffected).

## Licence checks (SafeWork NSW)

`lib/whitecard.ts` talks to the Service NSW **Holders of White Cards and Traffic Control Work Cards Register** (`api.onegov.nsw.gov.au`): Basic auth → bearer token (cached, renewed a minute early, concurrent callers share one login, dropped and retried once on a 401; a token that is inside the renew minute is kept in use if the login endpoint blips) → `GET /wcregister/v1/verify?licenceNumber=…`. `lib/licenceCheck.ts` turns the answer into a badge — Current, the right sort of card, and the name matches → **verified**; Suspended / Refused / Cancelled → **not on the register**, in the register's own word; expired by status or date → **expired**; a different name against that number → **name doesn't match**. That register also holds **Traffic Control Work Cards**, so the card type is checked too: a live White Card row says "General Construction Induction Training Card", and a number that turns out to be a traffic card is *not* a White Card. The register's `/browse` and `/details` endpoints are never called: searching by name hands back other people's cards.

A card is expired at the end of its expiry day **in Sydney** (`lib/util.ts` `TZ`), not on the server's clock — a UTC box would keep a dead card green through the whole Sydney morning.

Anyone signed in can type any number into that form, so the answer never says whose card it is: a name mismatch says only that the number is under a different name, and the register's name is carried back only when it is the name the worker gave. Saving a card is capped at **10 an hour per worker** (`LICENCE_SAVES_PER_HOUR`, the same atomic counter as the login codes); over that the save is refused before the register is asked anything.

**The quota.** API NSW's free tier is **2,500 calls a month**, no per-day figure is published, and there is no sandbox — every key hits production. So on top of the per-worker cap the whole app spends at most `WHITECARD_CHECKS_PER_DAY` register calls a day (default **70**, ≈2,100 a month, leaving headroom for re-checks and `npm run whitecard:ping`). It's charged in `lib/licenceCheck.ts` in the same atomic statement that checks it, immediately before the call goes out: a call that was made and then failed still counts (NSW counted it), a call we refused to make costs nothing. At the ceiling — and whenever the register throttles us, which is **429 or 503** (the sibling NSW gateway answers a spent quota with a 503) — the answer is *couldn't check*, never *not on the register*, and it is never retried on the spot: the card stays unchecked and goes on the re-check queue below.

**Only NSW White Cards are checked automatically.** That register doesn't hold high risk work licences (LF / WP / DG / SB), and no other state has an API, so everything else stays a human check and shows as "on file, not checked". A call that didn't come back — network, timeout, 5xx, 429, a body we can't read, a 401 twice — is *couldn't check*, never *not on the register*: the card stays unchecked and goes on the re-check queue.

**Re-checks.** A NSW White Card whose check couldn't complete — the register or its token service down, a timeout, a 4xx/5xx, 429/503, or the day's budget spent — is not left unchecked for ever. `checkLicence` says so explicitly (`retryable: "failed" | "cap_refused" | "paused"`, never read off the note's wording) and `saveLicence` queues the card (`licences.recheck_at`, migration 007); any other save — a real answer, another state, a high risk work licence — takes it off the queue. The 4-minute cron runs `recheckLicences()` (`lib/licenceRecheck.ts`) before it delivers alerts, at most **5 cards a run**:

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

**A failed call pauses the register.** After any call that got no usable answer, every register call in the app stops for 15 minutes (`REGISTER_PAUSE_MIN`): a register that is down or throttling us would answer the next call the same way, and each call counts against the quota. The pause is a row in `rate_limits` (`whitecard:paused`) so every serverless instance sees it. During it a save asks nothing, spends no budget and is queued like any save that couldn't check (`retryable: "paused"`); the re-check queue asks nothing, spends no attempt, and parks the card until the pause lifts — as does the rest of that run's batch.

A re-check the **daily budget** turns away asked nothing, so it costs no attempt: the card waits until the budget window rolls over (at least 15 min), and the rest of that run's cards wait with it without asking again. A real answer is written exactly as a save would write it (the worker's own name stays on the card), `workers.tickets` is recomputed, and the worker gets one push — never a text — saying "Your White Card checked out with SafeWork NSW." or the same plain sentence a save would have shown (never the register's name for the card). Cards are claimed with `FOR UPDATE SKIP LOCKED` and a 10-minute lease, so two runs never ask about the same card and a run that dies doesn't hot-loop; every write-back is a compare-and-set on the card as claimed, so an answer about a card the worker has since edited or removed is dropped. The cron's JSON carries `licences: { claimed, verified, not_found, expired, mismatch, retrying, gave_up, cap_deferred, paused }` — counts only. Demo cards from `npm run db:seed` are all *unchecked* and never queued: no quota is spent on made-up numbers.

The register sends each holder's home address, suburb, postcode, vehicle registration and business names with every record. They are dropped at the parser in `lib/whitecard.ts` and carried no further — not into the database, not into a log, not onto a screen. Nothing in that file logs at all: URLs there carry card numbers.

Credentials go in `.env` as `WHITE_CARD_API_KEY`, `WHITE_CARD_API_SECRET`, and the optional `WHITE_CARD_AUTH_HEADER` (the ready-made `Basic …` value the portal shows; sent as pasted, otherwise derived from key:secret). `npm run whitecard:ping` proves them against the live register in at most three calls — it tries both auth variants and says which one was accepted, masking everything sensitive. It is uncapped (run by hand, a few calls at a time) but it spends 2–3 of the month's 2,500, so never loop it.

## Payments (QPay)

`lib/qpay.ts` talks to the QPay merchant API v2 (token → invoice → payment check); `lib/billing.ts` stores invoices in `qpay_invoices` (migration 004); QPay calls `/api/qpay/callback/<invoice>/<hmac>`, which marks an invoice paid **only after QPay's own `/payment/check` confirms it** — at most one check per invoice per 10 s. A lost callback is caught by the 4-minute cron, which re-checks open invoices on a widening gap for 24 h. Amounts are whole MNT — nothing converts AUD. Credentials go in `.env` as `QPAY_USERNAME`, `QPAY_PASSWORD`, `QPAY_INVOICE_CODE`; `npm run qpay:ping` proves they work without raising an invoice. Nothing in the UI charges anyone yet — what to charge, and when, is still a product decision.

## Privacy

`/privacy` is the plain-English notice (linked from the login screen): what the app collects, who sees what, where it is kept (Sydney) and which services receive some of it. Keep it true — if a change collects, shows or sends something new, update the page and bump `PRIVACY_VERSION` in `lib/privacy.ts`. The contact line comes from `PRIVACY_CONTACT_EMAIL` and `BUSINESS_NAME` at request time; with either unset there is no contact line. Onboarding requires the "I agree to the privacy notice" box, enforced in `completeOnboarding`, which stores `users.privacy_accepted_at` and `users.privacy_version` (migration 008). The mobile API has no onboarding endpoint yet — if one is added it must enforce the same.

## Rules baked in (the "formal and correct" bits)

- Every shift is **casual employment** with the boss who posts it. Rate can't go under the Building and Construction General On-site Award casual floor (**$35.55/h**, incl. 25% loading). Super **12%** is shown separately.
- **White Card always required.** HRW licence classes LF / WP / DG / SB as chips. NSW White Cards are checked against the SafeWork register as they're saved; everything else is confirmed by hand.
- Award pay mode: 8 ordinary hours, then ×1.5 for 2h, ×2 after. Flat mode: hours × rate. CSV export per week.
- Clock-in works anywhere; the record shows distance from site and time. Boss can edit hours before approving; the worker sees the edit, both numbers stay, and there's an *I disagree* button that tells the boss to call. No locking, no auto-penalties.
- Matching notifies **3× the open spots**, ranked by show-up rate → worked-for-this-boss → distance, and widens every 20 minutes. A 2-person shift wakes up 6 phones.
- Visa type is display-only. No ABN anywhere.

## Not in the MVP (on purpose)

Ticket verification uploads, chat, ratings text, payroll/STP, admin dashboard, translations. All later.
