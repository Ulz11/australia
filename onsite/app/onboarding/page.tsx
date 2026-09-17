import { getUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { completeOnboarding } from "@/actions/auth";
import { Brand } from "@/components/Brand";
import { RoleForm } from "./RoleForm";

export default async function Onboarding({ searchParams }: { searchParams: Promise<{ invite?: string; err?: string }> }) {
  const u = await getUser();
  if (!u) redirect("/login");
  if (u.role && u.name) redirect("/");
  const { invite, err } = await searchParams;
  // A boss who typed this number into their crew list already knows two things about whoever is signing up:
  // they are a worker, and what they are called. Both are offered, and both can be changed.
  const code = (invite ?? "").trim().toUpperCase();
  const [inv] = await sql<{ name: string | null; from_boss: boolean }[]>`
    SELECT ci.name, true AS from_boss FROM crew_invites ci
    WHERE ci.phone = ${u.phone} AND ci.joined_at IS NULL AND ci.expires_at > now()
    ORDER BY ci.invited_at DESC LIMIT 1`;
  const [byCode] = code ? await sql`SELECT 1 FROM bosses WHERE invite_code = ${code}` : [];
  const invited = !!inv || !!byCode;
  return (
    <main className="max-w-md mx-auto p-6 pb-16">
      <Brand sub="Two questions and you are in." />
      <form action={completeOnboarding} className="mt-6 space-y-5">
        <RoleForm invite={invite} defaultRole={invite || invited ? "worker" : undefined} defaultName={inv?.name ?? undefined}
          error={err === "privacy" ? "Tick the box to agree to the privacy notice and the rules — we can't set up your account without it." : undefined} />
      </form>
    </main>
  );
}
