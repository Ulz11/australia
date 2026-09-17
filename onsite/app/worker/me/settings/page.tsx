import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Section } from "@/components/ui";
import { AlertsToggle } from "@/components/AlertsToggle";
import { PasskeysSection } from "@/components/PasskeysSection";
import { SessionsSection } from "@/components/SessionsSection";
import { CrewsSection, type CrewRow } from "@/components/CrewsSection";
import { savedPushFingerprint } from "@/lib/alerts";
import { listPasskeys } from "@/lib/passkeys";
import { listSessions } from "@/lib/session";
import { logout } from "@/actions/auth";
import { MeForm } from "../MeForm";
export const dynamic = "force-dynamic";

/** The switches, out of the way of the record: where you work, alerts, how you sign in, and the way out. */
export default async function Settings() {
  const u = await requireRole("worker");
  const [[w], crews, passkeys, sessions, savedPush] = await Promise.all([
    sql`SELECT radius_km, tickets, visa_type, home_label,
          ST_Y(home::geometry) AS lat, ST_X(home::geometry) AS lng
        FROM workers WHERE user_id = ${u.id}`,
    sql<CrewRow[]>`SELECT c.boss_id, bo.company, us.name AS boss_name FROM crew c
       JOIN bosses bo ON bo.user_id = c.boss_id JOIN users us ON us.id = c.boss_id
       WHERE c.worker_id = ${u.id} ORDER BY bo.company`,
    listPasskeys(u.id),
    listSessions(u.id),
    savedPushFingerprint(u.id),
  ]);
  return (
    <>
      <Header title="Settings" back="/worker/me" />
      <Page>
        <Section title="Where and how far" hint="These two decide which shifts you get shown at all." />
        <MeForm name={u.name!} radius={w.radius_km} tickets={w.tickets} visa={w.visa_type}
          home={w.lat ? { lat: w.lat, lng: w.lng, label: w.home_label } : null} />

        <CrewsSection crews={crews} />
        {process.env.VAPID_PUBLIC_KEY && <AlertsToggle publicKey={process.env.VAPID_PUBLIC_KEY} savedPush={savedPush} role="worker" />}
        <PasskeysSection userId={u.id} passkeys={passkeys} />
        <SessionsSection sessions={sessions} currentSid={u.sid} />

        <div className="card space-y-2">
          <div className="text-lg font-bold">Your rights, short version</div>
          <p>Every shift here is a casual job with the boss who posted it. No ABN. Minimum pay is the Building Award rate. Super goes on top. Your hours record is yours.</p>
        </div>
        <form action={logout}><button className="btn-ghost">Sign out</button></form>
      </Page>
    </>
  );
}
