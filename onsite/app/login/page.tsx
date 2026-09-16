import { Brand } from "@/components/Brand";
import { LoginForm } from "./LoginForm";
import { getUser } from "@/lib/session";
import { devShowOtpOn } from "@/lib/flags";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function Login({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
  const u = await getUser();
  if (u) redirect("/");
  const { invite } = await searchParams;
  return (
    <main className="min-h-screen flex flex-col justify-end max-w-md mx-auto p-6 pb-10">
      <Brand sub="Construction shifts. Post one, take one, clock in, get paid." />
      <div className="mt-8"><LoginForm invite={invite} /></div>
      {devShowOtpOn()
        ? <p className="text-steel mt-6"><b className="text-ink">This is a demo.</b> Your sign-in code shows on screen instead of by text, so anyone who types your number can open your account. Don&apos;t enter anything you wouldn&apos;t want others to see, like your visa type or card numbers.</p>
        : <p className="text-steel mt-6">No password. We text you a code.</p>}
      <p className="text-steel mt-2"><Link href="/privacy" className="underline">How we handle your information</Link></p>
    </main>
  );
}
