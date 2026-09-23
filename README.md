# Australia — construction shift marketplace

Everything for the OnSite project, from first research to a running MVP.

| Path | What it is |
|---|---|
| `onsite/` | The app: Next.js + Postgres/PostGIS. Boss and worker phones, matching engine, pay, offers, licences. Start with `onsite/README.md`. |
| `onsite/sim/` | Marketplace simulation and what it found (`RESULTS.md`). |
| `onsite/app/console/` | The control room — both phones side by side, live, plus scenarios and project vitals at `/console`. |
| `onsite/public/money-model.html` | Three revenue scenarios for the **old** pricing ($1 a match + $33 a month), every assumption on a slider. OnSite now charges $2 an introduction invoiced every 14 days, with no subscription — this has not been re-run against that. Open it in a browser, or at `/money-model.html` on a running app. |
| `siteshift-prototype.html` | The original clickable prototype, before the real build. |

## Run it

```powershell
cd onsite
copy .env.example .env      # then fill DATABASE_URL and SESSION_SECRET
npm.cmd install
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run build
npm.cmd start               # http://localhost:3000  ·  control room at /console
```

Demo sign-in: boss `0400 000 001`, worker `0400 000 101` — the code shows on screen in dev.

Secrets never go in git: `.env` is ignored everywhere. `onsite/vercel.json` deploys the app to Vercel (Sydney) and runs the matching cron — see `onsite/README.md` → Deploy.
