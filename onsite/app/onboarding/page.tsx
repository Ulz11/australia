import { getUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { completeOnboarding } from "@/actions/auth";
import { Brand } from "@/components/Brand";
import { RoleForm } from "./RoleForm";

export default async function Onboarding({ searchParams }: { searchParams: Promise<{ invite?: string; err?: string }> }) {
  const u = await getUser();
  if (!u) redirect("/login");
  if (u.role && u.name) redirect("/");
  const { invite, err } = await searchParams;
  return (
    <main className="max-w-md mx-auto p-6 pb-16">
      <Brand sub="Two questions and you are in." />
      <form action={completeOnboarding} className="mt-6 space-y-5">
        <RoleForm invite={invite} defaultRole={invite ? "worker" : undefined}
          error={err === "privacy" ? "Tick the box to agree to the privacy notice and the rules — we can't set up your account without it." : undefined} />
      </form>
    </main>
  );
}
