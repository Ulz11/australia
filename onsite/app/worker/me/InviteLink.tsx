"use client";
import { useState } from "react";
import { Check } from "lucide-react";
import { useT } from "@/components/Lang";
import { plural } from "@/lib/i18n";

/**
 * A worker's own link, and the mates who took it. The share text goes out in the sender's language, not
 * the reader's — a Mongolian labourer sends it to Mongolian mates, and a link nobody can read is a link
 * nobody taps. OnSite and Award stay in English inside it: they are the names on the screens either way.
 */
export function InviteLink({ url, code, mates }: { url: string; code: string; mates: { name: string; done: number }[] }) {
  const [done, setDone] = useState(false);
  const t = useT();
  async function share() {
    const text = t("Join me on OnSite — construction shifts near you, Award rate or better. {url}", { url });
    if (navigator.share) { try { await navigator.share({ text, url }); } catch { /* they closed the sheet */ } }
    else {
      try { await navigator.clipboard.writeText(url); setDone(true); setTimeout(() => setDone(false), 2000); }
      catch { /* the clipboard is off here: the code is printed just below */ }
    }
  }
  return (
    <div className="card space-y-2">
      <div className="text-lg font-bold">{t("Got a mate who wants work?")}</div>
      <button type="button" onClick={share} className="btn-dark">{done ? <><Check size={20} strokeWidth={2.5} aria-hidden />{t("Link copied")}</> : t("Send them my link")}</button>
      <div className="text-sm text-steel">{t("Or tell them your code:")} <b className="font-mono text-ink text-base">{code}</b></div>
      {mates.length > 0 && <div className="pt-1">{mates.map((m) => <div key={m.name} className="flex justify-between py-1.5 border-t border-line"><span>{m.name}</span><span className="text-steel">{plural(t, m.done, "{n} shift", "{n} shifts")}</span></div>)}</div>}
    </div>
  );
}
