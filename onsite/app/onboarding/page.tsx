import { getUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { completeOnboarding } from "@/actions/auth";
import { Brand } from "@/components/Brand";
import { RoleForm } from "./RoleForm";

export default async function Onboarding({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
  const u = await getUser();
  if (!u) redirect("/login");
  if (u.role && u.name) redirect("/");
  const { invite } = await searchParams;
  return (
    <main className="max-w-md mx-auto p-6 pb-16">
      <Brand sub="Two questions and you are in." />
      <form action={completeOnboarding} className="mt-6 space-y-5">
        <RoleForm invite={invite} defaultRole={invite ? "worker" : undefined} />
      </form>
    </main>
  );
}
