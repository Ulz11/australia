"use client";
import { useState } from "react";
import Link from "next/link";
import { AddressPin } from "@/components/AddressPin";
import { Field } from "@/components/ui";

export function RoleForm({ invite, defaultRole, defaultName, error }: { invite?: string; defaultRole?: "boss" | "worker"; defaultName?: string; error?: string }) {
  const [role, setRole] = useState<"boss" | "worker">(defaultRole ?? "worker");
  return (
    <>
      <Field label="Which one are you?">
        <div className="grid grid-cols-2 gap-2">
          {(["worker", "boss"] as const).map((r) => (
            <button key={r} type="button" onClick={() => setRole(r)}
              className={`rounded-2xl border-2 p-4 text-left min-h-[96px] ${role === r ? "border-ink bg-ink text-white" : "border-line bg-white"}`}>
              <div className="text-xl font-extrabold">{r === "worker" ? "I want work" : "I need workers"}</div>
              <div className={`${role === r ? "text-white/70" : "text-steel"}`}>{r === "worker" ? "Worker" : "Boss / subbie"}</div>
            </button>
          ))}
        </div>
        <input type="hidden" name="role" value={role} />
        {/* What being a boss costs, said before the account is made — not found later on an invoice. */}
        {role === "boss" && (
          <p className="text-steel mt-2">
            Free for 3 days, then $33 a month for the pay tools — cancel any time. $2 each time OnSite
            finds you a new worker, charged when you approve their first shift.
          </p>
        )}
      </Field>
      <Field label="Your name" hint={defaultName ? "A boss who put you on their crew list called you this. Change it if it's not right." : undefined}>
        <input name="name" className="input" placeholder="First and last" defaultValue={defaultName ?? ""} required />
      </Field>
      {role === "boss" ? (
        <>
          <Field label="Your company"><input name="company" className="input" placeholder="e.g. Marrickville Formwork" /></Field>
          <Field label="ABN (optional)"><input name="abn" className="input" inputMode="numeric" placeholder="11 digits" /></Field>
        </>
      ) : (
        <>
          <Field label="Where do you live?" hint="Type your suburb and press Find, or tap Use my location. We only show shifts near you."><AddressPin precision="suburb" /></Field>
          <Field label="Got an invite code from a mate? (optional)"><input name="invite" className="input font-mono uppercase" defaultValue={invite ?? ""} placeholder="ABC123" /></Field>
        </>
      )}
      <label htmlFor="privacy" className="flex items-start gap-3 text-lg">
        <input id="privacy" type="checkbox" name="privacy" value="yes" required className="mt-1 h-6 w-6 shrink-0 accent-ink" />
        <span>I agree to the <Link href="/privacy" target="_blank" className="font-bold underline">privacy notice</Link> and the <Link href="/terms" target="_blank" className="font-bold underline">terms</Link>.</span>
      </label>
      {error && <p className="text-warn font-semibold">{error}</p>}
      <button className="btn-primary text-xl">Done</button>
    </>
  );
}
