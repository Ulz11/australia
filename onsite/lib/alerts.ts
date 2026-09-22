import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { after } from "next/server";
import webpush from "web-push";
import { sql } from "./db";
import { sendSms } from "./sms";
import { URGENT_HOURS } from "./rules";
import { siteMoment } from "./siteClock";
import { hit, refund } from "./ratelimit";

/**
 * Alerts that reach the phone, not just the inbox.
 *
 * Every notifications row is an outbox entry. After the response that wrote it, deliverAlerts():
 *  1. claims unsent rows (FOR UPDATE SKIP LOCKED — two runs never send the same row),
 *  2. pushes to every phone the person turned alerts on for,
 *  3. texts a shift offer when no push landed, or when the shift starts within 3 hours (read off the shift, not the wording),
 *  4. drops anything older than 30 minutes unsent — a stale "shift near you" is worse than none.
 * The 20-minute cron runs it too. A run that dies after claiming rows leaves them unstamped; they're
 * claimed again after 2 minutes. A repeated push is collapsed by its tag; a text is stamped the moment it lands
 * (sms_at), so a retry never buys the same person a second one.
 *
 * Texts cost money and anyone can sign up as a boss, so a text never carries words a boss typed (only the
 * system-formatted day and time), each person gets at most SMS_PER_PERSON_PER_DAY, and the whole app at most
 * SMS_ALERTS_PER_HOUR, of which one boss may use SMS_SHARE_PER_BOSS. Those budgets are charged only by a text that
 * actually goes out. Push is free and carries the full message.
 */

export const ALERT_MAX_AGE_MIN = 30;
/**
 * Kinds worth a paid text when push can't carry them. Everything else is push-only — shift reminders included:
 * a text is for a shift someone might otherwise miss out on, not for one they have already taken.
 */
export const SMS_KINDS: ReadonlySet<string> = new Set(["shift_match"]);
export const SMS_PER_PERSON_PER_DAY = 5;
const smsPerHour = () => Number(process.env.SMS_ALERTS_PER_HOUR) || 500;
/** No single boss may take the whole app's texting budget and leave everyone else's offers silent. */
export const SMS_SHARE_PER_BOSS = 0.2;
const RECLAIM_AFTER_MIN = 2;

/** The whole text. Fixed wording + system-formatted time: nothing a boss typed can reach a phone as an SMS. */
export function smsFor(a: Alert, when: string | null, base: string): string {
  const time = when ? ` for ${when}` : "";
  return `OnSite: ${a.urgent ? "a shift starting soon" : "a new shift offer"}${time}. Open the app to see it${base ? `: ${base}${a.url}` : "."}`;
}

const TITLES: Record<string, string> = {
  shift_match: "Shift near you", booking: "Shift taken", approve: "Hours to approve", hours_approved: "Hours approved",
  paid: "Paid", offer: "Deal request", offer_accepted: "Deal agreed", offer_declined: "Deal declined", counter: "Counter-offer",
  cancelled: "Shift cancelled", removed: "Taken off a shift", dispute: "Worker disagrees", weather: "Weather stop", test: "Alerts are on",
  licence_check: "Card checked",            // a White Card the register couldn't answer for at save time (lib/licenceRecheck.ts) — push only
  invoice_paid: "Invoice paid",             // QPay confirmed a boss's payment (lib/billing.ts) — push only
  // Shift reminders, written by the cron (lib/reminders.ts) — push only, never a text.
  reminder_eve: "Shift tomorrow", reminder_soon: "Starts in an hour", tomorrow: "Tomorrow on site",
};

export type Alert = { title: string; body: string; url: string; tag: string; urgent: boolean };

/** What the phone shows, and where tapping it goes. Pure, so it's tested without a phone. */
export function alertFor(n: { id: string; kind: string; body: string; shift_id: string | null; role: string | null; starts_soon?: boolean | null; urgent?: boolean | null }): Alert {
  // Orange means "this needs you". A shift offer starting within three hours is worked out here from the shift;
  // a boss's "tomorrow" reminder carries it on the row, because whether spots were still open is a fact about
  // the moment it was written (lib/reminders.ts).
  const urgent = !!n.urgent || (n.kind === "shift_match" && !!n.starts_soon);
  const boss = n.role === "boss";
  const url = boss
    ? n.kind === "offer" ? "/boss/offers" : n.kind === "invoice_paid" ? "/boss/billing" : n.shift_id ? `/boss/shifts/${n.shift_id}` : "/boss"
    : n.kind === "shift_match" ? "/worker"
    // A card that has been checked opens the screen the cards are on; money opens the record, which shows it.
    : n.kind === "licence_check" ? "/worker/me/edit"
    : ["hours_approved", "paid", "test"].includes(n.kind) ? "/worker/me"
    : ["counter", "offer_accepted", "offer_declined"].includes(n.kind) ? "/worker/offers"
    : "/worker/shift";
  const title = n.kind === "shift_match" && urgent ? "Starts soon — shift near you" : TITLES[n.kind] ?? "OnSite";
  return { title, body: n.body, url, tag: `${n.kind}:${n.shift_id ?? n.id}`, urgent };
}

