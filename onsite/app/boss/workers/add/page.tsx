import { requireRole } from "@/lib/session";
import { sql } from "@/lib/db";
import { Header, Page } from "@/components/Header";
import { smsProvider } from "@/lib/sms";
import { crewJoinUrl } from "@/lib/crew";
import { AddCrew } from "./AddCrew";
export const dynamic = "force-dynamic";

/**
 * "Add your crew": paste or pick the numbers, see what will happen to each one, then send them the link.
 * Only the boss who typed a number ever sees it.
 */
export default async function AddCrewPage() {
  const u = await requireRole("boss");
  const [me] = await sql<{ company: string; invite_code: string | null }[]>`SELECT company, invite_code FROM bosses WHERE user_id = ${u.id}`;
  const base = (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return (
    <>
      <Header title="Add your crew" back="/boss/workers" />
      <Page>
        <AddCrew
          company={me?.company ?? ""}
          firstName={(u.name ?? "").split(" ")[0]}
          link={base && me?.invite_code ? crewJoinUrl(base, me.invite_code) : null}
          canText={!!smsProvider().provider}
        />
      </Page>
    </>
  );
}
