/**
 * Demo data: Inner West Sydney. 5 bosses, 9 sites, 18 workers, open shifts, 3 weeks of pay history.
 * Run: DATABASE_URL=... npm run db:seed     (wipes and recreates demo rows only — phones starting +6140000)
 * Dev sign-in: any seeded phone, code shows on screen when DEV_SHOW_OTP=1.
 *   Boss:   0400 000 001 (Dave, Marrickville Formwork)
 *   Worker: 0400 000 101 (Batbayar)
 */
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL!, { ssl: "require", max: 1 });

const day = (n: number) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const P = (n: number) => `+61400000${String(n).padStart(3, "0")}`;

const bosses = [
  { n: 1, name: "Dave Carter", company: "Marrickville Formwork", abn: "51824753556" },
  { n: 2, name: "Tony Russo", company: "Russo Concrete", abn: "33102939181" },
  { n: 3, name: "Mick O'Brien", company: "OB Carpentry", abn: "77223344556" },
  { n: 4, name: "Sam Nguyen", company: "SN Fitouts", abn: "12345678901" },
  { n: 5, name: "Priya Sharma", company: "Sharma Civil", abn: "98765432109" },
];
// [boss, name, address, lat, lng]
const sites: [number, string, string, number, number][] = [
  [1, "Marrickville Rd Duplex", "212 Marrickville Rd, Marrickville", -33.9105, 151.1552],
  [1, "Stanmore Terrace Reno", "45 Cavendish St, Stanmore", -33.8955, 151.1650],
  [1, "Tempe Warehouse Slab", "8 Smith St, Tempe", -33.9235, 151.1585],
  [2, "Alexandria Apartments", "120 Botany Rd, Alexandria", -33.9040, 151.1950],
  [2, "Dulwich Hill Pour", "3 Wardell Rd, Dulwich Hill", -33.9040, 151.1390],
  [3, "Earlwood House", "18 Homer St, Earlwood", -33.9220, 151.1230],
  [3, "Newtown Shopfront", "300 King St, Newtown", -33.8975, 151.1790],
  [4, "Parramatta Rd Fitout", "550 Parramatta Rd, Petersham", -33.8935, 151.1550],
  [5, "Mascot Drainage", "40 Coward St, Mascot", -33.9260, 151.1900],
];
// [n, name, suburb, lat, lng, tickets, visa, radius]
const workers: [number, string, string, number, number, string[], string, number][] = [
  [101, "Batbayar Erdene", "Marrickville", -33.9120, 151.1560, ["WC", "LF"], "Student (500)", 25],
  [102, "Nima Sherpa", "Ashfield", -33.8890, 151.1250, ["WC"], "Student (500)", 20],
  [103, "Lucas Oliveira", "Newtown", -33.8980, 151.1780, ["WC", "WP"], "Working Holiday (417/462)", 30],
  [104, "Marco Bianchi", "Leichhardt", -33.8840, 151.1560, ["WC", "SB"], "Working Holiday (417/462)", 25],
  [105, "Kenji Watanabe", "Petersham", -33.8930, 151.1540, ["WC"], "Working Holiday (417/462)", 15],
  [106, "Jonas Weber", "Enmore", -33.9000, 151.1720, ["WC", "LF", "DG"], "Working Holiday (417/462)", 40],
  [107, "Diego Fernández", "Erskineville", -33.9020, 151.1850, ["WC"], "Student (500)", 25],
  [108, "Tom Walsh", "Dulwich Hill", -33.9050, 151.1400, ["WC", "LF", "WP", "DG"], "Citizen / PR", 35],
  [109, "Jack Murphy", "Tempe", -33.9240, 151.1600, ["WC", "SB"], "Citizen / PR", 25],
  [110, "Ganbold Tsend", "Marrickville", -33.9140, 151.1600, ["WC"], "Student (500)", 25],
  [111, "Pemba Tamang", "Auburn", -33.8500, 151.0330, ["WC"], "Student (500)", 25],
  [112, "Rafael Santos", "Alexandria", -33.9060, 151.1930, ["WC", "LF"], "Working Holiday (417/462)", 20],
  [113, "Giulia Conti", "Glebe", -33.8790, 151.1850, ["WC"], "Working Holiday (417/462)", 20],
  [114, "Temuulen Bat", "Sydenham", -33.9160, 151.1670, ["WC", "LF"], "Student (500)", 25],
  [115, "Prakash Rai", "Rockdale", -33.9530, 151.1370, ["WC", "DG"], "Citizen / PR", 30],
  [116, "Liam Scott", "Earlwood", -33.9200, 151.1250, ["WC", "WP", "SB"], "Citizen / PR", 25],
  [117, "Ana Pereira", "Redfern", -33.8930, 151.2040, ["WC"], "Student (500)", 15],
  [118, "Enkhjin Dorj", "Marrickville", -33.9100, 151.1500, ["WC"], "Student (500)", 25], // brand new, no history
];

