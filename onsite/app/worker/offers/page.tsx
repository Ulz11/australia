import { Hourglass } from "lucide-react";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { Say } from "@/components/ui";
import { OfferRow } from "./OfferRow";
import { fmtDay, fmtTime } from "@/lib/util";
import { getT } from "@/lib/i18n/server";
import Link from "next/link";
export const dynamic = "force-dynamic";

export default async function MyOffers() {
  const u = await requireRole("worker");
  const t = await getT();
  const offers = await sql`
    SELECT o.*, o.start_time::text AS start_txt, s.rate AS shift_rate, s.hours AS shift_hours, s.start_time::text AS shift_start,
           s.day, s.status AS shift_status, p.name AS site, us.name AS boss_name, bo.company
    FROM offers o JOIN shifts s ON s.id = o.shift_id JOIN projects p ON p.id = s.project_id
    JOIN users us ON us.id = s.boss_id JOIN bosses bo ON bo.user_id = s.boss_id
    WHERE o.worker_id = ${u.id} AND o.status <> 'countered'
    ORDER BY o.created_at DESC LIMIT 40`;
  const live = offers.filter((o) => o.status === "pending");
  const past = offers.filter((o) => o.status !== "pending");

  return (
    <>
      <Header title={t("My requests")} back="/worker" />
      <Page>
        {offers.length === 0 ? (
          <Empty>
            <div className="font-extrabold text-ink text-xl mb-1">{t("No requests yet")}</div>
            {/* The bold names a button the reader has to go and find, so it survives the translation:
                the sentence is one key with a {what} gap, and the gap is split out of the translated
                string wherever that language puts it, rather than always last the way English does. */}
            <div className="mb-4">{sandwich(t("Found a job you like but the pay or hours don't suit? Open it and tap {what}."), t("Ask for a different deal"))}</div>
            <Link href="/worker/explore" className="btn-primary">{t("See what's near me")}</Link>
          </Empty>
        ) : (
          <>
            {/* Waiting on the boss, not on this worker: nothing for them to do, so nothing orange. */}
            {live.length > 0 && <Say tone="grey" icon={Hourglass} title={t("{n} waiting on a boss", { n: live.length })}
              sub={t("You'll get a message the moment one answers.")} />}
            {live.map((o) => <OfferRow key={o.id} o={pack(o)} />)}
            {past.length > 0 && <div className="text-xl font-extrabold pt-2">{t("Done")}</div>}
            {past.map((o) => <OfferRow key={o.id} o={pack(o)} />)}
          </>
        )}
      </Page>
    </>
  );
}

/**
 * A translated sentence with one word set in bold, without pinning where that word falls. The key
 * carries `{what}` and is handed down unfilled; splitting on the marker gives the two halves in this
 * language's own order, which is not English's in four of the six.
 */
function sandwich(sentence: string, bold: string) {
  const [before, after = ""] = sentence.split("{what}");
  return <>{before}<b>{bold}</b>{after}</>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pack(o: any) {
  return {
    id: o.id, status: o.status, from_role: o.from_role, message: o.message,
    rate: o.rate == null ? null : Number(o.rate), hours: o.hours == null ? null : Number(o.hours),
    start_time: o.start_txt ? String(o.start_txt).slice(0, 5) : null,
    shift_rate: Number(o.shift_rate), shift_hours: Number(o.shift_hours), shift_start: String(o.shift_start).slice(0, 5),
    when: `${fmtDay(o.day)} · ${fmtTime(o.shift_start)}`, site: o.site, boss: o.company || o.boss_name,
    dead: o.shift_status === "cancelled",
  };
}
