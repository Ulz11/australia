import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Field, Say } from "@/components/ui";
import { AlertsToggle } from "@/components/AlertsToggle";
import { PasskeysSection } from "@/components/PasskeysSection";
import { SessionsSection } from "@/components/SessionsSection";
import { savedPushFingerprint } from "@/lib/alerts";
import { listPasskeys } from "@/lib/passkeys";
import { listSessions } from "@/lib/session";
import { logout } from "@/actions/auth";
import { saveCompany } from "@/actions/boss";
export const dynamic = "force-dynamic";

const WRONG = {
  company: "Put your company name in — it goes on the top of every invoice.",
  abn: "That ABN doesn't check out. Eleven digits, exactly as it is registered. Leave it blank if you'd rather not give one.",
} as const;

/** The switches, out of the way of the record: company details, alerts, how you sign in, and the way out. */
export default async function BossSettings({ searchParams }: { searchParams: Promise<{ err?: string; saved?: string }> }) {
  const u = await requireRole("boss");
  const { err, saved } = await searchParams;
  const [[b], passkeys, sessions, savedPush] = await Promise.all([
    sql`SELECT company, abn FROM bosses WHERE user_id = ${u.id}`,
    listPasskeys(u.id),
    listSessions(u.id),
    savedPushFingerprint(u.id),
  ]);
  const wrong = err === "company" || err === "abn" ? WRONG[err] : null;

  return (
    <>
      <Header title="Settings" back="/boss/me" />
      <Page>
        <form action={saveCompany} className="card space-y-4">
          <div className="text-lg font-bold">Your company</div>
          <Field label="Company name" hint="What workers see beside your name, and what goes on your invoices.">
            <input name="company" defaultValue={b?.company ?? ""} maxLength={80} required className="input" />
          </Field>
          <Field label="ABN (optional)" hint="Eleven digits. We check it before we keep it, and keep the digits only.">
            <input name="abn" defaultValue={b?.abn ?? ""} inputMode="numeric" maxLength={20} className="input num" />
          </Field>
          {wrong && <div className="say-red"><div className="font-bold">{wrong}</div></div>}
          {saved && !wrong && <Say tone="green" title="Saved." />}
          <button className="btn-dark">Save</button>
        </form>

        {process.env.VAPID_PUBLIC_KEY && <AlertsToggle publicKey={process.env.VAPID_PUBLIC_KEY} savedPush={savedPush} role="boss" />}
        <PasskeysSection userId={u.id} passkeys={passkeys} />
        <SessionsSection sessions={sessions} currentSid={u.sid} />

        <div className="card space-y-2">
          <div className="text-lg font-bold">The deal, in plain words</div>
          <p>You are the employer for every shift you post. Casual, at the Award rate or more. Super goes on top. The worker keeps the same hours record you do. You pay them your usual way, then tap <b>Mark paid</b>.</p>
        </div>
        <form action={logout}><button className="btn-ghost">Sign out</button></form>
      </Page>
    </>
  );
}
