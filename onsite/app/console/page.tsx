import fs from "node:fs";
import path from "node:path";
import { sql } from "@/lib/db";
import { mdToHtml } from "@/lib/md";
import { Console } from "./Console";
import "./console.css";
export const dynamic = "force-dynamic";

/**
 * The control room. One screen for the whole project: both phones live on one
 * database, what's happening between them, the three revenue scenarios, what the
 * marketplace simulation found, and the project's vitals.
 */
export default async function ControlRoom() {
  if (process.env.DEMO_CONSOLE !== "1")
    return <main className="cr-off"><h1>Control room is off</h1><p>Set <code>DEMO_CONSOLE=1</code> in <code>.env</code> and restart. Never turn it on in production — it signs demo accounts in without a code.</p></main>;

  const [bosses, workers, counts] = await Promise.all([
    sql`SELECT u.id, u.phone, u.name, b.company FROM users u JOIN bosses b ON b.user_id = u.id WHERE u.phone LIKE '+6140000%' ORDER BY u.phone`,
    sql`SELECT u.id, u.phone, u.name, w.home_label, w.tickets FROM users u JOIN workers w ON w.user_id = u.id WHERE u.phone LIKE '+6140000%' ORDER BY u.phone`,
    sql`SELECT
          (SELECT COUNT(*) FROM users WHERE role = 'boss')::int AS bosses,
          (SELECT COUNT(*) FROM users WHERE role = 'worker')::int AS workers,
          (SELECT COUNT(*) FROM projects WHERE NOT archived)::int AS sites,
          (SELECT COUNT(*) FROM shifts WHERE status = 'open' AND day >= CURRENT_DATE)::int AS open_shifts,
          (SELECT COUNT(*) FROM bookings WHERE status IN ('accepted','clocked_in'))::int AS live_bookings,
          (SELECT COUNT(*) FROM bookings WHERE status = 'clocked_out')::int AS to_approve,
          (SELECT COUNT(*) FROM bookings WHERE status = 'approved')::int AS owed,
          (SELECT COUNT(*) FROM offers WHERE status = 'pending')::int AS open_offers,
          (SELECT COUNT(*) FROM licences WHERE status = 'unchecked')::int AS cards_to_check,
          (SELECT COUNT(*) FROM notifications WHERE created_at > now() - interval '24 hours')::int AS notifs_24h`,
  ]);
  const read = (p: string) => { try { return fs.readFileSync(path.join(process.cwd(), p), "utf8"); } catch { return ""; } };
  const results = mdToHtml(read("sim/RESULTS.md") || "_Run `python3 sim/marketplace.py` to generate sim/RESULTS.md._");
  const readme = mdToHtml(read("README.md"));
  const env = {
    db: !!process.env.DATABASE_URL,
    twilio: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM),
    nsw: !!(process.env.NSW_LICENCE_API_KEY && process.env.NSW_LICENCE_API_URL),
    cron: !!process.env.CRON_SECRET,
    devOtp: process.env.DEV_SHOW_OTP === "1",
    node: process.env.NODE_ENV ?? "development",
  };
  const tests = countTests();

  return (
    <Console
      bosses={bosses.map((b) => ({ id: b.id, phone: b.phone, name: b.name, sub: b.company }))}
      workers={workers.map((w) => ({ id: w.id, phone: w.phone, name: w.name, sub: `${w.home_label ?? ""} · ${(w.tickets as string[]).join(" ")}` }))}
      counts={counts[0] as never}
      env={env}
      tests={tests}
      resultsHtml={results}
      readmeHtml={readme}
    />
  );
}

/** Count `it(` blocks per test file so the Project panel can say what's covered. */
function countTests() {
  const root = path.join(process.cwd(), "tests");
  const out: { file: string; n: number }[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".test.ts")) out.push({ file: path.relative(root, p), n: (fs.readFileSync(p, "utf8").match(/^\s*it\(/gm) ?? []).length });
    }
  };
  walk(root);
  return out;
}