/** Push endpoints are URLs we POST to, so only real push services are accepted (no SSRF into our network). */
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export function endpointOk(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    const extra = (process.env.PUSH_ENDPOINT_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);   // local testing only
    if (extra.includes(u.host)) return true;
    return endpoint.length <= 1000 && u.protocol === "https:" && PUSH_HOSTS.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}

/** Names the subscription belonging to this browser, so signing out can switch its alerts off without JavaScript. */
export const PUSH_COOKIE = "onsite_push";

/**
 * A fingerprint of the subscription this person already has on this browser, for the alerts toggle to compare
 * against. A hash, not the endpoint: the endpoint is a capability URL (whoever holds it can buzz that phone),
 * so it stays in the httpOnly cookie. Returns nothing unless a row actually backs it for THIS user, so a
 * stale cookie from whoever used the phone before can't make the toggle skip registering them.
 */
export async function savedPushFingerprint(userId: string): Promise<string | undefined> {
  const endpoint = (await cookies()).get(PUSH_COOKIE)?.value;
  if (!endpoint) return undefined;
  const [row] = await sql`SELECT 1 FROM push_subscriptions WHERE endpoint = ${endpoint} AND user_id = ${userId}`;
  return row ? createHash("sha256").update(endpoint).digest("hex") : undefined;
}

export const pushConfigured = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);

/** Call right after writing notifications. Sends once the response is out; outside a request the cron picks them up. */
export function sendAlertsSoon() {
  try {
    after(() => deliverAlerts().then(() => {}, (e) => console.error("alerts", e)));
  } catch {
    /* not in a request (scripts, tests) — the cron sweep delivers within 20 minutes */
  }
}

type Claimed = { id: string; user_id: string; shift_id: string | null; kind: string; body: string; role: string | null; phone: string; starts_soon: boolean | null; shift_when: string | null; boss_id: string | null; sms_at: string | null; urgent: boolean };
type Sub = { endpoint: string; user_id: string; p256dh: string; auth: string };

