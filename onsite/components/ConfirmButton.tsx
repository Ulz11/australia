"use client";
export function ConfirmButton({ action, children, className = "btn-danger", msg = "Are you sure?" }:
  { action: () => Promise<void>; children: React.ReactNode; className?: string; msg?: string }) {
  return (
    <form action={action} onSubmit={(e) => { if (!confirm(msg)) e.preventDefault(); }}>
      <button className={className}>{children}</button>
    </form>
  );
}
