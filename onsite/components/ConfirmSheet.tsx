"use client";
import { useEffect, useId, useRef } from "react";
import { useFormStatus } from "react-dom";
import { TriangleAlert, type LucideIcon } from "lucide-react";

export type ConfirmSheetProps = {
  open: boolean;
  onClose: () => void;
  /** The question, in one line. */
  title: string;
  /** One line under the question, when the title needs a little more. */
  msg?: string;
  /** What will actually happen, a line each — built from real data, not a warning in general. */
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button (something is destroyed or someone is told). Off for a plain "are you sure". */
  danger?: boolean;
  icon?: LucideIcon | null;
  /** Inside a form: the confirm button submits it, so the server action runs exactly as it does with JavaScript off. */
  submit?: boolean;
  onConfirm?: () => void;
  /** Where the focus goes back to when the sheet closes. */
  returnFocus?: React.RefObject<HTMLElement | null>;
};

/**
 * The app's own "are you sure": a sheet at the bottom of the phone, a card in the middle of a wide screen.
 * It replaces the browser's confirm() box, which can't say what will happen, can't be read in plain words,
 * and looks like a scam on a phone.
 *
 * Nothing here is needed for the action to work: with JavaScript off the trigger submits its form as before.
 */
export function ConfirmSheet({
  open, onClose, title, msg, details, confirmLabel = "Yes, do it", cancelLabel = "Keep it",
  danger = true, icon, submit, onConfirm, returnFocus,
}: ConfirmSheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const Icon = icon === null ? null : icon ?? (danger ? TriangleAlert : undefined);

  useEffect(() => {
    const d = dialog.current;
    if (!d || !open) return;
    const back = returnFocus?.current ?? (document.activeElement as HTMLElement | null);
    if (!d.open) d.showModal();
    keep.current?.focus();                                   // the safe button, not the red one
    const html = document.documentElement;
    const scroll = html.style.overflow;
    html.style.overflow = "hidden";                          // the page behind doesn't scroll
    return () => {
      html.style.overflow = scroll;
      if (d.open) d.close();
      if (back?.isConnected) back.focus();
    };
  }, [open, returnFocus]);

  return (
    <dialog ref={dialog} className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}                       // Escape
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>         {/* tap the dim */}
      <div className="sheet-panel w-full sm:max-w-md max-h-full overflow-y-auto bg-white rounded-t-3xl sm:rounded-3xl border-t-2 sm:border-2 border-line p-5 space-y-4"
        style={{ paddingBottom: "max(1.25rem, calc(1.25rem + env(safe-area-inset-bottom)))" }}>
        <div aria-hidden className="sm:hidden mx-auto -mt-2 mb-1 h-1.5 w-12 rounded-full bg-line" />
        <div className="flex items-start gap-3">
          {Icon && <Icon size={26} strokeWidth={2.25} aria-hidden className={`shrink-0 mt-0.5 ${danger ? "text-warn" : "text-ink"}`} />}
          <div className="min-w-0">
            <h2 id={titleId} className="text-2xl font-extrabold leading-tight">{title}</h2>
            {msg && <p className="text-steel mt-1">{msg}</p>}
          </div>
        </div>

        {details && details.length > 0 && (
          <ul className="rounded-2xl bg-site divide-y divide-line">
            {details.map((d, i) => <li key={i} className="px-4 py-3 leading-snug">{d}</li>)}
          </ul>
        )}

        <Buttons keepRef={keep} confirmLabel={confirmLabel} cancelLabel={cancelLabel} danger={danger}
          submit={submit} onConfirm={onConfirm} onClose={onClose} />
      </div>
    </dialog>
  );
}

/** Inside the form, so it knows when the action it submitted has finished and the sheet can go. */
function Buttons({ keepRef, confirmLabel, cancelLabel, danger, submit, onConfirm, onClose }: {
  keepRef: React.RefObject<HTMLButtonElement | null>; confirmLabel: string; cancelLabel: string;
  danger: boolean; submit?: boolean; onConfirm?: () => void; onClose: () => void;
}) {
  const { pending } = useFormStatus();
  const was = useRef(false);
  useEffect(() => {
    if (pending) was.current = true;
    else if (was.current) { was.current = false; onClose(); }
  }, [pending, onClose]);

  return (
    <div className="space-y-2">
      <button type={submit ? "submit" : "button"} disabled={pending}
        onClick={submit ? undefined : () => { onConfirm?.(); onClose(); }}
        className={danger ? "btn-destroy" : "btn-primary"}>
        {pending ? "Working…" : confirmLabel}
      </button>
      <button ref={keepRef} type="button" className="btn-ghost" disabled={pending} onClick={onClose}>{cancelLabel}</button>
    </div>
  );
}
