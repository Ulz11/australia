import { sql } from "./db";

/** Open shifts within the worker's radius (all days ≥ today), with distance and ticket check. */
export async function openShiftsNear(workerId: string, opts: { day?: string; q?: string } = {}) {
  return sql`
    SELECT s.id, s.day, s.start_time, s.hours, s.spots, s.role, s.rate, s.note, s.tickets_required, s.direct_worker_id,
           s.ot_mode, s.ot_after_hours, s.ot_multiplier, s.allow_offers,
           EXISTS (SELECT 1 FROM offers o WHERE o.shift_id = s.id AND o.worker_id = w.user_id AND o.status = 'pending') AS offered,
           p.id AS project_id, p.name AS site, p.address, ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lng,
           ST_Distance(p.location, w.home)::int AS dist_m,
           us.name AS boss_name, bo.company, bst.approve_hours_avg, bst.pay_days_avg, bst.approved_count,
           (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled'))::int AS taken,
           (s.tickets_required <@ w.tickets) AS tickets_ok,
           CASE WHEN worker_free(w.user_id, s.day) THEN 'free' ELSE 'busy' END AS avail,
           EXISTS (SELECT 1 FROM bookings b WHERE b.shift_id = s.id AND b.worker_id = w.user_id AND b.status NOT IN ('removed','cancelled')) AS mine,
           EXISTS (SELECT 1 FROM notifications n WHERE n.shift_id = s.id AND n.user_id = w.user_id AND n.kind = 'shift_match') AS notified
    FROM workers w
    JOIN shifts s ON s.status = 'open' AND s.day >= CURRENT_DATE AND (s.direct_worker_id IS NULL OR s.direct_worker_id = w.user_id)
    JOIN projects p ON p.id = s.project_id AND NOT p.archived
    JOIN users us ON us.id = s.boss_id JOIN bosses bo ON bo.user_id = s.boss_id
    LEFT JOIN boss_stats bst ON bst.boss_id = s.boss_id
    WHERE w.user_id = ${workerId} AND w.home IS NOT NULL
      AND ST_DWithin(w.home, p.location, w.radius_km * 1000)
      AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE bl.boss_id = s.boss_id AND bl.worker_id = w.user_id)
      ${opts.day ? sql`AND s.day = ${opts.day}` : sql``}
      ${opts.q ? sql`AND (s.role ILIKE ${"%" + opts.q + "%"} OR p.name ILIKE ${"%" + opts.q + "%"} OR p.address ILIKE ${"%" + opts.q + "%"})` : sql``}
    ORDER BY s.day, dist_m`;
}

export type Offer = {
  id: string; day: string; start_time: string; hours: string; spots: number; taken: number; role: string; rate: string;
  site: string; address: string; dist_m: number | null; boss_name: string; company: string | null;
  tickets_required: string[]; tickets_ok: boolean; missing: string[]; allow_offers: boolean; offered: boolean;
  ot_mode: string; ot_after_hours: string; ot_multiplier: string | null; direct: boolean; clash: boolean;
};

/**
 * The shifts a boss has actually offered this worker (lib/matching.ts writes one 'shift_match' notification per
 * offer) and that are still there to take, soonest first. Read or not — the worker's home screen is the list of
 * offers, so it can't depend on whether a phone alert was ever opened. Distance comes out null if they haven't
 * set a home yet; every other gate ("the boss took you off", blocked, archived site) is applied here, and the
 * rest — the last spot going while they read it — is caught by takeShift itself.
 */
export async function offersFor(workerId: string) {
  return sql<Offer[]>`
    SELECT s.id, s.day::text AS day, s.start_time::text AS start_time, s.hours, s.spots, s.role, s.rate,
           s.tickets_required, s.allow_offers, s.ot_mode, s.ot_after_hours, s.ot_multiplier,
           s.direct_worker_id IS NOT NULL AS direct,
           p.name AS site, p.address,
           CASE WHEN w.home IS NULL THEN NULL ELSE ST_Distance(p.location, w.home)::int END AS dist_m,
           us.name AS boss_name, bo.company,
           (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled'))::int AS taken,
           (s.tickets_required <@ w.tickets) AS tickets_ok,
           ARRAY(SELECT t FROM unnest(s.tickets_required) t WHERE NOT (t = ANY(w.tickets))) AS missing,
           EXISTS (SELECT 1 FROM offers o WHERE o.shift_id = s.id AND o.worker_id = w.user_id AND o.status = 'pending') AS offered,
           EXISTS (SELECT 1 FROM bookings b JOIN shifts x ON x.id = b.shift_id
                   WHERE b.worker_id = w.user_id AND x.day = s.day AND x.id <> s.id AND b.status IN ('accepted','clocked_in')) AS clash
    FROM notifications n
    JOIN workers w ON w.user_id = n.user_id
    JOIN shifts s ON s.id = n.shift_id AND s.status = 'open' AND s.day >= CURRENT_DATE
    JOIN projects p ON p.id = s.project_id AND NOT p.archived
    JOIN users us ON us.id = s.boss_id JOIN bosses bo ON bo.user_id = s.boss_id
    WHERE n.user_id = ${workerId} AND n.kind = 'shift_match'
      AND (s.direct_worker_id IS NULL OR s.direct_worker_id = w.user_id)
      AND s.spots > (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled'))
      AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.shift_id = s.id AND b.worker_id = w.user_id AND b.status <> 'cancelled')
      AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE bl.boss_id = s.boss_id AND bl.worker_id = w.user_id)
    ORDER BY s.day, s.start_time, dist_m NULLS LAST`;
}

export async function myBookings(workerId: string) {
  return sql`
    SELECT b.*, s.day, COALESCE(b.agreed_start, s.start_time) AS start_time, COALESCE(b.agreed_hours, s.hours) AS hours,
           COALESCE(b.agreed_rate, s.rate) AS rate, s.role, s.note, s.boss_id, s.project_id,
           s.weather_stop, s.weather_note, s.ot_mode, s.ot_after_hours, s.ot_multiplier,
           (b.agreed_rate IS NOT NULL OR b.agreed_hours IS NOT NULL OR b.agreed_start IS NOT NULL) AS negotiated,
           p.name AS site, p.address, ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lng,
           us.name AS boss_name, us.phone AS boss_phone, bo.company,
           (SELECT COUNT(*) FROM calls c WHERE c.booking_id = b.id)::int AS calls
    FROM bookings b JOIN shifts s ON s.id = b.shift_id JOIN projects p ON p.id = s.project_id
    JOIN users us ON us.id = s.boss_id JOIN bosses bo ON bo.user_id = s.boss_id
    WHERE b.worker_id = ${workerId} AND b.status NOT IN ('removed') ORDER BY s.day DESC, s.start_time`;
}