export async function deliverAlerts(limit = 200): Promise<{ claimed: number; push: number; sms: number; expired: number; gone: number }> {
  const expired = await sql`
    UPDATE notifications SET sent_at = COALESCE(sent_at, now()), sent_via = 'expired'
    WHERE sent_via IS NULL AND created_at < now() - make_interval(mins => ${ALERT_MAX_AGE_MIN})`;
  const rows = await sql<Claimed[]>`
    WITH c AS (
      SELECT id FROM notifications
      WHERE sent_via IS NULL AND created_at >= now() - make_interval(mins => ${ALERT_MAX_AGE_MIN})
        AND (sent_at IS NULL OR sent_at < now() - make_interval(mins => ${RECLAIM_AFTER_MIN}))   -- unclaimed, or claimed by a run that died
      ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    UPDATE notifications n SET sent_at = now() FROM c, users u
    WHERE n.id = c.id AND u.id = n.user_id
    RETURNING n.id, n.user_id, n.shift_id, n.kind, n.body, u.role, u.phone, n.sms_at, n.urgent,
      (SELECT s.boss_id FROM shifts s WHERE s.id = n.shift_id) AS boss_id,
      -- "Within three hours" is a question about a real instant, so the site says which clock its start time is
      -- on (lib/siteClock.ts). Read on the connection's clock a 6:30am start looks ten hours later than it is:
      -- this turned orange, and bought a text, the evening before — then stayed quiet at 3:30am when it was true.
      (SELECT ${siteMoment(sql`s.day + s.start_time`, sql`p.tz`)} BETWEEN now() AND now() + make_interval(hours => ${URGENT_HOURS})
       FROM shifts s JOIN projects p ON p.id = s.project_id WHERE s.id = n.shift_id) AS starts_soon,
      (SELECT to_char(s.day, 'Dy DD Mon') || ', ' || lower(to_char(s.start_time, 'FMHH12:MIam')) FROM shifts s WHERE s.id = n.shift_id) AS shift_when`;
  const out = { claimed: rows.length, push: 0, sms: 0, expired: expired.count, gone: 0 };
  if (!rows.length) return out;

  let push = pushConfigured();
  if (push) {
    try {
      webpush.setVapidDetails(process.env.VAPID_SUBJECT!, process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
    } catch (e) {
      console.error("push off — VAPID settings rejected:", (e as Error).message);   // texts still go
      push = false;
    }
  }
  const subs = push ? await sql<Sub[]>`SELECT endpoint, user_id, p256dh, auth FROM push_subscriptions WHERE user_id = ANY(${[...new Set(rows.map((r) => r.user_id))]})` : [];
  const base = (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const gone = new Set<string>(), ok = new Set<string>(), failed = new Set<string>();

  const results = await Promise.all(rows.map(async (n) => {
    try {
      const a = alertFor(n);
      const mine = subs.filter((s) => s.user_id === n.user_id && endpointOk(s.endpoint));
      const landed = await Promise.all(mine.map((s) =>
        webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: a.title, body: a.body, url: a.url, tag: a.tag }),
          { TTL: ALERT_MAX_AGE_MIN * 60, urgency: a.urgent ? "high" : "normal", timeout: 8000 })
          .then(() => { ok.add(s.endpoint); return true; },
            (e: { statusCode?: number; message?: string }) => {
              const isGone = e?.statusCode === 404 || e?.statusCode === 410;
              (isGone ? gone : failed).add(s.endpoint);
              if (!isGone) console.error("push failed", new URL(s.endpoint).host, e?.statusCode ?? e?.message);   // host only: the full endpoint is a capability URL
              return false;
            })));
      const pushed = landed.some(Boolean);
      let texted = false, smsFailed = false;
      if (SMS_KINDS.has(n.kind) && n.phone && !n.sms_at && (a.urgent || !pushed)) {
        // Three budgets, counted atomically so a burst can't slip past them. Anything they pay for that then
        // doesn't happen is handed back, so a refusal or a provider outage never eats someone's allowance.
        const budgets: [string, number, number][] = [
          [`sms:user:${n.user_id}`, SMS_PER_PERSON_PER_DAY, 86400],
          [`sms:boss:${n.boss_id ?? "unknown"}`, Math.ceil(smsPerHour() * SMS_SHARE_PER_BOSS), 3600],
          ["sms:all", smsPerHour(), 3600],
        ];
        const charged: [string, number, number][] = [];
        let blocked = -1;
        for (const [i, b] of budgets.entries()) {
          if (await hit(b[0], b[1], b[2])) charged.push(b);
          else { await refund(b[0], b[2]); blocked = i; break; }   // the refusing budget paid for nothing either
        }
        const handBack = () => Promise.all(charged.map(([k, , win]) => refund(k, win)));
        if (blocked === 1) console.error("SMS alerts paused for this boss — their share of SMS_ALERTS_PER_HOUR is spent");
        else if (blocked === 2) console.error("SMS alerts paused — SMS_ALERTS_PER_HOUR reached");
        if (blocked >= 0) {
          await handBack();
        } else {
          const res = await sendSms(n.phone, smsFor(a, n.shift_when, base));
          texted = res.sent;
          smsFailed = !res.sent && !res.stub;                                      // only a provider refusal is worth retrying
          if (res.sent || res.stub) {
            // The message step is done (really sent, or logged in dev): stamp it so a re-claim can't repeat it.
            await sql`UPDATE notifications SET sms_at = now() WHERE id = ${n.id}`;
          } else {
            await handBack();                                                      // the provider refused it; we'll try again
          }
        }
      }
      // A text the provider refused is worth retrying — but only when nothing else landed, so a push that
      // did land is never sent again (sms_at is the per-leg stamp; the push has no such thing).
      const via = smsFailed && !pushed ? null : [pushed && "push", texted && "sms"].filter(Boolean).join("+") || "none";
      return { id: n.id, via, pushed, texted };
    } catch (e) {
      console.error("alert delivery failed", n.id, (e as Error)?.message);
      return { id: n.id, via: null, pushed: false, texted: false };               // left unstamped → retried after RECLAIM_AFTER_MIN
    }
  }));

  out.push = results.filter((r) => r.pushed).length;
  out.sms = results.filter((r) => r.texted).length;
  out.gone = gone.size;
  const stamped = results.filter((r) => r.via);
  await Promise.all([
    stamped.length ? sql`UPDATE notifications AS n SET sent_via = v.via FROM (VALUES ${sql(stamped.map((r) => [r.id, r.via as string]))}) AS v(id, via) WHERE n.id = v.id::uuid` : null,
    gone.size ? sql`DELETE FROM push_subscriptions WHERE endpoint = ANY(${[...gone]})` : null,
    ok.size ? sql`UPDATE push_subscriptions SET last_ok_at = now(), failures = 0 WHERE endpoint = ANY(${[...ok]})` : null,
    // a subscription that keeps failing (not "gone", just broken) is dropped after 5 tries — two statements,
    // because Postgres won't reliably update and delete the same row in one
    failed.size ? sql`UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ANY(${[...failed]})`
      .then(() => sql`DELETE FROM push_subscriptions WHERE endpoint = ANY(${[...failed]}) AND failures >= 5`) : null,
  ]);
  return out;
}
