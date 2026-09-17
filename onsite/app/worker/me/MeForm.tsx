"use client";
import { useState } from "react";
import { updateMe } from "@/actions/worker";
import { AddressPin } from "@/components/AddressPin";
import { Field } from "@/components/ui";
import { useT } from "@/components/Lang";

export function MeForm({ name, radius, visa, home }: { name: string; radius: number; tickets?: string[]; visa: string | null; home: { lat: number; lng: number; label: string } | null }) {
  const [r, setR] = useState(radius);
  const [editHome, setEditHome] = useState(!home);
  const t = useT();
  return (
    <form action={updateMe} className="card space-y-5">
      <Field label={t("How far will you travel? {n} km", { n: r })} hint={t("Shifts further than this are never shown to you.")}>
        <input type="range" name="radius_km" min={5} max={100} step={5} value={r} onChange={(e) => setR(Number(e.target.value))} className="w-full h-3 accent-ink" />
      </Field>
      <Field label={t("Where you live")}>
        {editHome ? <AddressPin initial={home} precision="suburb" /> : (
          <div className="flex items-center justify-between gap-2">
            <div className="text-lg">{home?.label || t("Pinned on the map")}</div>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setEditHome(true)}>{t("Change")}</button>
          </div>
        )}
      </Field>
      {/* The visa list is display-only and never checked, so the words are the ones on the visa itself. */}
      <Field label={t("Visa (optional)")} hint={t("Private — bosses don't see this. Nothing is checked.")}>
        <select name="visa_type" defaultValue={visa ?? ""} className="input">
          <option value="">{t("Prefer not to say")}</option><option>Citizen / PR</option><option>Working Holiday (417/462)</option><option>Student (500)</option><option>Other with work rights</option>
        </select>
      </Field>
      <input type="hidden" name="name" value={name} />
      <button className="btn-dark">{t("Save")}</button>
    </form>
  );
}