async function main() {
  console.log("wiping demo rows…");
  await sql`UPDATE workers SET invited_by = NULL WHERE invited_by IN (SELECT id FROM users WHERE phone LIKE '+6140000%')`;
  await sql`DELETE FROM users WHERE phone LIKE '+6140000%'`;

  const uid: Record<number, string> = {};
  for (const b of bosses) {
    const [u] = await sql`INSERT INTO users (phone, name, role) VALUES (${P(b.n)}, ${b.name}, 'boss') RETURNING id`;
    uid[b.n] = u.id;
    await sql`INSERT INTO bosses (user_id, company, abn) VALUES (${u.id}, ${b.company}, ${b.abn})`;
  }
  for (const [n, name, sub, lat, lng, tix, visa, radius] of workers) {
    const [u] = await sql`INSERT INTO users (phone, name, role) VALUES (${P(n)}, ${name}, 'worker') RETURNING id`;
    uid[n] = u.id;
    await sql`INSERT INTO workers (user_id, home, home_label, radius_km, tickets, visa_type, invite_code)
      VALUES (${u.id}, ST_SetSRID(ST_MakePoint(${lng}, ${lat}),4326)::geography, ${sub}, ${radius}, ${tix}, ${visa}, ${"M" + String(n).slice(1) + "XK"})`;
  }
  await sql`UPDATE workers SET invited_by = ${uid[101]} WHERE user_id IN (${uid[110]}, ${uid[114]})`;

  const sid: string[] = [];
  for (const [b, name, addr, lat, lng] of sites) {
    const [p] = await sql`INSERT INTO projects (boss_id, name, address, location) VALUES (${uid[b]}, ${name}, ${addr}, ST_SetSRID(ST_MakePoint(${lng}, ${lat}),4326)::geography) RETURNING id`;
    sid.push(p.id);
  }

  // Availability: most workers free on most upcoming days; a few busy.
  const rows: { worker_id: string; day: string; status: string }[] = [];
  for (const [n] of workers) for (let i = 0; i < 21; i++) {
    const busy = (n + i) % 5 === 0 || (n === 111 && i < 7);
    rows.push({ worker_id: uid[n], day: day(i), status: busy ? "busy" : "free" });
  }
  await sql`INSERT INTO availability ${sql(rows, "worker_id", "day", "status")}`;
  await sql`INSERT INTO crew (boss_id, worker_id, type, rate, since) VALUES
    (${uid[1]}, ${uid[108]}, 'fulltime', 42.00, CURRENT_DATE - 200), (${uid[1]}, ${uid[109]}, 'fulltime', 40.00, CURRENT_DATE - 120),
    (${uid[1]}, ${uid[102]}, 'casual', 36.00, CURRENT_DATE - 60), (${uid[1]}, ${uid[105]}, 'casual', 35.55, CURRENT_DATE - 45),
    (${uid[1]}, ${uid[103]}, 'casual', 38.00, CURRENT_DATE - 30), (${uid[1]}, ${uid[112]}, 'casual', 37.00, CURRENT_DATE - 20)`;

  // 3 weeks of history for Dave's crew (approved; older weeks paid).
  const past: { worker: number; site: number; d: number; hours: number; rate: number; paid: boolean }[] = [];
  for (let d = -21; d < 0; d++) {
    const dow = new Date(day(d)).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const paid = d < -7;
    past.push({ worker: 108, site: 0, d, hours: dow === 5 ? 9.5 : 8, rate: 42, paid });
    past.push({ worker: 109, site: 0, d, hours: 8, rate: 40, paid });
    if (dow % 2 === 1) past.push({ worker: 102, site: 1, d, hours: 8, rate: 36, paid });
    if (dow === 2 || dow === 4) past.push({ worker: 105, site: 2, d, hours: 10, rate: 35.55, paid });
    if (dow === 5) past.push({ worker: 103, site: 1, d, hours: 8, rate: 38, paid });
    if (d > -10 && dow === 3) past.push({ worker: 112, site: 2, d, hours: 8, rate: 37, paid });
  }
  for (const p of past) {
    const [s] = await sql`INSERT INTO shifts (project_id, boss_id, day, start_time, hours, spots, role, rate, status, direct_worker_id)
      VALUES (${sid[p.site]}, ${uid[1]}, ${day(p.d)}, '06:30', 8, 1, 'General labourer', ${p.rate}, 'closed', ${uid[p.worker]}) RETURNING id`;
    await sql`INSERT INTO bookings (shift_id, worker_id, status, clock_in_at, clock_in_dist_m, clock_out_at, hours_worked, hours_approved, approved_at, paid_at)
      VALUES (${s.id}, ${uid[p.worker]}, ${p.paid ? "paid" : "approved"}, ${day(p.d)}::date + time '06:25', ${40 + (p.d * 7) % 200}, ${day(p.d)}::date + time '06:25' + (${p.hours} || ' hours')::interval,
              ${p.hours}, ${p.hours}, ${day(p.d)}::date + time '18:00', ${p.paid ? sql`${day(p.d + 4)}::date + time '12:00'` : null})`;
  }
  // Batbayar's own history with other bosses (so he has a score).
  for (const [d, site, boss, ok] of [[-14, 3, 2, true], [-9, 6, 3, true], [-4, 7, 4, true], [-2, 4, 2, false]] as [number, number, number, boolean][]) {
    const [s] = await sql`INSERT INTO shifts (project_id, boss_id, day, hours, spots, role, rate, status) VALUES (${sid[site]}, ${uid[boss]}, ${day(d)}, 8, 1, 'General labourer', 36, 'closed') RETURNING id`;
    if (ok) await sql`INSERT INTO bookings (shift_id, worker_id, status, clock_in_at, clock_in_dist_m, clock_out_at, hours_worked, hours_approved, approved_at, paid_at)
      VALUES (${s.id}, ${uid[101]}, 'paid', ${day(d)}::date + time '06:28', 120, ${day(d)}::date + time '15:00', 8.5, 8.5, ${day(d)}::date + time '17:00', ${day(d + 3)}::date + time '10:00')`;
    else await sql`INSERT INTO bookings (shift_id, worker_id, status, clock_in_at, clock_out_at, hours_worked, hours_approved, approved_at)
      VALUES (${s.id}, ${uid[101]}, 'approved', ${day(d)}::date + time '06:40', ${day(d)}::date + time '14:30', 8, 7.5, ${day(d)}::date + time '19:00')`;
  }

  // Open shifts on the board.
  const open: [number, number, number, string, string[], number, number, number?][] = [
    // site, boss, day offset, role, tickets, spots, rate, taken-by worker n
    [7, 4, 2, "Forklift driver", ["WC", "LF"], 1, 38.5],
    [3, 2, 1, "General labourer", ["WC"], 3, 36, 113],
    [4, 2, 1, "Concreter", ["WC"], 2, 37.5, 107],
    [5, 3, 2, "Carpenter", ["WC"], 1, 40],
    [6, 3, 3, "General labourer", ["WC"], 2, 35.55],
    [8, 5, 1, "Dogman / rigger", ["WC", "DG"], 1, 44],
    [8, 5, 4, "General labourer", ["WC"], 4, 36, 115],
    [3, 2, 5, "Scaffolder", ["WC", "SB"], 2, 41],
    [7, 4, 6, "Cleaner / demo", ["WC"], 2, 35.55],
  ];
  for (const [site, boss, d, role, tix, spots, rate, taken] of open) {
    const [s] = await sql`INSERT INTO shifts (project_id, boss_id, day, hours, spots, role, tickets_required, rate, notify_round, last_notified_at)
      VALUES (${sid[site]}, ${uid[boss]}, ${day(d)}, 8, ${spots}, ${role}, ${tix}, ${rate}, 1, now()) RETURNING id`;
    if (taken) await sql`INSERT INTO bookings (shift_id, worker_id) VALUES (${s.id}, ${uid[taken]})`;
  }
  // Dave's shift tomorrow, Nima already on it, one spot open + Batbayar notified.
  const [ds] = await sql`INSERT INTO shifts (project_id, boss_id, day, hours, spots, role, rate, notify_round, last_notified_at)
    VALUES (${sid[0]}, ${uid[1]}, ${day(1)}, 8, 2, 'General labourer', 36, 1, now()) RETURNING id`;
  await sql`INSERT INTO bookings (shift_id, worker_id) VALUES (${ds.id}, ${uid[102]})`;
  await sql`INSERT INTO notifications (user_id, shift_id, kind, body) VALUES (${uid[101]}, ${ds.id}, 'shift_match', 'General labourer at Marrickville Rd Duplex · tomorrow 6:30am · 8h · $36/h')`;

  // ── profiles, cards and a couple of live deal requests ────────────────────
  const PROF: Record<number, [number, string[], string[], string]> = {
    101: [6, ["Formwork", "General labouring", "Concreting"], ["Mongolian", "English"], "6 years formwork. Own car and tools. Early starts no problem."],
    102: [3, ["General labouring", "Demolition"], ["Nepali", "English"], "Reliable, never missed a start."],
    103: [8, ["Carpentry", "Formwork"], ["Portuguese", "English"], "Chippy by trade. Own nail gun and levels."],
    106: [11, ["Rigging / dogging", "Steel fixing"], ["German", "English"], "Ticketed dogman. Happy on cranes and heights."],
    108: [15, ["Formwork", "Concreting", "Carpentry"], ["English"], "Leading hand. Can run a small crew."],
    109: [9, ["Scaffolding", "General labouring"], ["English"], "Scaffolder, 9 years. Own ute."],
    114: [2, ["General labouring", "Cleaning"], ["Mongolian", "English"], "Forklift ticket. Studying, free most days."],
  };
  for (const [n, [yrs, trades, langs, about]] of Object.entries(PROF)) {
    await sql`UPDATE workers SET years_exp = ${yrs}, trades = ${trades}, languages = ${langs}, about = ${about} WHERE user_id = ${uid[Number(n)]}`;
  }
  // Cards: a couple checked, most on file, one expired so the red state is visible.
  const cards: [number, string, string, string, string | null, string][] = [
    [101, "WC", "0123456789", "NSW", "2029-04-30", "verified"],
    [101, "LF", "LF-884213", "NSW", "2028-06-30", "verified"],
    [102, "WC", "0987654321", "NSW", null, "unchecked"],
    [103, "WC", "VIC-55120", "VIC", "2030-01-15", "unchecked"],
    [106, "WC", "0445512399", "NSW", "2027-11-02", "verified"],
    [106, "DG", "DG-220144", "NSW", "2027-11-02", "verified"],
    [108, "WC", "0221144556", "NSW", "2031-03-01", "verified"],
    [114, "WC", "0554433221", "NSW", "2024-08-01", "expired"],
  ];
  for (const [n, kind, num, st, exp, status] of cards) {
    await sql`INSERT INTO licences (worker_id, kind, number, issued_state, expires_on, holder_name, status, checked_at, checked_via, check_note)
      VALUES (${uid[n]}, ${kind}, ${num}, ${st}, ${exp}, ${workers.find((w) => w[0] === n)![1]}, ${status},
        ${status === "unchecked" ? null : sql`now() - interval '3 days'`},
        ${status === "unchecked" ? null : "safework_nsw"},
        ${status === "verified" ? "Checked against the SafeWork NSW register."
          : status === "expired" ? "Card ran out 1 Aug 2024. Needs renewing."
          : "Card on file. NSW check pending."})
      ON CONFLICT (worker_id, kind) DO NOTHING`;
  }
  // Site headcount targets so the cap shows something real
  await sql`UPDATE projects SET crew_target = 10 WHERE id = ${sid[0]}`;
  await sql`UPDATE projects SET crew_target = 4  WHERE id = ${sid[1]}`;

  // Two workers asking Dave for a better deal on his open shift tomorrow
  await sql`INSERT INTO offers (shift_id, worker_id, from_role, rate, message)
    VALUES (${ds.id}, ${uid[103]}, 'worker', 42.00, 'I''m a qualified chippy — worth a bit more than labourer rate. Own tools.')
    ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO offers (shift_id, worker_id, from_role, hours, start_time, message)
    VALUES (${ds.id}, ${uid[114]}, 'worker', 6, '08:00', 'Can I start at 8 and do 6 hours? I have class at 3.')
    ON CONFLICT DO NOTHING`;
  // one from Batbayar (the demo worker's phone) so his Requests screen isn't empty
  const [openForBat] = await sql`SELECT id, boss_id FROM shifts WHERE status = 'open' AND day >= CURRENT_DATE AND boss_id <> ${uid[1]} ORDER BY day LIMIT 1`;
  if (openForBat) {
    await sql`INSERT INTO offers (shift_id, worker_id, from_role, rate, message)
      VALUES (${openForBat.id}, ${uid[101]}, 'worker', 40.00, 'I''ve done 6 years formwork and I''ve got my own tools — can you do $40?')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO notifications (user_id, shift_id, kind, body)
      VALUES (${openForBat.boss_id}, ${openForBat.id}, 'offer', 'Batbayar Erdene wants to talk about this shift: Rate → $40.00')`;
  }

  await sql`INSERT INTO notifications (user_id, shift_id, kind, body) VALUES
    (${uid[1]}, ${ds.id}, 'offer', 'Lucas Oliveira wants to talk about tomorrow at Marrickville Rd Duplex: Rate $36.00 → $42.00'),
    (${uid[1]}, ${ds.id}, 'offer', 'Temuulen Bat wants to talk about tomorrow at Marrickville Rd Duplex: Hours 8 → 6, Start 06:30 → 08:00')`;

  // Give the open shifts a mix of overtime terms so the worker cards show it
  await sql`UPDATE shifts SET ot_mode = 'custom', ot_after_hours = 8, ot_multiplier = 1.75 WHERE status = 'open' AND rate > 40`;
  await sql`UPDATE shifts SET allow_offers = false WHERE status = 'open' AND role = 'Cleaner / demo'`;

  const [c] = await sql`SELECT (SELECT COUNT(*) FROM users WHERE phone LIKE '+6140000%') AS users, (SELECT COUNT(*) FROM projects) AS sites, (SELECT COUNT(*) FROM shifts WHERE status='open') AS open, (SELECT COUNT(*) FROM bookings) AS bookings,
    (SELECT COUNT(*) FROM licences) AS cards, (SELECT COUNT(*) FROM offers) AS offers`;
  console.log("seeded", c);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
