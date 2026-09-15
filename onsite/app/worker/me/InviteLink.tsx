"use client";
import { useState } from "react";
export function InviteLink({ url, code, mates }: { url: string; code: string; mates: { name: string; done: number }[] }) {
  const [done, setDone] = useState(false);
  async function share() {
    const text = `Join me on OnSite — construction shifts near you, Award rate or better. ${url}`;
    if (navigator.share) { try { await navigator.share({ text, url }); } catch {} }
    else { await navigator.clipboard.writeText(url); setDone(true); setTimeout(() => setDone(false), 2000); }
  }
  return (
    <div className="card space-y-2">
      <div className="text-lg font-bold">Got a mate who wants work?</div>
      <button type="button" onClick={share} className="btn-dark">{done ? "Link copied ✓" : "Send them my link"}</button>
      <div className="text-sm text-steel">Or tell them your code: <b className="font-mono text-ink text-base">{code}</b></div>
      {mates.length > 0 && <div className="pt-1">{mates.map((m) => <div key={m.name} className="flex justify-between py-1.5 border-t border-line"><span>{m.name}</span><span className="text-steel">{m.done} shift{m.done === 1 ? "" : "s"}</span></div>)}</div>}
    </div>
  );
}
