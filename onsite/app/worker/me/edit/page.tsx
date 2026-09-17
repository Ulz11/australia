import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Section } from "@/components/ui";
import { ProfileCard } from "../ProfileCard";
import { Licences } from "../Licences";
export const dynamic = "force-dynamic";

/** Everything a boss reads before he books you, on its own screen. The record itself is /worker/me. */
export default async function EditProfile() {
  const u = await requireRole("worker");
  const [[w], licences] = await Promise.all([
    sql`SELECT photo, years_exp, trades, languages, about FROM workers WHERE user_id = ${u.id}`,
    sql`SELECT kind, number, issued_state, expires_on::text, status, checked_at::text, check_note FROM licences WHERE worker_id = ${u.id} ORDER BY kind`,
  ]);
  return (
    <>
      <Header title="Edit profile" back="/worker/me" />
      <Page>
        <Section title="My profile" hint="This is what a boss sees before he books you. Your visa and card numbers stay private." />
        <ProfileCard p={{ name: u.name!, photo: w.photo, years_exp: w.years_exp, trades: w.trades ?? [], languages: w.languages ?? [], about: w.about }} />
        <Licences licences={licences as never} name={u.name!} />
      </Page>
    </>
  );
}
