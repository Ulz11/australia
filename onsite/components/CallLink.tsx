"use client";
export function CallLink({ phone, name, onCall, className = "btn-ghost" }: { phone: string; name?: string; onCall?: () => Promise<void>; className?: string }) {
  return (
    <a href={`tel:${phone}`} onClick={() => onCall?.()} className={className}>
      📞 {name ? `Call ${name.split(" ")[0]}` : phone}
    </a>
  );
}
