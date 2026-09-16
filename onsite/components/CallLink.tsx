"use client";
import { Phone } from "lucide-react";
export function CallLink({ phone, name, onCall, className = "btn-ghost" }: { phone: string; name?: string; onCall?: () => Promise<void>; className?: string }) {
  return (
    <a href={`tel:${phone}`} onClick={() => onCall?.()} className={className}>
      <Phone size={20} strokeWidth={2.25} aria-hidden className="shrink-0" />
      {name ? `Call ${name.split(" ")[0]}` : phone}
    </a>
  );
}
