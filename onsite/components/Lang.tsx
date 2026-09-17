"use client";
import { createContext, useContext, useMemo } from "react";
import { LOCALES, translate, type Lang, type T } from "@/lib/i18n";

/**
 * The language a client component is in. The dictionary is handed down from a server component (the worker
 * layout, the login screen, onboarding), so only the language being read ever crosses the wire — and a client
 * component that isn't under a provider, which is every boss screen, gets English by falling back to its keys.
 */
const Ctx = createContext<{ lang: Lang; dict: Record<string, string> }>({ lang: "en", dict: {} });

export function LangProvider({ lang, dict, children }: { lang: Lang; dict: Record<string, string>; children: React.ReactNode }) {
  const value = useMemo(() => ({ lang, dict }), [lang, dict]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useT(): T {
  const { dict } = useContext(Ctx);
  return useMemo(() => (key: string, vars?: Record<string, string | number>) => translate(dict, key, vars), [dict]);
}

export const useLang = () => useContext(Ctx).lang;
export const useLocale = () => LOCALES[useContext(Ctx).lang];
