"use client";
import { useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { Check, Contact, Share2, X } from "lucide-react";
import { importCrew, previewCrew, textCrewInvites } from "@/actions/boss";
import { Flag, Say } from "@/components/ui";
import { MAX_IMPORT, crewShareText, type CrewImport, type CrewPreview } from "@/lib/crewWords";

/** Android Chrome's Contact Picker. Nothing else has it, so the button only exists where it does. */
type ContactPicker = { select: (props: string[], opts?: { multiple?: boolean }) => Promise<{ name?: string[]; tel?: string[] }[]> };
const picker = (): ContactPicker | null => {
  const c = (navigator as unknown as { contacts?: ContactPicker }).contacts;
  return c && typeof c.select === "function" ? c : null;
};

/**
 * Three steps, one screen: type the list, read what will happen, then send them the link. The preview is the
 * server's answer, not the browser's guess, and importCrew reads the same text again from scratch.
 */
export function AddCrew({ company, firstName, link, canText }: { company: string; firstName: string; link: string | null; canText: boolean }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<CrewPreview | null>(null);
  const [done, setDone] = useState<CrewImport | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // Read on the client only, and never on the server, so the button doesn't flash in and out on hydration.
  const contacts = useSyncExternalStore(() => () => {}, () => !!picker(), () => false);

  const pick = async () => {
    const c = picker();
    if (!c) return;
    try {
      const chosen = await c.select(["name", "tel"], { multiple: true });
      const lines = chosen.flatMap((p) => (p.tel ?? []).slice(0, 1).map((t) => `${(p.name ?? [])[0] ?? ""} ${t}`.trim()));
      if (lines.length) setText((cur) => (cur.trim() ? `${cur.trim()}\n` : "") + lines.join("\n"));
    } catch { /* they closed the picker */ }
  };

  const look = () => start(async () => { setNote(null); setPreview(await previewCrew(text)); });
  const add = () => start(async () => {
    const r = await importCrew(text);
    setDone(r);
    if (r.ok) { setPreview(null); setText(""); }
  });

  const share = async () => {
    if (!link) return;
    const message = crewShareText({ firstName, company }, link);
    if (navigator.share) {
      try { await navigator.share({ text: message }); return; } catch { /* sheet closed, or not allowed here */ }
    }
    try { await navigator.clipboard.writeText(message); setNote("Link copied. Paste it into your messages."); }
    catch { setNote(message); }
  };

  const text_ = () => start(async () => {
    const r = await textCrewInvites();
    setNote(r.ok ? (r.sent === 0 ? "Nobody left to text." : `Texted ${r.sent} ${r.sent === 1 ? "person" : "people"}.`) : r.error);
  });

  // ── Step 3: they're in. Now get them the link.
  if (done?.ok) {
    return (
      <div className="space-y-4">
        <Say tone="green" title={summary(done.added, done.invited)}
          sub={done.invited > 0 ? "They join your crew as soon as they sign up with that number." : undefined} />
        {done.invited > 0 && (
          <div className="card space-y-3">
            <div className="text-lg font-bold">Send them your link</div>
            <p className="text-steel">Whoever opens it and signs up lands straight on your crew list.</p>
            {link
              ? <button onClick={share} disabled={pending} className="btn-primary flex items-center justify-center gap-2"><Share2 size={22} strokeWidth={2.25} aria-hidden />Send them your link</button>
              : <p className="text-steel">No link yet — this site has no address set.</p>}
            {canText && <button onClick={text_} disabled={pending} className="btn-dark">{pending ? "Texting…" : "Text them for me"}</button>}
            {note && <p className="font-semibold break-words">{note}</p>}
            {link && <p className="text-sm text-steel break-all num">{link}</p>}
          </div>
        )}
        <Link href="/boss/workers" className="btn-ghost">Back to my workers</Link>
      </div>
    );
  }

  // ── Step 2: what will happen to each number.
  if (preview?.ok) {
    const adding = preview.rows.filter((r) => r.known).length;
    const inviting = preview.rows.length - adding;
    return (
      <div className="space-y-4">
        <div className="card divide-y divide-line -my-1">
          {preview.rows.map((r) => (
            <div key={r.phone} className="py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-bold truncate">{r.label}</div>
                <div className="text-sm text-steel">{r.known ? "On OnSite already — goes into your crew" : "Not on OnSite yet — we'll invite them"}</div>
              </div>
              <Flag tone={r.known ? "green" : "grey"} icon={r.known ? Check : null}>{r.known ? "Crew" : "Invite"}</Flag>
            </div>
          ))}
          {preview.dropped.map((d, i) => (
            <div key={`d${i}`} className="py-3 flex items-center gap-3 text-steel">
              <div className="flex-1 min-w-0 truncate">{d}</div>
              <Flag tone="grey" icon={X}>Not a mobile number</Flag>
            </div>
          ))}
        </div>
        {preview.overflowed && <p className="text-steel">That&apos;s more than {MAX_IMPORT} numbers. The first {MAX_IMPORT} are here — add the rest after.</p>}
        {preview.rows.length === 0
          ? <button onClick={() => setPreview(null)} className="btn-ghost">Back to the list</button>
          : <>
              <button onClick={add} disabled={pending} className="btn-primary">
                {pending ? "Adding…" : `Add ${preview.rows.length} ${preview.rows.length === 1 ? "person" : "people"}`}
              </button>
              <p className="text-steel text-sm">{adding > 0 && `${adding} go straight into your crew. `}{inviting > 0 && `${inviting} get an invite, kept for 90 days. Only you see these numbers.`}</p>
              <button onClick={() => setPreview(null)} className="btn-ghost">Change the list</button>
            </>}
      </div>
    );
  }

  // ── Step 1: the list.
  return (
    <div className="space-y-4">
      {done && !done.ok && <Say tone="red" title={done.error} />}
      {preview && !preview.ok && <Say tone="red" title={preview.error} />}
      <div className="card space-y-3">
        <div className="text-lg font-bold">Who&apos;s in your crew?</div>
        <p className="text-steel">One per line. Name first if you like: <span className="num">Batbayar 0412 345 678</span></p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} className="input font-mono text-base"
          placeholder={"Batbayar 0412 345 678\n0413 222 111\nNima 0400 111 222"} />
        {contacts && (
          <button onClick={pick} className="btn-ghost flex items-center justify-center gap-2">
            <Contact size={22} strokeWidth={2.25} aria-hidden />Pick from contacts
          </button>
        )}
        <button onClick={look} disabled={pending || !text.trim()} className="btn-dark">{pending ? "Checking…" : "See what happens"}</button>
        <p className="text-sm text-steel">Up to {MAX_IMPORT} numbers at a time. Nobody is charged for a worker you brought yourself.</p>
      </div>
    </div>
  );
}

const summary = (added: number, invited: number) => {
  const bits = [];
  if (added) bits.push(`${added} ${added === 1 ? "person is" : "people are"} in your crew`);
  if (invited) bits.push(`${invited} ${invited === 1 ? "invite" : "invites"} waiting`);
  return bits.join(" · ") || "Nothing to add";
};
