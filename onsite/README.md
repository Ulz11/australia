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
- The cron runs every 20 min, so the Neon compute can sleep between runs when nobody is using the app; the first tap after a quiet spell pays a short wake-up.

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
- `tests/integration/consent.test.ts` — onboarding refuses without the consent box (server-side, whatever the form sends), stamps `privacy_accepted_at` / `privacy_version` **and** `terms_accepted_at` / `terms_version` when it's ticked, and seeded demo users count as having agreed to both.
- `tests/unit/sms.test.ts` — ClickSend against a stubbed API: the documented request (Basic auth, `messages[]`, no `from` unless `CLICKSEND_FROM`), success only on HTTP 200 *and* the message's own `SUCCESS`, `INSUFFICIENT_CREDIT` / `INVALID_RECIPIENT` / HTTP errors / network failure / the 8 s timeout all `sent: false`, provider choice, and no number, message or credential in any log line (Twilio too).
- `tests/unit/routeGuards.test.ts` — source guard: no proxy, and every page, layout and route under `/boss`, `/worker`, `/onboarding` turns signed-out visitors away itself; every boss/worker action checks the role first. `tests/unit/flags.test.ts` — demo switches forced off in Vercel production, and nothing else reads them. `tests/unit/launch.test.ts` — the Vercel pool settings, `vercel.json`, the privacy contact, the rules page (request-time figures, no address or ABN typed in, linked from login, onboarding and billing), `beta:invite` arguments.
- `tests/integration/sessions.test.ts` — a session is a row: signing in writes it and labels the phone from its user agent, a re-issue after a name change keeps the same row, a deleted account's token opens nothing, a revoked session opens nothing anywhere, removing a passkey ends the session it signed in and leaves the code sign-in alone, a token with no session id is refused everywhere, both refresh routes stamp `last_seen_at` and keep the session id, signing out revokes the row, and Me signs out one phone or every other one and never anybody else's.
- `tests/integration/session.test.ts` + `tests/unit/session.test.ts` — staying signed in: year-long tokens and cookie, the refresh route re-issuing a day-old session and leaving a fresh one alone, 401 + cleared cookie for a missing, forged, expired or deleted-user session, frame cookies never touched, the app's bearer refresh and sign-in `expires_at`, sign-out unchanged. `tests/unit/place.test.ts` + `tests/integration/home.test.ts` — "Use my location" logic: a home rounded to ~1 km on every path (and again by the server), labels from Nominatim answers, plain-word location errors.
- `tests/integration/passkeys.test.ts` + `tests/unit/passkeys.test.ts` — Face ID / fingerprint sign-in through the real actions with a software passkey (`tests/helpers/softAuthenticator.ts`: an ES256 key, hand-built authenticator data, CBOR `none` attestation): registering stores the right row and excludes it next time; signing in sets the same session cookie and redirect as a code (boss, worker, onboarding with invite) and records counter and last use; a challenge works once and not after 5 minutes, and a registration challenge is nobody else's; wrong origin, wrong rpID, a challenge never issued, a tampered signature, a counter going backwards, no user verification, someone else's user handle all refused; two racing sign-ins with one counter, one gets in; a removed passkey refused in plain words; nobody removes another person's passkey; registering needs a signed-in user; the rate limits; fail-closed. Unit: rpID/origin derivation with override and fail-closed, device labels, and the passkey's account name never holding the full phone number.
- `tests/integration/otp.test.ts` — login codes under attack: 40 parallel guesses spend exactly 5, a new code doesn't reset the count, 10 parallel sends send one, a code signs in once, foreign numbers refused.
- `tests/integration/crewImport.test.ts` + `tests/unit/crew.test.ts` — a boss bringing their own crew: reading a pasted list (name off the front, number off the end, anything that isn't an Australian mobile kept out as typed, the same number twice as one person, fifty at a time), the preview changing nothing, importing telling the ones already here and inviting the rest, importing twice doubling nothing, one boss's invited numbers never in another's queries, signing up completing the link both ways (an invited number, and the boss's link) and telling the boss, leaving a crew telling nobody, **a worker the boss brought never becoming an introduction while a stranger's boss still does**, and the 90-day sweep keeping the rows that joined.
- `tests/integration/reminders.test.ts` — shift reminders: each kind fires exactly once across three overlapping passes, nothing before 6pm Sydney, the 60–80 minute window at both edges, a worker who pulled out and a called-off shift get nothing, one line per job with the orange flag only when spots are open, reminders never in `SMS_KINDS`, and every sentence on its own.
- `tests/integration/alerts.test.ts` — alerts end to end against a local stand-in push service that decrypts what it receives: encrypted + VAPID-signed push, SMS fallback, urgent shifts pushed and texted, dead phones forgotten, 30-minute expiry, no double sends.
- `tests/integration/privacy.test.ts` — a boss sees a worker's phone, never their visa type or card numbers (plus a source guard for boss screens).
- `tests/unit/whitecard.test.ts` + `tests/unit/verify.test.ts` — the SafeWork NSW register against a stubbed API: token cached, renewed and shared, a failed login never poisoning the cache, 401 retried exactly once, every failure shape (400 included) ending as "couldn't check", a traffic card never passing as a White Card, no stranger's name in any answer, and the register's address fields never leaving the parser.
- `tests/integration/licences.test.ts` — the save-a-card action against a real DB: ten an hour per worker, a burst that can't slip past it, and a refused save that never reaches the register, and the app-wide 15-minute register pause after a failed call (a real row, lifted on time).
- `tests/integration/recheck.test.ts` — the White Card re-check queue against a real DB and a stubbed register: only a check that couldn't complete is queued, the backoff to the last try, a budget refusal that costs no attempt and makes no call, a register pause that asks nothing and burns no attempt (and a failure mid-run that defers the rest of the batch), an edit mid-check that throws the stale answer away, two runs never taking the same card, the cron's counts-only summary, and seeded demo cards that claim no check.
- `tests/unit/fxRate.test.ts` + `tests/integration/fxRate.test.ts` — the AUD → MNT rate against stubbed Bank of Mongolia, ExchangeRate-API and QPay answers (no live calls): the AUD key never the USD one, source order and fallback, the 6-hour cache, the ₮1,000–₮5,000 band with numbers-only logs, the override, page load asking no one, the rate kept on the invoice at the tap, "try again in a few minutes", and the cron's `fx`. It is the only file that touches `fx_rates`; `invoiceQpay.test.ts` pins its rate with the override and covers the same-day / new-day / changed-total rule.
- `tests/integration/usualWeek.test.ts` + `tests/unit/calendar.test.ts` — the usual week: `worker_free()`'s whole truth table (the day's own answer beating the pattern both ways, weekdays not in it, an empty pattern, the 14-day rule and the moment it comes back), matching finding a worker who never tapped a day and skipping one who said busy, the two worker actions (deduped and cleaned weekdays, 'clear' handing a day back), and on the screen what each day shows and what a tap does — a circle, so two or three taps land back where you started.
- `tests/unit/i18n.test.ts` + `tests/integration/languages.test.ts` — the six languages: every dictionary covering exactly English's keys and nothing else, English being its own key, every `{gap}` surviving translation, the names that are never translated, the order a language is decided in (cookie, account, browser, English), the login screen handing its client components the Mongolian dictionary, a boss staying English whatever the cookie says, a Mongolian worker's reminder arriving in Mongolian beside their mate's in English — and that the no-emoji guard can tell Cyrillic, Devanagari and Chinese from a picture.
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
lib/matching.ts      the five gates + ranking + 3×spots batching + 20-min expansion (gate 2 is worker_free())
lib/award.ts         MA000020 casual floor, OT rules, super — update on 1 July each year
lib/session.ts       sessions (cookie, or bearer for the app): a row per phone, a year, renewed while in use; requireRole()
actions/boss.ts      post shift, approve hours, crew import, pay, same-again, block…
actions/worker.ts    usual week, one-day availability, take shift, clock in/out, disagree, profile
app/boss/*           Projects · Post shift · Live shift · Workers · Pay · Me
app/worker/*         Calendar · Explore (map/list) · Shift · Me (owed, invite)
app/api/cron/expand  hit every 20 min → widens matching on stale open shifts, re-checks queued White Cards, writes due shift reminders, sends any unsent alert
lib/alerts.ts        notifications → web push (+ SMS for shift offers); public/sw.js shows them
lib/reminders.ts     the evening-before and hour-before reminders the cron writes (push only, never SMS)
lib/crew.ts          reading a pasted crew list; lib/crewWords.ts is its client-safe half
lib/otp.ts           login code rules: crypto codes, hashed at rest, 5 wrong guesses an hour
lib/passkeys.ts      Face ID / fingerprint sign-in: relying party, options, verification, labels (actions/passkeys.ts; browser half lib/passkeyClient.ts)
lib/sms.ts           one text via ClickSend (or Twilio); never logs the number or the message
lib/beta.ts          closed-beta guest list (BETA_INVITE_ONLY) — scripts/beta-invite.ts manages it
lib/flags.ts         DEMO_CONSOLE / DEV_SHOW_OTP, forced off on a Vercel production deployment unless DEMO_SITE=1
lib/i18n/            the worker side in six languages; en.ts is the source of truth (English is the key)
lib/privacy.ts       PRIVACY_VERSION and the /privacy contact (app/privacy/page.tsx)
lib/terms.ts         TERMS_VERSION for the rules at /terms (app/terms/page.tsx)
lib/bossQueries.ts   what a boss may see about a worker (never visa type or card numbers)
lib/verify.ts        licence words, states and dates — client-safe, no credentials
lib/licenceCheck.ts  runs the check and maps it to a status; only 'verified' when one ran and matched
lib/licenceRecheck.ts  asks the register again about cards it couldn't answer for (cron, backoff, compare-and-set)
lib/whitecard.ts     SafeWork NSW White Card register over HTTP (address fields dropped at the parser)
```

## Deploy (Vercel + Neon, Sydney)

Live at **https://onsite-au.vercel.app** — Vercel project `onsite-beta`, root directory `onsite`, deployed automatically from `main`. **It is currently an open demo, not real production:** there is no text provider yet, so `DEMO_SITE=1` + `DEV_SHOW_OTP=1` show sign-in codes on screen and anyone can sign up (the login screen and `/privacy` say so, including that anyone who types a number can open that account). To go live with texts: set the ClickSend variables, remove `DEMO_SITE` and `DEV_SHOW_OTP`, and decide on `BETA_INVITE_ONLY`. Data stays in Australia: the database is Neon in **Sydney**, and `vercel.json` pins every function to **Sydney** (`"regions": ["syd1"]`). There is no proxy/middleware (Vercel would run it in every region): each signed-in page, route and action checks the session itself.

1. **Database.** A Neon project in AWS Sydney. The app uses the **pooled** connection string; migrations use the **direct** one.
2. **Migrations** run from your machine, not at build: `DATABASE_URL=<direct URL> npm run db:migrate`. `db/migrate.ts` re-applies every file and each is idempotent, so apply a release's migrations *before* it deploys (this release needs 008: sign-in reads `beta_invites`; Face ID sign-in needs 013). **Never run `npm run db:seed` against production** — it is demo data.
   This release needs **015**: signing in reads `sessions`, and every token issued before it stops working the moment 015's code is live, so apply 015 and expect everyone to sign in once more.
   On networks with broken IPv6 and high latency, Node may need `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=3000` to connect.
3. **Environment variables** (Vercel → Project → Settings → Environment Variables, Production):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Neon **pooled** URL (Sydney) |
   | `SESSION_SECRET` | 32+ random characters |
   | `CRON_SECRET` | random; Vercel Cron sends it as `Authorization: Bearer …` |
   | `NEXT_PUBLIC_BASE_URL` | `https://onsite-au.vercel.app` (inlined at build) — also the passkey rpID, so changing it strands every passkey |
   | `WEBAUTHN_RP_ID` | leave unset (overrides the passkey rpID — see Face ID / fingerprint sign-in) |
   | `SMS_PROVIDER` | `clicksend` |
   | `CLICKSEND_USERNAME`, `CLICKSEND_API_KEY` | ClickSend API credentials |
   | `CLICKSEND_FROM` | leave unset: texts go from ClickSend's shared number until a sender is registered |
   | `BETA_INVITE_ONLY` | `1` for a closed beta; unset for the open demo |
   | `DEMO_SITE`, `DEV_SHOW_OTP` | `1` and `1` for the open demo (codes on screen); unset both for real production |
   | `PRIVACY_CONTACT_EMAIL`, `BUSINESS_NAME` | the contact line on `/privacy` and `/terms` (both, or neither page shows one) |
   | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | web push (`npx web-push generate-vapid-keys`) |
   | `WHITE_CARD_API_KEY`, `WHITE_CARD_API_SECRET` (`WHITE_CARD_AUTH_HEADER` optional) | SafeWork NSW register |
   | `OTP_SENDS_PER_HOUR`, `SMS_ALERTS_PER_HOUR`, `WHITECARD_CHECKS_PER_DAY` | beta limits — see below |
   | `DEMO_CONSOLE` | leave unset (ignored in production unless `DEMO_SITE=1`) |

4. **Cron.** `vercel.json` calls `GET /api/cron/expand` every 20 minutes (production deployments only): widens matching, reconciles QPay, re-checks queued White Cards, writes the shift reminders that are due, deletes crew invites nobody used within 90 days, and sends unsent alerts. Neon can sleep between runs.
5. **Invites.** With `BETA_INVITE_ONLY=1`, only numbers on the guest list — or that already have an account — get a login code. Manage the list from your machine:
   `DATABASE_URL=<direct URL> npm run beta:invite -- 0412345678 [--role worker|boss] [--note "…"]`, `-- --list`, `-- --remove 0412345678`. Removing a number stops a new sign-up, not an existing account.

### Beta limits

Set on Vercel; the defaults apply when unset.

| What | Variable | Default |
|---|---|---|
| Login-code texts the whole app sends in an hour | `OTP_SENDS_PER_HOUR` | 1000 |
| Shift-offer texts the whole app sends in an hour (one boss may use a fifth) | `SMS_ALERTS_PER_HOUR` | 500 |
| SafeWork NSW register calls in a day | `WHITECARD_CHECKS_PER_DAY` | 70 |

Fixed in code: 40 code requests an hour per connection, 5 codes an hour and 1 a minute per number, 150 code tries an hour per connection, 5 shift-offer texts a day per person, 40 shift posts an hour per boss, 10 card saves an hour per worker, 5 re-checks per cron run, a 15-minute pause on all register calls after one fails, and for Face ID sign-in 60 option requests and 60 tries an hour per connection, 60 set-up requests and 20 set-ups an hour per person.

## Phone alerts

Every notification row is an outbox. After the tap that wrote it, `lib/alerts.ts` pushes it to each phone the person turned alerts on for (Me → Phone alerts, or the nudge on the home screen), and texts **shift offers** when no push landed or the shift starts within 3 hours. Anything unsent after 30 minutes is dropped — a stale "shift near you" is worse than none. The 20-minute cron is the backup sender, and a send that dies mid-way is retried after 2 minutes. Texts never carry words a boss typed (fixed wording plus the shift's date and time), each person gets at most 5 a day, one boss at most a fifth of `SMS_ALERTS_PER_HOUR` (default 500) so nobody can drain the budget and silence everyone else, and a boss can post at most 40 shifts an hour. A text is stamped the moment it lands, so a retry never buys a second one; a text the provider refused is retried, and any budget it charged is handed back so a refusal never eats someone's allowance. Texts go through ClickSend (`SMS_PROVIDER`, `CLICKSEND_USERNAME`, `CLICKSEND_API_KEY`, optional `CLICKSEND_FROM`; Twilio still works if chosen) and only count as sent when ClickSend accepts that message — `INSUFFICIENT_CREDIT`, an invalid recipient or an HTTP error is a failure. ClickSend says it pauses texts that contain links for new customers until approved, and shift-offer texts carry one when `NEXT_PUBLIC_BASE_URL` is set. With no SMS provider, `npm run dev` logs the message instead of sending it; a production build refuses to pretend — it logs that nothing was sent (never the message, which can be a login code) and the alert is retried until it expires. Signing out switches that phone's alerts off (the subscription is remembered in a cookie, so it works without JavaScript). Push needs `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`; only real push services (Google, Apple, Mozilla, Microsoft) are accepted as endpoints. On iPhone, alerts work once OnSite is added to the Home Screen (iOS 16.4+).

## A boss's own crew

Adding a worker by phone used to refuse any number that wasn't already on OnSite — which is most of a real crew. **Workers → Add your crew** (`/boss/workers/add`) takes a pasted list instead: *"One per line. Name first if you like: `Batbayar 0412 345 678`"*, plus **Pick from contacts** where the browser has the Contact Picker (Android Chrome). Up to **50** numbers at a time, read with the app's own phone rules (Australian mobiles unless `ALLOW_INTL_PHONES=1`).

- **The preview says what will happen to each one** before anything does: *on OnSite already → goes into your crew*, *not on OnSite yet → we'll invite them*, *not a mobile number* (dropped, shown as typed). It is the server's answer, and `importCrew` reads the same text again from scratch — a browser can't talk it into anything. Reading a list tells the boss which numbers have accounts, so it is capped at 40 lists an hour per boss.
- **Importing**: someone already here joins the crew (casual, no rate) and is told — *"Dave's Concreting added you to their crew. They can book you directly. Not your boss? Leave the crew in Me → Settings."* A number nobody knows becomes a `crew_invites` row (migration 019). **200 invites per boss per day**, refused in one piece rather than half-done.
- **Sending them the link.** Every boss has an invite code and a link, `/join/c/<code>`, which mirrors the mate-invite `/join/[code]`. **Send them your link** uses the phone's share sheet, or copies it. Where a text provider is configured, **Text them for me** sends one text per invite, **ever** (`crew_invites.texted_at`), through the same budgets a shift offer spends. The share text carries the boss's name and company because the boss is sending it; **the text OnSite sends carries neither** — fixed wording ending "Didn't expect this? Ignore it.", the same rule as every other text the app sends. On a demo, with no provider, only the share and copy path shows.
- **Signing up.** A number with a live invite gets onboarding with **Worker** already chosen and the name the boss typed already in the box. Finishing puts them in every inviting boss's crew, stamps the invite joined, and tells each boss (*"Batbayar joined your crew."*). Their home screen says *"You're on Dave's Concreting's crew list. They can book you directly."* for a week, with **Leave** beside it. **Me → Settings → Crews you're in** lists them all with **Leave** (`leaveCrew`, which tells nobody).
- **Never an introduction.** A worker already on a boss's crew list, or on their invite list, is not a worker OnSite found them — `lib/booking.ts` writes no `introductions` row for that pair, so **a boss importing their own crew is never charged a match fee for them**. The invite row is written for people who were already on OnSite too, joined on the spot: it is the record of who brought whom, and it outlives the boss taking them off the crew list.
- **Only the boss who typed a number sees it.** Every query is scoped to `boss_id`, and the cron deletes an invite nobody used **90 days** after it was made (`sweepCrewInvites`, reported as `crew: { expired }`). A row that joined is kept as the record above.

## Shift reminders

A worker who has taken a shift is reminded **the evening before** and again **an hour before it starts**; a boss is told the evening before what tomorrow looks like on each of their jobs. `lib/reminders.ts` writes them as ordinary notifications rows from the 20-minute cron, and `lib/alerts.ts` delivers them — **never as a text** (they are not in `SMS_KINDS`): a text is for a shift someone might otherwise miss out on, not for one they have already taken.

- **Evening before** (the first cron pass at or after **18:00 Sydney**): one per accepted booking on tomorrow's shifts — *"Tomorrow 6:30am · Steel fixer at Parramatta Rd · 3.1 km from home"* (the distance only when the worker has set a home), opening My shift.
- **Morning of** (the first pass **60–80 minutes** before the start): *"Starts in an hour · Parramatta Rd · Clock in when you're at the gate"*.
- **The boss, evening before**: one per **job**, not per line of a job — *"Tomorrow 6:30am at Parramatta Rd · 3 of 3 booked"*, opening that job. When spots are still open the body leads with the gap (*"1 spot still open at Parramatta Rd tomorrow…"*) and the row is marked `urgent`, so it is the orange one.
- **Idempotent under overlapping passes.** The cron lands whenever it lands, so each rule is a window wider than one 20-minute gap and `notif_reminder_once` (migration 018, on `(user_id, shift_id, kind)`) makes the second pass write nothing — the same trick as `notif_match_once`. "The first pass at or after 6pm" needs no memory of the last run. A booking that was cancelled, or a shift that was called off, gets nothing: the queries only look at bookings still `accepted` on shifts still `open` or `filled`.
- Dates and hours are Sydney's (`AT TIME ZONE 'Australia/Sydney'`), never the server's.
- **Migration 018** also adds `notifications.urgent`. Whether a boss's job was short of workers is a fact about the moment the row was written, not about delivery time, so the row carries it; `alertFor` reads it alongside the existing "shift starts within three hours" rule.
- **Worker home** shows tomorrow's shift in a compact **dark** card at the very top, above the offers — the one thing worth more than the offers that evening. Information, not attention, so it is never orange.
- On **iPhone**, alerts only work in OnSite added to the Home Screen, so the toggle now says so on any iPhone that isn't running as a home-screen app rather than waiting for the push APIs to be missing.

## Languages

The **worker** side reads in the worker's own language: **English, Монгол, नेपाली, Português (BR), Español, 中文 (Simplified)**. Boss screens stay English this round — half a translated screen is worse than none. Arabic waits for right-to-left.

- **Where it is chosen.** A globe row above the phone box on `/login` (so nobody has to read English to find out they don't have to), onboarding inherits it, and worker **Me → Settings → App language** opens the same sheet. The list is in each language's own name.
- **What is remembered.** The `onsite_lang` cookie always — a logged-out page has nothing else to read — and `users.lang` when there is an account, so the same person gets their language on a new phone as soon as they sign in. A first visit with no cookie follows `Accept-Language` when it matches a language OnSite has, else English. `<html lang>` follows. Order: cookie, then the account, then the browser (`getLang()`, `lib/i18n/server.ts`).
- **How it works.** `lib/i18n/en.ts` is the source of truth and **the English text is the key**, so the source still reads as English and a missing translation falls back to something a person can read. One file per language, each typed `Record<Key, string>`, so the compiler won't let one be short or carry a key English hasn't got. `t("Take it")` in a server component comes from `await getT()`; a client component uses `useT()` and gets its dictionary from a provider the worker layout (and `/login`, and onboarding) hands down — **only the language being read ever crosses the wire**. `{name}`-style gaps are filled after the lookup, so a translation can put them where its own grammar needs; one and many are two separate English keys (`plural`).
- **Dates** on a translated screen use the reader's locale in Sydney time (`fmtDay(day, locale)`); **money stays `$`**, and **OnSite, Face ID, White Card, QPay, ABN and Building Award are never translated** — they are the words on the card and the screen.
- **Reminders** are written in the worker's language, not the server's: they land on a phone as a push and there is nobody to translate them afterwards (`lib/reminders.ts` loads one dictionary per language that turns up in a pass). A boss's is English.
- `/privacy` and `/terms` stay English, because they have to be exact — but each says so at the top **in the reader's language**: *"This page is in English. Ask someone you trust to read it with you."*
- **The translations are drafts.** Only Mongolian has been checked by someone who speaks it. The other four need a native speaker's read before they reach real workers.

## Maps

MapLibre 6 runs its tile worker from separate files that bundlers can't locate, so `scripts/copy-maplibre-worker.mjs` copies them from `node_modules` to `public/maplibre/<version>/` on install, dev and build (git-ignored), and `components/MapPicker.tsx` points MapLibre at them.

`components/AddressPin.tsx` (new site, onboarding, Me) finds a place by search, by tapping the map, or with **Use my location** (shown only where the browser has geolocation on https/localhost): the browser's position, then one Nominatim reverse lookup for a name — if that fails the pin stays and the box says "Pinned on the map". A site is `precision="exact"` (street address). A worker's home is `precision="suburb"`: the name is the suburb and the pin is rounded to 2 decimal places (~1 km) on all three paths, and again in `completeOnboarding` / `updateMe` (`lib/place.ts`); matching radii start at 5 km, so this moves a distance by under a kilometre. Homes saved before this change keep their exact pin until the worker changes where they live on Me.

## Login codes

Codes come from the crypto RNG and only an HMAC is stored. Five wrong guesses per number per hour — counted in the same statement that checks them, and not reset by asking for a new code. One code a minute and five an hour per number (signing in doesn't reset that), 40 an hour per connection (IPv6 counted per /64), and `OTP_SENDS_PER_HOUR` (default 1000) real sends across the app — refused requests don't count, so hammering one number can't lock everyone else out. Australian mobiles only. **Closed beta:** with `BETA_INVITE_ONLY=1` a number that is neither on `beta_invites` nor an existing account gets one sentence — no text, no code row, nothing from the app-wide or per-number budgets — but the request still counts against its connection's 40 an hour, so the guest list can't be probed for free. The web form and `POST /api/v1/auth/request-code` (403 for this refusal) share the gate in `requestCode`; the first successful sign-in stamps `beta_invites.first_signed_in_at`. Known trade-off: anyone can spend a number's five guesses and lock it out of *new* sign-ins for up to an hour (existing sessions are unaffected).

**Staying signed in** (so codes are rare): a sign-in is a row in `sessions` (migration 015) plus a JWT carrying that row's id, valid for **365 days**, in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production) that lasts as long. Every read of "who is this" joins the row to the user, so **the row is the session**: gone, revoked, or its account deleted, and the token opens nothing, on every phone holding a copy. The boss and worker layouts call `POST /api/session/refresh` at most every 6 hours per browser; a session over a day old is re-issued for another year with the **same** session id (204), anything invalid gets 401 and a cleared cookie, and either way the session and the person are stamped `last_seen_at` (the usual week reads `users.last_seen_at`). The app does the same with `POST /api/v1/auth/refresh` (bearer → `{ token, expires_at }`).

Each row says how that phone got in (`via`: a code, Face ID, or the app) and what it is (`label`, from the user agent — "iPhone", "Android phone"). **Me → Settings → Where you're signed in** lists them: the phone in your hand is marked, each row has *Sign out*, and one button signs out everywhere else. Signing out revokes the row rather than dropping a cookie. Removing a passkey takes the sessions that signed in with it (`passkey_id` cascades), so that phone is out too. Trade-off: a copied cookie or token still works until someone ends that session — but now someone *can*. **Every token issued before migration 015 has no session id and is refused**, so everyone signs in once more at that release.

## Face ID / fingerprint sign-in (passkeys)

A text code stays the default and the fallback. Face ID or a fingerprint (a **passkey**, WebAuthn) is an extra way in for a phone that has been set up, so a returning tradie doesn't wait for a code.

**Where people meet it.** Right after a code sign-in, and after onboarding, the next boss or worker screen asks once: *Sign in with Face ID next time?* — **Set it up** / **Not now** (`components/PasskeyOffer.tsx`, mounted by both layouts while the one-hour `onsite_passkey_offer` cookie from `verifyCode` / `completeOnboarding` is there). It only shows where the phone has a built-in authenticator, none of the person's passkeys was set up or used on this phone, and nobody tapped **Not now** on it in the last 30 days (both remembered in `localStorage`). **Me** (boss and worker) has *Face ID and fingerprint sign-in*: each passkey's device, when it was added and last used, **Remove** (the confirm sheet), and **Add this phone** (`components/PasskeysSection.tsx`). On `/login`, under the phone form, **Sign in with Face ID or fingerprint** is shown where the browser can use passkeys; where it can also offer them as autofill (conditional mediation), the phone box's `autocomplete` becomes `tel webauthn` — only then, so a browser that doesn't know the token keeps plain `tel` — and the passkey appears in the keyboard's suggestions. The code box (`one-time-code`) is never touched.

**How it works.** `@simplewebauthn/server` and `@simplewebauthn/browser` (v14). `lib/passkeys.ts` does the checking with no opinion about cookies; `actions/passkeys.ts` holds five server actions (they post to the page they're on, so the control room's path-scoped frame cookies work, and Next checks the Origin).

- **Registering** (signed in; the action reads the user first): `residentKey: required`, `userVerification: required`, `attestation: none`, `authenticatorAttachment: platform` (hint `client-device` — "this phone"), algorithms ES256, EdDSA, RS256, and the person's existing passkeys excluded. `user.id` is the 16 bytes of their random `users.id` (stable, opaque, never the phone); `user.name` is *"Batbayar · 04•• ••• 101"* — never the full number, even if it was typed into the name. The device label comes from the user agent in plain words (iPhone, iPad, Android phone, Mac, Windows PC…).
- **Signing in**: usernameless (no allow-list), `userVerification: required`. The challenge is spent first; the passkey is looked up by credential id; the phone's user handle must be the passkey's owner; origin and rpID must match exactly; the counter must go up — except synced passkeys (iCloud Keychain, Google Password Manager), which always say 0 — and is checked again in the `UPDATE` so two racing sign-ins can't both land. Then the session is made **exactly as a code does**: `createSession` and `signedInPath` (`lib/session.ts`), the same cookie and the same redirect (onboarding, keeping an `invite`, until the account has a role and a name; then `/boss` or `/worker`). No "set up Face ID?" after signing in with Face ID.
- **Challenges** live in `webauthn_challenges` (migration 013), not a signed cookie: a row is spent by the `DELETE … RETURNING` that checks it, so it works exactly once and only for 5 minutes, on every serverless instance. A cookie can't be spent — a replayed request carrying the same cookie and signed answer would verify again, and synced passkeys' counter of 0 wouldn't catch it — and the login page runs two ceremonies (button and autofill) at once. Expired rows are swept by the next insert. Options are fetched before the tap, so the tap opens the prompt with nothing in between (iOS before 17.4 insists), and re-armed before 5 minutes run out.
- **Plain words** (`lib/passkeyClient.ts`): cancelled → "No problem — sign in with a text code instead."; a removed or unknown passkey → "That Face ID sign-in isn't linked to an account any more. Use a text code." (and the browser is told to stop offering it, `signalUnknownCredential`); anything else → the text code. Me tells the browser which passkeys are still accepted on each visit (`signalAllAcceptedCredentials`), so one removed on another phone stops being offered. Browsers without those signals ignore them.
- **Limits** (per hour, `PASSKEY_LIMITS`): 60 sign-in option requests and 60 sign-in tries per connection; 60 registration option requests and 20 registrations per person.
- **Fails closed.** No passkey UI anywhere and every action refuses (`reason: "off"`) when `NEXT_PUBLIC_BASE_URL` is missing, unreadable or not https (plain `http://localhost` is allowed under `next dev` only), or `WEBAUTHN_RP_ID` isn't that host or a parent domain of it. The browser half also hides itself when the page isn't on that exact origin (a Vercel preview URL, `127.0.0.1` instead of `localhost`).

**The relying party is the site's address — changing the domain invalidates every passkey.** `rpID` is the hostname of `NEXT_PUBLIC_BASE_URL` (live: `onsite-au.vercel.app`; dev: `localhost`) and the only accepted origin is that URL's origin. A passkey is bound to its rpID for good. Moving OnSite to another domain (say `onsite.com.au`), or changing `WEBAUTHN_RP_ID`, strands every passkey: sign-in with them fails, people fall back to a text code, and set Face ID up again from Me. So if OnSite is going to move to its own domain, move it before asking people to set up Face ID, or expect everyone to set it up again. (A way round it, not built: keep `WEBAUTHN_RP_ID=onsite-au.vercel.app` on the new domain and have `onsite-au.vercel.app` serve `/.well-known/webauthn` listing the new origin — "related origin requests", which only newer browsers honour; the server would then also have to accept the new origin.) `rpName` is "OnSite".

**Environment.** `NEXT_PUBLIC_BASE_URL` (required, `https://…`; already set in production), `WEBAUTHN_RP_ID` (optional override, normally unset). **Migration 013** must be applied before a deploy that has this code (the Me pages read `passkeys`).

**Testing on a phone.** Passkeys need a secure origin that matches `NEXT_PUBLIC_BASE_URL`: the live site, or a preview/tunnel whose URL is that variable for its build. `http://localhost:3000` works on the laptop's own browser only. On iPhone, a passkey made in Safari is in iCloud Keychain and also works in OnSite added to the Home Screen (and the other way round); the Home Screen app has its own cookies and `localStorage`, so it asks "next time?" once of its own. Android Chrome and an installed OnSite share Google Password Manager and storage.

**Not in the mobile API yet.** `/api/v1` has no passkey endpoints: the native app still signs in with a code. It would need bearer-token versions of the options/verify/register/remove actions over the same `lib/passkeys.ts`, and the app associated with the same rpID (`apple-app-site-association` `webcredentials`, Android Digital Asset Links) so its passkeys are the website's. Removing a passkey **does** end the sessions it signed in (migration 015): the confirm sheet says so, and that phone needs a text code next time.

## Licence checks (SafeWork NSW)

`lib/whitecard.ts` talks to the Service NSW **Holders of White Cards and Traffic Control Work Cards Register** (`api.onegov.nsw.gov.au`): Basic auth → bearer token (cached, renewed a minute early, concurrent callers share one login, dropped and retried once on a 401; a token that is inside the renew minute is kept in use if the login endpoint blips) → `GET /wcregister/v1/verify?licenceNumber=…`. `lib/licenceCheck.ts` turns the answer into a badge — Current, the right sort of card, and the name matches → **verified**; Suspended / Refused / Cancelled → **not on the register**, in the register's own word; expired by status or date → **expired**; a different name against that number → **name doesn't match**. That register also holds **Traffic Control Work Cards**, so the card type is checked too: a live White Card row says "General Construction Induction Training Card", and a number that turns out to be a traffic card is *not* a White Card. The register's `/browse` and `/details` endpoints are never called: searching by name hands back other people's cards.

A card is expired at the end of its expiry day **in Sydney** (`lib/util.ts` `TZ`), not on the server's clock — a UTC box would keep a dead card green through the whole Sydney morning.

Anyone signed in can type any number into that form, so the answer never says whose card it is: a name mismatch says only that the number is under a different name, and the register's name is carried back only when it is the name the worker gave. Saving a card is capped at **10 an hour per worker** (`LICENCE_SAVES_PER_HOUR`, the same atomic counter as the login codes); over that the save is refused before the register is asked anything.

**The quota.** API NSW's free tier is **2,500 calls a month**, no per-day figure is published, and there is no sandbox — every key hits production. So on top of the per-worker cap the whole app spends at most `WHITECARD_CHECKS_PER_DAY` register calls a day (default **70**, ≈2,100 a month, leaving headroom for re-checks and `npm run whitecard:ping`). It's charged in `lib/licenceCheck.ts` in the same atomic statement that checks it, immediately before the call goes out: a call that was made and then failed still counts (NSW counted it), a call we refused to make costs nothing. At the ceiling — and whenever the register throttles us, which is **429 or 503** (the sibling NSW gateway answers a spent quota with a 503) — the answer is *couldn't check*, never *not on the register*, and it is never retried on the spot: the card stays unchecked and goes on the re-check queue below.

**Only NSW White Cards are checked automatically.** That register doesn't hold high risk work licences (LF / WP / DG / SB), and no other state has an API, so everything else stays a human check and shows as "on file, not checked". A call that didn't come back — network, timeout, 5xx, 429, a body we can't read, a 401 twice — is *couldn't check*, never *not on the register*: the card stays unchecked and goes on the re-check queue.

**Re-checks.** A NSW White Card whose check couldn't complete — the register or its token service down, a timeout, a 4xx/5xx, 429/503, or the day's budget spent — is not left unchecked for ever. `checkLicence` says so explicitly (`retryable: "failed" | "cap_refused" | "paused"`, never read off the note's wording) and `saveLicence` queues the card (`licences.recheck_at`, migration 007); any other save — a real answer, another state, a high risk work licence — takes it off the queue. The 20-minute cron runs `recheckLicences()` (`lib/licenceRecheck.ts`) before it delivers alerts, at most **5 cards a run**:

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

`lib/qpay.ts` talks to the QPay merchant API v2 (token → invoice → payment check → cancel); `lib/billing.ts` stores invoices in `qpay_invoices` (migration 004), with the QR, short link and bank-app links QPay returns kept in `qr` while the invoice can be paid (migration 011 — `GET /invoice/{id}` doesn't return them again); QPay calls `/api/qpay/callback/<invoice>/<hmac>`, which marks an invoice paid **only after QPay's own `/payment/check` confirms it** — at most one check per invoice per 10 s. A lost callback is caught by the 20-minute cron, which re-checks open invoices on a widening gap for 24 h. `lib/qpay.ts` and `lib/billing.ts` deal in whole MNT only; the one AUD → MNT conversion is `audCentsToMnt` in `lib/subscription.ts`, at the live rate from `lib/fxRate.ts`. QPay's merchant v2 invoice has no currency field — `amount` is tögrög, and Mongolian law requires settlement in tögrög — so OnSite converts; it can't invoice QPay in A$ or US$ for the bank to convert. Credentials go in `.env` as `QPAY_USERNAME`, `QPAY_PASSWORD`, `QPAY_INVOICE_CODE`; `npm run qpay:ping` proves they work without raising an invoice. This is how bosses pay their **Billing** invoices (below).

## Billing — what the boss pays

Workers never pay. Bosses pay two things. Nothing charges a card: an invoice is a record with a number on it, and **it is paid only through QPay** — in tögrög, from the boss's Mongolian bank app — and marks itself paid when QPay confirms it (see *Paying an invoice* below).

**A billable match** is the **first booking with approved hours above zero** between a boss and a worker **OnSite introduced**. A booking through matching or an accepted offer writes an `introductions` row (`lib/booking.ts`, in the same transaction as the booking); a shift posted straight to one named worker (`direct_worker_id` — "Book again", *Same again tomorrow*) never does, and **neither does anyone the boss brought themselves** — already on their crew list, or on their invite list from before that worker signed up (migration 019). A boss importing their own crew is never charged for them. One row per pair, forever: repeat shifts with that worker are free. An introduced pair **stays** introduced, so if the boss later books them directly, that first approved shift still bills. The fee lands in `approveHours` (`actions/boss.ts`), in the same statement as the approval — 0 hours bills nothing, and a later edit never un-bills it.

**The subscription** is **$33 a month including GST** for the pay tools, after a **3-day free trial** that starts the moment an account becomes a boss (disclosed under the Boss choice at onboarding). The subscription starts by itself when the trial ends, so **the first charge date is the trial end**. Periods run monthly from that anchor — anniversary billing, no proration, a short month falls back to its last day. Introductions bill **from day one**: the trial covers the subscription, not the matches.

**Closing a period** (`closePeriod`, `lib/invoicing.ts`) is one idempotent step: an invoice carrying next period's subscription **in advance** (only while `active`; a `cancelling` boss gets no next line and becomes `lapsed`) plus one match line per introduction billed in the period that just ended, then the period moves on. **No invoice is written for $0.** Running it twice writes nothing the second time — `invoices (boss_id, period_start)` is unique and a billed introduction is stamped with its line. Invoice numbers are `OS-2026-000123`, unique and sequential within the Sydney year (`invoice_counters`). Dates are Sydney dates; invoices are due 14 days after they are issued.

**The gating decision — flagged, not widened.** Only the **Pay page** (`/boss/pay`) and the **CSV export** (`/boss/pay/export`) need `trialing` / `active` / `cancelling`. A lapsed boss gets a plain upsell and a *Start subscription* button instead. **Posting shifts, matching, Workers, and approving hours all stay free** — approving must stay free, because approving is what creates a billable match, and charging for it would mean charging a boss to be charged.

Cancel → `cancelling`, the pay tools run to the end of the period already paid for, then `lapsed`. Re-subscribing from `lapsed` invoices at once from a period starting now (and sweeps up any match fees incurred while lapsed). Changing your mind while still `cancelling` just clears the end date — that period is paid for, so nothing is invoiced.

**Cron.** `/api/cron/expand` (every 20 min) calls `closeBillingPeriods()` after matching, in its own try/catch so a billing fault can never stop a shift being filled, and reports `billing: { trials_ended, closed, invoiced, lapsed }` — counts only, never an id. While QPay is configured it also warms the rate (`warmAudToMnt`): it asks the Bank of Mongolia only when there is no official rate cached in the last 6 hours (a fresh fallback rate doesn't stop it trying again), and reports `fx: { source, as_of }` (nulls when there is no rate or QPay is off).

**Paying an invoice — QPay only.** An open invoice's page (`/boss/billing/[number]`) has one big **Pay with QPay** (`payWithQpay` in `actions/billing.ts` → `payInvoiceWithQpay` in `lib/invoiceQpay.ts`; the boss must own the invoice — anyone else's number is simply not found).

- **The amount.** The QPay amount is `ceil(total_cents / 100 × rate)` whole tögrög — never a tögrög under — worked out in integers (`audCentsToMnt`, `lib/subscription.ts`), because in floating point 14 cents at 2250 comes out a tögrög high. With QPay not configured (`qpayConfigured()`), the invoice says "Payment by QPay isn't set up yet — we'll send you payment details." and has no button. Nothing ever invents bank details.
- **The rate — tögrög per Australian dollar** (`audToMnt()`, `lib/fxRate.ts`), looked up **at the tap**, never on page load. **Mind the currency:** on 17 Sept 2026 the Bank of Mongolia had **A$1 = ₮2,559.03** and **US$1 = ₮3,595.66**; "about 3,600 per dollar" is the US-dollar rate, and charging it per A$ overcharges by ~40%. Every source is read by its AUD key. In order:
  1. `AUD_MNT_RATE` when `AUD_MNT_RATE_OVERRIDE=1` — a person has decided the rate; nothing is fetched.
  2. **The Bank of Mongolia's official daily rate** — the JSON its own [currency-rates page](https://www.mongolbank.mn/en/currency-rates) loads: `POST https://www.mongolbank.mn/en/currency-rates/data` → `{ success, data: [{ RATE_DATE, AUD: "2,559.03", USD: "3,595.66", … }] }`, the latest day's closing rate (the bank notes it is valid for the next day for accounting). It isn't a published API: if its shape changes it is a failed source. The page runs reCAPTCHA v3 for itself; the data call doesn't need it, and nothing here tries to get past it if that changes.
  3. **ExchangeRate-API's open endpoint** — `GET https://open.er-api.com/v6/latest/AUD` → `rates.MNT` (kept to two decimals). No key; updated once a day; answers 429 if asked too often (hourly is fine, and the cache asks far less); commercial use allowed; its docs ask for a "Rates By Exchange Rate API" link, which the invoice shows whenever this source's rate is on it. Its terms say it isn't meant for transactions, which is why it is only the fallback.
  4. `AUD_MNT_RATE` without the override — a manual last resort.
  
  Nothing works → the tap says "Couldn't get today's exchange rate — try again in a few minutes." and raises nothing. A fetched rate is **cached in `fx_rates` for 6 hours** (migration 012; a fresh Bank of Mongolia row beats a fresh fallback row), each fetch gives up after **8 s**, and nothing in `lib/fxRate.ts` throws. **Bounds:** a rate outside **₮1,000–₮5,000 per A$1** (sources, cache and `AUD_MNT_RATE` alike) is a source error — logged with the numbers only, never cached, and the next source is tried. The band catches a broken source, not US$-for-A$: ₮3,596 is inside it.
- **Lazy creation, and a QR that stays put.** Rendering the page never talks to QPay or a rate source: it shows the linked QR, or an **estimate at the cached rate** (up to a week old; with no rate known it says the amount is worked out when you tap). The tap **reuses** the QPay invoice already linked if it is still open, **was raised today** (Sydney date, `qpay_raised_on`) and asks for this invoice's A$ total at the rate it was raised at — **the rate moving during the day never replaces a QR** the boss may already have open in their bank app. Only **on a new day or when the A$ total changed** does the tap look up the live rate, **retire** the old one — cancelled on QPay ("already gone" is fine), *then* checked for a payment, since a cancelled invoice can't take one; paid in full → settled, and nothing new is raised — and raise a new one with the description `OnSite invoice OS-2026-000123` (no names, no ABN), storing the link, tögrög amount, rate, its source, its day and the day it was raised on `invoices` (`qpay_sender_invoice_no`, `qpay_amount_mnt`, `qpay_rate`, `qpay_rate_source`, `qpay_rate_as_of`, `qpay_raised_on`) in one statement. **Two taps at once raise one QPay invoice:** a tap first takes a lease on the invoice row (`qpay_claimed_at`, 3 minutes; a plain column, never a transaction held open while QPay answers), and the other tap waits for it and then reuses what it made.
- **The screen after the tap.** The total as **A$33.00** with "≈ ₮84,448 · Bank of Mongolia rate for 17 Sept: ₮2,559.03 per A$1" (or "ExchangeRate-API rate for …", or "Rate set by OnSite: …"), "Pay in your bank app. This page updates by itself once QPay confirms it.", a button per bank app from QPay's `urls` (logo, name, deep link — on a phone it opens the bank app), the QR for paying from another device, and QPay's short link. `QpayWatch` polls `GET /boss/billing/[number]/status` every 5 s (every 30 s while the tab is hidden, at once when it comes back, giving up after 10 minutes with a *Check again*), and refreshes the page when the invoice is no longer open. An open invoice is grey; an **overdue** one is orange. `/boss/billing` puts a **Pay** link beside each open invoice when QPay can take the payment.
- **Settling → paid.** Three paths, all through `settleInvoice` (`lib/billing.ts`): QPay's **callback**, the **cron's reconcile**, and the page's **poll** (the status route). When a `qpay_invoices` row with purpose `onsite_invoice` flips to paid, **the same SQL statement** (data-modifying CTEs in `markPaid`) marks the linked OnSite invoice `paid` (`paid_at = now()`, `paid_note = 'QPay payment <payment_id>'`) and writes one push-only `invoice_paid` notification ("Invoice OS-2026-000123 paid — thanks."). Every part is guarded by `status = 'open'`, so running it again changes nothing. **Underpaid stays open** (the amount received is recorded on the QPay row). A payment that lands on an invoice already paid by hand or cancelled is logged for a person to refund.
- **Demo sites.** On `demoSite()` the billing screens say "This is a demo — invoices here are examples and nothing is charged." while QPay can't take a payment, and — in orange — "This is a demo, but paying an invoice here sends real money through QPay." once it can.

**Environment** (all optional, defaults shown): `MATCH_FEE_CENTS=200`, `SUBSCRIPTION_CENTS=3300`, `TRIAL_DAYS=3`, `GST_REGISTERED` (`1` → the invoice says it includes GST at 1/11 of the total; GST is **inside** the price, never added on top — anything else and there is no GST line), `AUD_MNT_RATE` (tögrög per 1 **A$**, not US$ — the manual last resort after the live rates) and `AUD_MNT_RATE_OVERRIDE` (`1` → `AUD_MNT_RATE` ahead of the live rates), `BUSINESS_NAME` / `BUSINESS_ABN` (the invoice's *From* block; without a name there is no *From* block). `BILLING_PAY_INSTRUCTIONS` is gone: invoices are paid only through QPay.

**Scripts** (both read `DATABASE_URL` from the shell only, never `.env`, and print which database they are talking to):

```bash
DATABASE_URL=… npm run billing:list                                   # every invoice, newest first
DATABASE_URL=… npm run billing:paid -- OS-2026-000123 --note "…"      # by hand, for money that arrived another way
```

`billing:paid` says so when the invoice still has an open QPay invoice, so it can be cancelled in QPay before the boss pays twice.

**Screens.** `/boss/billing` (status in plain words, this period so far, the invoice list) and `/boss/billing/[number]` (tax-invoice layout, then the QPay block), linked from `/boss/me`. `components/IntroFeeNote.tsx` sits next to Approve hours and says "First shift with Nima through OnSite — $2 goes on your next invoice" **only** when that approval is what will cause the charge.

**Migration 012** adds the rate cache `fx_rates (pair, rate, source, as_of, fetched_at)`, keyed by `(pair, as_of, source)`, and on `invoices` the rate's `qpay_rate_source` and `qpay_rate_as_of` and the Sydney day the QR was raised, `qpay_raised_on`.

**Migration 011** links an invoice to the QPay invoice that pays it (`invoices.qpay_sender_invoice_no` → `qpay_invoices`, unique; `qpay_amount_mnt`, `qpay_rate`, the `qpay_claimed_at` lease) and keeps QPay's QR payload on `qpay_invoices.qr` until it is paid or cancelled.

**Migration 010** adds the columns and tables and backfills: existing bosses get a 3-day trial from `created_at` and a period anchored at its end (a boss whose trial ended long ago is put into the period they are *actually* in, stepping whole months from that anchor — nobody is invoiced for months OnSite never billed them for); existing non-direct booking pairs become introductions already marked billed, with no invoice line, so no one is charged for their own history.

## The rules (`/terms`) and privacy (`/privacy`)

`/terms` is the plain-English agreement, in ten short sections: what OnSite is (and that **OnSite is not the employer**), that the boss is the employer for every shift they post, what workers agree to, what bosses agree to, the fees, what happens when the two sides disagree about hours, what blocking / leaving a crew / deleting an account each do, the demo warning (only on a demo deployment), changes and **the law of New South Wales**, and the contact. Every figure on it is read **when the page is requested** from the same constants the billing code charges from — `AWARD_CASUAL_FLOOR` (`lib/award.ts`), `MATCH_FEE_CENTS`, `SUBSCRIPTION_CENTS`, `TRIAL_DAYS`, `GST_REGISTERED` (`lib/subscription.ts`) — so a price can never be stale on the one screen that promises it, and no email address or ABN is ever typed into the page (`tests/unit/launch.test.ts` checks both, the same way it checks `/privacy`).

It says only what the code does. Two places where that is worth knowing: **an overdue invoice switches nothing off** — the pay tools stop only when a boss cancels and the month they have paid for runs out (`payToolsOpen`, `lib/subscription.ts`) — and **only bosses can block**, there is no worker-side block.

`TERMS_VERSION` lives in `lib/terms.ts` and is a date, like `PRIVACY_VERSION`. Onboarding's one checkbox is "I agree to the privacy notice and the terms", links both, and `completeOnboarding` stamps `users.terms_accepted_at` / `users.terms_version` beside the privacy pair. **Existing accounts are not re-asked** — a re-consent flow is deliberately not built. The login screen's footer links both pages ("How we handle your information · The rules"), and so do `/boss/billing` and each invoice.

`/privacy` is the plain-English notice (linked from the login screen): what the app collects, who sees what, where it is kept (Sydney) and which services receive some of it. Keep it true — if a change collects, shows or sends something new, update the page and bump `PRIVACY_VERSION` in `lib/privacy.ts`. The contact line comes from `PRIVACY_CONTACT_EMAIL` and `BUSINESS_NAME` at request time; with either unset there is no contact line. Onboarding requires the "I agree to the privacy notice" box, enforced in `completeOnboarding`, which stores `users.privacy_accepted_at` and `users.privacy_version` (migration 008). The mobile API has no onboarding endpoint yet — if one is added it must enforce the same.

## Rules baked in (the "formal and correct" bits)

- Every shift is **casual employment** with the boss who posts it. Rate can't go under the Building and Construction General On-site Award casual floor (**$35.55/h**, incl. 25% loading). Super **12%** is shown separately.
- **White Card always required.** HRW licence classes LF / WP / DG / SB as chips. NSW White Cards are checked against the SafeWork register as they're saved; everything else is confirmed by hand.
- Award pay mode: 8 ordinary hours, then ×1.5 for 2h, ×2 after. Flat mode: hours × rate. CSV export per week.
- Clock-in works anywhere; the record shows distance from site and time. Boss can edit hours before approving; the worker sees the edit, both numbers stay, and there's an *I disagree* button that tells the boss to call. No locking, no auto-penalties.
- Matching notifies **3× the open spots**, ranked by show-up rate → worked-for-this-boss → distance, and widens every 20 minutes. A 2-person shift wakes up 6 phones.
- **Free means one thing.** `worker_free(worker_id, day)` (migration 017) is the only answer: the worker's own answer for that day if they gave one ('free' or 'busy'), otherwise their **usual week** (`workers.usual_days`, ISO 1–7) — and then only while `users.last_seen_at` is inside 14 days, so a pattern nobody has come back to stops offering them. Matching, the map, the calendar and Explore all call it, so they cannot drift apart. The calendar's card is *Your usual week*; a first-timer sees Mon–Fri offered but **nothing applies until they tap Save**. Tapping a day walks it round a circle — plain busy → free → busy (theirs) → back to plain busy — so a tap is never a one-way door.
- Visa type is display-only. A worker never needs an ABN — every shift is employment, not a contract. (A boss's own ABN is optional, and only ever appears on their own invoices.)
- **One job, several kinds of worker.** "2 carpenters, 1 forklift driver, 3 labourers" is posted once but saved as one shift per kind of worker, sharing a `post_id` — each with its own role, count, licences and rate, and matched on its own (a forklift line only asks LF holders). Site, day, hours and overtime are set once for the job. Each line counts as a post against the hourly posting limit. Bosses see the lines together; *Cancel the whole job* calls off the lines still looking for workers, and full ones stay booked.

## Not in the MVP (on purpose)

Ticket verification uploads, chat, ratings text, payroll/STP, admin dashboard, boss screens in anything but English, Arabic (it needs right-to-left). All later.
