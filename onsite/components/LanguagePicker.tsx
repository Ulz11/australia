"use client";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Globe } from "lucide-react";
import { setLanguage } from "@/actions/lang";
import { LANGS, type Lang } from "@/lib/i18n";
import { useT } from "./Lang";

/**
 * Choosing a language. One sheet, two places it opens from: a row above the phone-number form on the login
 * screen, and "App language" in a worker's Settings. The list is in each language's own name — a list of
 * languages written in a language you can't read is no use to anybody.
 */
export function LanguagePicker({ current, variant = "row" }: { current: Lang; variant?: "row" | "bar" }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const trigger = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  const t = useT();

  const pick = (lang: Lang) => start(async () => {
    await setLanguage(lang);
    setOpen(false);
    router.refresh();
  });

  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}
        className={variant === "bar"
          ? "flex items-center gap-2 text-steel font-bold min-h-[44px]"
          : "card flex items-center gap-3 w-full text-left min-h-[64px]"}>
        <Globe size={variant === "bar" ? 20 : 22} strokeWidth={2.25} aria-hidden className="shrink-0" />
        {variant === "bar"
          ? <span>{LANGS[current]}</span>
          : <span className="flex-1 min-w-0">
              <span className="block text-lg font-bold leading-tight">{t("App language")}</span>
              <span className="block text-base text-steel mt-0.5">{LANGS[current]}</span>
            </span>}
      </button>
      {open && <Sheet current={current} pending={pending} onPick={pick} onClose={() => setOpen(false)} returnFocus={trigger} title={t("App language")} />}
    </>
  );
}

function Sheet({ current, pending, onPick, onClose, returnFocus, title }: {
  current: Lang; pending: boolean; onPick: (l: Lang) => void; onClose: () => void;
  returnFocus: React.RefObject<HTMLButtonElement | null>; title: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const back = returnFocus.current;
    if (!d.open) d.showModal();
    const html = document.documentElement;
    const scroll = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      html.style.overflow = scroll;
      if (d.open) d.close();
      if (back?.isConnected) back.focus();
    };
  }, [returnFocus]);

  return (
    <dialog ref={dialog} className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet-panel w-full sm:max-w-md max-h-full overflow-y-auto bg-white rounded-t-3xl sm:rounded-3xl border-t-2 sm:border-2 border-line p-5 space-y-4"
        style={{ paddingBottom: "max(1.25rem, calc(1.25rem + env(safe-area-inset-bottom)))" }}>
        <div aria-hidden className="sm:hidden mx-auto -mt-2 mb-1 h-1.5 w-12 rounded-full bg-line" />
        <h2 id={titleId} className="text-2xl font-extrabold leading-tight">{title}</h2>
        <ul className="rounded-2xl bg-site divide-y divide-line">
          {(Object.keys(LANGS) as Lang[]).map((code) => (
            <li key={code}>
              <button type="button" disabled={pending} onClick={() => onPick(code)}
                className="w-full text-left px-4 py-4 flex items-center gap-3 text-lg font-bold min-h-[56px]">
                <span className="flex-1 min-w-0" lang={code}>{LANGS[code]}</span>
                {code === current && <Check size={22} strokeWidth={2.5} aria-hidden className="shrink-0" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </dialog>
  );
}
