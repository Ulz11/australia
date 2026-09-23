"use client";
import { useRef, useState, useTransition } from "react";
import { Check } from "lucide-react";
import { saveProfile, removePhoto } from "@/actions/worker";
import { TRADES, LANGUAGES } from "@/lib/profile";
import { Avatar, Field } from "@/components/ui";
import { useT } from "@/components/Lang";

/**
 * The profile a boss reads before he books you. Photo is taken on the phone and
 * shrunk to a small square in the browser, so there's no upload to wait for.
 */
export function ProfileCard({ p }: {
  p: { name: string; photo: string | null; years_exp: number | null; trades: string[]; languages: string[]; about: string | null };
}) {
  const [photo, setPhoto] = useState(p.photo);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [, start] = useTransition();
  const file = useRef<HTMLInputElement>(null);
  const t = useT();

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true); setErr(null);
    try {
      setPhoto(await squareJpeg(f, 256));
    } catch {
      setErr(t("Couldn't read that picture. Try another."));
    }
    setBusy(false);
  }

  return (
    <form action={async (fd) => { const r = await saveProfile(fd); if (r?.error) setErr(r.error); else { setSaved(true); setTimeout(() => setSaved(false), 2500); } }}
          className="card space-y-5">
      <input type="hidden" name="photo" value={photo ?? ""} />

      <div className="flex items-center gap-4">
        <Avatar name={p.name} photo={photo} size={96} />
        <div className="flex-1 space-y-2">
          <button type="button" className="btn-dark btn-sm w-full" disabled={busy} onClick={() => file.current?.click()}>
            {busy ? t("Working…") : photo ? t("Change photo") : t("Take a photo")}
          </button>
          {photo && (
            <button type="button" className="btn-ghost btn-sm w-full" onClick={() => start(async () => { setPhoto(null); await removePhoto(); })}>{t("Remove")}</button>
          )}
          <input ref={file} type="file" accept="image/*" capture="user" className="hidden" onChange={pick} />
        </div>
      </div>
      <p className="text-sm text-steel -mt-2">{t("A clear photo of your face, like a work ID. Bosses pick people they can recognise at the gate.")}</p>

      <Field label={t("Your name")}><input name="name" defaultValue={p.name} className="input" required /></Field>

      <Field label={t("Years on the tools")} hint={t("Roughly is fine.")}>
        <input name="years_exp" type="number" min={0} max={60} defaultValue={p.years_exp ?? 0} className="input w-32 num text-2xl font-extrabold text-center" />
      </Field>

      <Field label={t("What work can you do?")} hint={t("Tick everything you've actually done. This is what bosses search.")}>
        <div className="grid grid-cols-2 gap-2">
          {TRADES.map((trade) => (
            <label key={trade} className="cursor-pointer">
              <input type="checkbox" name="trades" value={trade} defaultChecked={p.trades.includes(trade)} className="peer sr-only" />
              <span className="chip justify-center w-full text-sm peer-checked:bg-ink peer-checked:text-white peer-checked:border-ink">{trade}</span>
            </label>
          ))}
        </div>
      </Field>

      <Field label={t("Languages you speak")} hint={t("Handy on a site where the foreman speaks your language.")}>
        <div className="grid grid-cols-3 gap-2">
          {LANGUAGES.map((l) => (
            <label key={l} className="cursor-pointer">
              <input type="checkbox" name="languages" value={l} defaultChecked={p.languages.includes(l)} className="peer sr-only" />
              <span className="chip justify-center w-full text-sm peer-checked:bg-ink peer-checked:text-white peer-checked:border-ink">{l}</span>
            </label>
          ))}
        </div>
      </Field>

      <Field label={t("Anything else? (optional)")} hint={t("One or two lines. Own tools, own car, early starts — that sort of thing.")}>
        <textarea name="about" defaultValue={p.about ?? ""} maxLength={400} rows={3}
          className="input py-3 min-h-[96px]" placeholder={t("10 years formwork. Own car and tools. Happy with early starts.")} />
      </Field>

      {err && <div className="say-red"><div className="font-bold">{err}</div></div>}
      <button className="btn-dark">{saved ? <><Check size={20} strokeWidth={2.5} aria-hidden />{t("Saved")}</> : t("Save my profile")}</button>
    </form>
  );
}

/** Crop to a centred square and shrink — keeps the photo small enough to store inline. */
async function squareJpeg(file: File, size: number): Promise<string> {
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = URL.createObjectURL(file);
  });
  const side = Math.min(img.width, img.height);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  URL.revokeObjectURL(img.src);
  for (const q of [0.8, 0.65, 0.5, 0.4]) {
    const url = c.toDataURL("image/jpeg", q);
    if (url.length < 110_000) return url;
  }
  return c.toDataURL("image/jpeg", 0.3);
}
