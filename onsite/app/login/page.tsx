import { Brand } from "@/components/Brand";
import { LoginForm } from "./LoginForm";
import { getUser } from "@/lib/session";
import { devShowOtpOn } from "@/lib/flags";
import { relyingParty } from "@/lib/passkeys";
import { redirect } from "next/navigation";
import Link from "next/link";
import { LangProvider } from "@/components/Lang";
import { LanguagePicker } from "@/components/LanguagePicker";
import { dictionary, getLang, getT } from "@/lib/i18n/server";

export default async function Login({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
  const u = await getUser();
  if (u) redirect("/");
  const { invite } = await searchParams;
  const rp = relyingParty();                          // null: no Face ID button, the page is as it always was
  // The first screen anyone sees, so the language row is on it: nobody should have to read English to find
  // out that they don't have to read English.
  const [lang, t] = await Promise.all([getLang(), getT()]);
  const dict = await dictionary(lang);
  return (
    <LangProvider lang={lang} dict={dict}>
      <main className="min-h-screen flex flex-col justify-end max-w-md mx-auto p-6 pb-10">
        <Brand sub={t("Construction shifts. Post one, take one, clock in, get paid.")} />
        <div className="mt-8 flex justify-end"><LanguagePicker current={lang} variant="bar" /></div>
        <div className="mt-2"><LoginForm invite={invite} demo={devShowOtpOn()} passkeys={rp && { origin: rp.origin, rpID: rp.rpID }} /></div>
        {devShowOtpOn()
          ? <p className="text-steel mt-6"><b className="text-ink">{t("This is a demo.")}</b> {t("Your sign-in code shows on screen instead of by text, so anyone who types your number can open your account. Don't enter anything you wouldn't want others to see, like your visa type or card numbers.")}</p>
          : <p className="text-steel mt-6">{t("No password. We text you a code.")}</p>}
        <p className="text-steel mt-2">
          <Link href="/privacy" className="underline">{t("How we handle your information")}</Link>
          {" · "}
          <Link href="/terms" className="underline">{t("The rules")}</Link>
        </p>
      </main>
    </LangProvider>
  );
}
