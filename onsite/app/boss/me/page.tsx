import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Big } from "@/components/ui";
import { logout } from "@/actions/auth";
export const dynamic = "force-dynamic";
export default async function BossMe() {
  const u = await requireRole("boss");
  const [b] = await sql`SELECT b.company, b.abn, st.approved_count, st.approve_hours_avg, st.pay_days_avg FROM bosses b LEFT JOIN boss_stats st ON st.boss_id = b.user_id WHERE b.user_id = ${u.id}`;
  return (
    <>
      <Header title="Me" />
      <Page>
        <div className="card"><div className="text-xl font-extrabold">{u.name}</div><div className="text-steel">{b.company}{b.abn ? ` · ABN ${b.abn}` : ""}</div><div className="text-steel">{u.phone}</div></div>
        <div className="text-lg font-bold">What workers see about you</div>
        <div className="grid grid-cols-3 gap-2">
          <Big n={b.approved_count ?? 0} label="shifts approved" />
          <Big n={b.approve_hours_avg != null ? `${b.approve_hours_avg}h` : "—"} label="to approve hours" />
          <Big n={b.pay_days_avg != null ? `${b.pay_days_avg}d` : "—"} label="to pay" />
        </div>
        <div className="card space-y-2">
          <div className="text-lg font-bold">The deal, in plain words</div>
          <p>You are the employer for every shift you post. Casual, at the Award rate or more. Super goes on top. The worker keeps the same hours record you do. You pay them your usual way, then tap <b>Mark paid</b>.</p>
        </div>
        <form action={logout}><button className="btn-ghost">Sign out</button></form>
      </Page>
    </>
  );
}
