"use client";
import { useState } from "react";
import { removeCrewInvite } from "@/actions/boss";
import { ConfirmButton } from "@/components/ConfirmButton";
import { crewLabel, crewShareText } from "@/lib/crewWords";
import { ago } from "@/lib/util";

export type InviteRow = { id: string; phone: string; name: string | null; invited_at: string | Date };

/**
 * The numbers this boss typed in that haven't signed up yet. "Share again" hands them the same link, through
 * the phone's own share sheet where there is one and the clipboard where there isn't — the boss sends it from
 * their own number, so nothing here texts anybody.
 */
export function InvitedCrew({ invites, link, company, firstName }: {
  invites: InviteRow[]; link: string | null; company: string; firstName: string;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const text = link ? crewShareText({ firstName, company }, link) : "";

  const share = async (id: string) => {
    if (!link) return;
    setCopied(null);
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch { /* they closed the sheet, or it isn't allowed here */ }
    }
    try { await navigator.clipboard.writeText(text); setCopied(id); } catch { setCopied(null); }
  };

  return (
    <ul className="card divide-y divide-line -my-1">
      {invites.map((i) => (
        <li key={i.id} className="py-3 flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <div className="font-bold truncate">{crewLabel(i)}</div>
            <div className="text-sm text-steel">Invited {ago(i.invited_at)}{copied === i.id ? " · Link copied" : ""}</div>
          </div>
          {link && <button onClick={() => share(i.id)} className="btn-ghost btn-sm shrink-0">Share again</button>}
          <ConfirmButton action={removeCrewInvite.bind(null, i.id)} className="btn-ghost btn-sm shrink-0"
            title={`Take ${crewLabel(i)} off the list?`}
            details={["We stop keeping that number.", "If they sign up later they won't land in your crew."]}
            confirmLabel="Yes, remove" cancelLabel="Keep it">Remove</ConfirmButton>
        </li>
      ))}
    </ul>
  );
}
