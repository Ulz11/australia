import { getUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { completeOnboarding } from "@/actions/auth";
import { Brand } from "@/components/Brand";
import { RoleForm } from "./RoleForm";
import { LangProvider } from "@/components/Lang";
import { dictionary, getLang, getT } from "@/lib/i18n/server";
import { matchFeeCents, priceWords } from "@/lib/subscription";

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
  // Whatever language was chosen on the login screen carries straight through to here.
  const [lang, t] = await Promise.all([getLang(), getT()]);
  const dict = await dictionary(lang);
  // What being a boss costs, read from the same setting the billing code charges from — never typed into the form.
  // It is one number now: there is no trial to count down and no monthly fee to name.
  const pricing = { fee: priceWords(matchFeeCents()) };
  const error = err === "privacy" ? t("Tick the box to agree to the privacy notice and the rules — we can't set up your account without it.")
    : err === "abn" ? "That ABN doesn't check out. Eleven digits, exactly as it is registered — or leave it blank."
    : undefined;
  return (
    <LangProvider lang={lang} dict={dict}>
      <main className="max-w-md mx-auto p-6 pb-16">
        <Brand sub={t("Two questions and you are in.")} />
        <form action={completeOnboarding} className="mt-6 space-y-5">
          <RoleForm invite={invite} defaultRole={err === "abn" ? "boss" : invite || invited ? "worker" : undefined} defaultName={inv?.name ?? undefined}
            pricing={pricing} error={error} />
        </form>
      </main>
    </LangProvider>
  );
}
