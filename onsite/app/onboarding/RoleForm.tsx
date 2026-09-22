"use client";
import { useState } from "react";
import Link from "next/link";
import { AddressPin } from "@/components/AddressPin";
import { Field } from "@/components/ui";
import { useT } from "@/components/Lang";

/** What a boss pays, handed down by the server page: the one price, as the billing code has it now. */
export type Pricing = { fee: string };

export function RoleForm({ invite, defaultRole, defaultName, pricing, error }: {
  invite?: string; defaultRole?: "boss" | "worker"; defaultName?: string; pricing: Pricing; error?: string;
}) {
  const [role, setRole] = useState<"boss" | "worker">(defaultRole ?? "worker");
  const t = useT();
  return (
    <>
      <Field label={t("Which one are you?")}>
        <div className="grid grid-cols-2 gap-2">
          {(["worker", "boss"] as const).map((r) => (
            <button key={r} type="button" onClick={() => setRole(r)}
              className={`rounded-2xl border-2 p-4 text-left min-h-[96px] ${role === r ? "border-ink bg-ink text-white" : "border-line bg-white"}`}>
              <div className="text-xl font-extrabold">{r === "worker" ? t("I want work") : t("I need workers")}</div>
              <div className={`${role === r ? "text-white/70" : "text-steel"}`}>{r === "worker" ? t("Worker") : t("Boss / subbie")}</div>
            </button>
          ))}
        </div>
        <input type="hidden" name="role" value={role} />
        {/* What being a boss costs, said before the account is made — not found later on an invoice. */}
        {role === "boss" && (
          <p className="text-steel mt-2">
            {pricing.fee} each time OnSite introduces you to a worker whose hours you approve. Invoiced every
            fortnight. Nothing else — no monthly fee, and nothing to cancel.
          </p>
        )}
      </Field>
      <Field label={t("Your name")} hint={defaultName ? t("A boss who put you on their crew list called you this. Change it if it's not right.") : undefined}>
        <input name="name" className="input" placeholder={t("First and last")} defaultValue={defaultName ?? ""} required />
      </Field>
      {role === "boss" ? (
        <>
          <Field label="Your company"><input name="company" className="input" maxLength={80} placeholder="e.g. Marrickville Formwork" /></Field>
          <Field label="ABN (optional)" hint="Eleven digits. We check it before we keep it, and keep the digits only.">
            <input name="abn" className="input num" inputMode="numeric" maxLength={20} placeholder="11 digits" />
          </Field>
        </>
      ) : (
        <>
          <Field label={t("Where do you live?")} hint={t("Type your suburb and press Find, or tap Use my location. We only show shifts near you.")}><AddressPin precision="suburb" /></Field>
          <Field label={t("Got an invite code from a mate? (optional)")}><input name="invite" className="input font-mono uppercase" defaultValue={invite ?? ""} placeholder="ABC123" /></Field>
        </>
      )}
      <label htmlFor="privacy" className="flex items-start gap-3 text-lg">
        <input id="privacy" type="checkbox" name="privacy" value="yes" required className="mt-1 h-6 w-6 shrink-0 accent-ink" />
        <span>
          {t("I agree to the")}{" "}
          <Link href="/privacy" target="_blank" className="font-bold underline">{t("privacy notice")}</Link>
          {" "}{t("and the")}{" "}
          <Link href="/terms" target="_blank" className="font-bold underline">{t("terms")}</Link>.
        </span>
      </label>
      {error && <p className="text-warn font-semibold">{error}</p>}
      <button className="btn-primary text-xl">{t("Done")}</button>
    </>
  );
}
