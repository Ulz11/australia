"use client";
import { useRef, useState } from "react";
import { ConfirmSheet } from "./ConfirmSheet";
import { useT } from "./Lang";

/**
 * A button that asks first. Same call sites as before (`action`, `msg`), but the question is now the app's
 * own sheet instead of the browser's confirm() box, and it can list what will actually happen.
 *
 * With JavaScript off the button submits the form straight away, exactly as it did before.
 */
export function ConfirmButton({
  action, children, className = "btn-danger", msg,
  title, details, confirmLabel, cancelLabel, danger = true,
}: {
  action: () => Promise<void>;
  children: React.ReactNode;
  className?: string;
  /** The old one-line question. Used as the title when no `title` is given, otherwise the line under it. */
  msg?: string;
  title?: string;
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const t = useT();
  return (
    <form action={action}>
      <button ref={trigger} className={className} onClick={(e) => { e.preventDefault(); setOpen(true); }}>{children}</button>
      <ConfirmSheet open={open} onClose={() => setOpen(false)} returnFocus={trigger} submit
        title={title ?? msg ?? t("Are you sure?")} msg={title && msg ? msg : undefined}
        details={details} confirmLabel={confirmLabel} cancelLabel={cancelLabel} danger={danger} />
    </form>
  );
}
