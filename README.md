# Australia — construction shift marketplace

Everything for the OnSite project, from first research to a running MVP.

| Path | What it is |
|---|---|
| `onsite/` | The app: Next.js + Postgres/PostGIS. Boss and worker phones, matching engine, pay, offers, licences. Start with `onsite/README.md`. |
| `onsite/sim/` | Marketplace simulation and what it found (`RESULTS.md`). |
| `onsite/app/console/` | The control room — both phones side by side, live, plus scenarios and project vitals at `/console`. |
| `onsite-money-model.html` | Three revenue scenarios for $1 a match + $33 a month, every assumption on a slider. Open in a browser. |
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

Secrets never go in git: `.env` is ignored at the root. `render.yaml` in `onsite/` deploys the app and the matching cron on Render.
