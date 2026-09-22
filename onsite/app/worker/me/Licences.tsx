"use client";
import { useState } from "react";
import { Plus } from "lucide-react";
import { saveLicence, removeLicence } from "@/actions/worker";
import { TICKETS } from "@/lib/award";
import { licenceWords, STATES, AUTO_KINDS, REGULATOR, canAutoCheck, type LicenceStatus } from "@/lib/verify";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Field, Flag } from "@/components/ui";
import { useT } from "@/components/Lang";
import { type T } from "@/lib/i18n";

export type Lic = {
  kind: string; number: string | null; issued_state: string | null; expires_on: string | null;
  status: LicenceStatus; checked_at: string | null; check_note: string | null;
};

export function Licences({ licences, name }: { licences: Lic[]; name: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const t = useT();
  const held = new Set(licences.map((l) => l.kind));
  const missing = Object.keys(TICKETS).filter((k) => !held.has(k));

  return (
    <div className="card space-y-3">
      <div>
        <div className="text-xl font-extrabold">{t("My cards")}</div>
        <div className="text-steel">{t("Put the numbers in once. Bosses see whether a card checks out — never the numbers.")}</div>
      </div>

      {licences.length === 0 && <div className="say-grey"><div className="font-bold">{t("No cards yet.")}</div><div className="say-sub">{t("Start with your White Card — nearly every shift needs it.")}</div></div>}

      {licences.map((l) => {
        const w = licenceWords(l);
        const tone = w.tone === "green" ? "border-go bg-go/5" : w.tone === "red" ? "border-warn bg-warn/5" : "border-line";
        return (
          <div key={l.kind} className={`rounded-2xl border-2 p-3 ${tone}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="text-lg font-bold min-w-0">{TICKETS[l.kind] ?? l.kind}</div>
              <Flag tone={w.tone} className="shrink-0">{w.label}</Flag>
            </div>
            {/* The number gets the full width: badge and card name share the line above it. */}
            <div className="text-steel num text-sm">
              {l.number ? t("No. {number}", { number: l.number }) : t("No number")}{l.issued_state ? ` · ${l.issued_state}` : ""}{l.expires_on ? ` · ${t("expires {date}", { date: l.expires_on })}` : ""}
            </div>
            <div className="text-sm text-steel mt-1">{l.check_note || w.detail}</div>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <button type="button" className="btn-ghost btn-sm w-full" onClick={() => setOpen(open === l.kind ? null : l.kind)}>{open === l.kind ? t("Close") : t("Edit")}</button>
              <RemoveBtn kind={l.kind} t={t} />
            </div>
            {open === l.kind && <Form kind={l.kind} existing={l} name={name} t={t} onDone={() => setOpen(null)} />}
          </div>
        );
      })}

      {missing.length > 0 && (
        <Field label={t("Add a card")}>
          <div className="grid grid-cols-2 gap-2">
            {missing.map((k) => (
              <button key={k} type="button" className={`chip justify-center gap-1.5 w-full text-sm ${open === k ? "chip-on" : ""}`} onClick={() => setOpen(open === k ? null : k)}>
                <Plus size={18} strokeWidth={2.5} aria-hidden className="shrink-0" />{TICKETS[k]}
              </button>
            ))}
          </div>
          {open && missing.includes(open) && <Form kind={open} name={name} t={t} onDone={() => setOpen(null)} />}
        </Field>
      )}

      {/* One sentence, one key. The <b> used to sit on "White Cards" alone, and a translation puts that
          phrase where its own grammar needs it — so the emphasis goes rather than pin the word order. */}
      <p className="text-sm text-steel">
        {t("We check NSW White Cards against the SafeWork register. Everything else we confirm by hand — until then a card shows as “not checked yet”. Always carry the real card on site.")}
      </p>
    </div>
  );
}

function RemoveBtn({ kind, t }: { kind: string; t: T }) {
  const card = TICKETS[kind] ?? kind;
  return (
    <ConfirmButton action={removeLicence.bind(null, kind)} className="btn-danger btn-sm w-full"
      title={t("Remove your {card}?", { card })}
      details={[
        t("The number you typed in is deleted from OnSite."),
        kind === "WC"
          ? t("Shifts still assume you hold a White Card — carry the real one on site.")
          : t("Shifts that need a {card} stop being offered to you.", { card }),
        t("You can put it back any time."),
      ]}
      confirmLabel={t("Remove the card")} cancelLabel={t("Keep it")}>{t("Remove")}</ConfirmButton>
  );
}

function Form({ kind, existing, name, t, onDone }: { kind: string; existing?: Lic; name: string; t: T; onDone: () => void }) {
  const [state, setState] = useState(existing?.issued_state ?? "NSW");
  const [msg, setMsg] = useState<string | null>(null);
  const auto = canAutoCheck(kind, state);
  // A regulator goes by its own name in every language. Only the fallback, for a state with none, is words.
  const reg = REGULATOR[state]?.name ?? t("the regulator");
  return (
    <form className="mt-3 space-y-3 border-t border-line pt-3"
      action={async (fd) => { const r = await saveLicence(fd); if (r?.error) setMsg(r.error); else { setMsg(r?.note ?? null); if (!r?.error) setTimeout(onDone, 1800); } }}>
      <input type="hidden" name="kind" value={kind} />
      <Field label={t("Card number")} hint={t("Exactly as printed on the front.")}>
        <input name="number" defaultValue={existing?.number ?? ""} className="input num" inputMode="text" required autoFocus />
      </Field>
      <Field label={t("Name on the card")}><input name="holder_name" defaultValue={name} className="input" /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("Issued in")}>
          <select name="issued_state" value={state} onChange={(e) => setState(e.target.value)} className="input">
            {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label={t("Expires (if shown)")}><input name="expires_on" type="date" defaultValue={existing?.expires_on ?? ""} className="input" /></Field>
      </div>
      <div className="say-grey text-sm">
        {/* The regulator was bold inside the sentence. It is a {gap} now, and a gap lands where each
            language puts it, so the whole line is one key and carries no markup through it. */}
        {auto
          ? t("We'll check this straight away against {reg}.", { reg })
          : (AUTO_KINDS as readonly string[]).includes(kind)
            ? t("{state} has no instant check yet — we'll confirm it with {reg} by hand and update the badge.", { state, reg })
            : t("This card isn't on an instant register — we'll confirm it with {reg} by hand and update the badge.", { reg })}
      </div>
      {msg && <div className="say-grey text-sm"><b>{msg}</b></div>}
      <button className="btn-primary">{t("Save card")}</button>
    </form>
  );
}
