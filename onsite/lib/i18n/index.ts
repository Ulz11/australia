/**
 * The worker side of OnSite in the languages workers actually tick on their profiles. Client-safe: no
 * database, no node built-ins. The server half (which language is this request, and loading the dictionary)
 * is lib/i18n/server.ts; the client half is components/Lang.tsx.
 *
 * English is the key. `t("Take it")` is the English string, so a screen still reads as English in the source
 * and a missing translation falls back to it rather than to a code nobody can read.
 *
 * Boss screens stay English this round, so `getLang()` answers "en" for a boss whatever the cookie says.
 */

/** Each language in its own name — the only way a list of languages is any use to the person reading it. */
export const LANGS = {
  en: "English",
  mn: "Монгол",
  ne: "नेपाली",
  pt: "Português",
  es: "Español",
  zh: "中文",
} as const;

export type Lang = keyof typeof LANGS;
export const LANG_CODES = Object.keys(LANGS) as Lang[];
export const isLang = (v: unknown): v is Lang => typeof v === "string" && (LANG_CODES as string[]).includes(v);

/** Read by logged-out pages, written whenever anyone picks a language. Not httpOnly: nothing secret in it. */
export const LANG_COOKIE = "onsite_lang";
export const LANG_COOKIE_DAYS = 400;

/** What Intl should call each one. Dates on a translated screen are formatted with these, in Sydney time. */
export const LOCALES: Record<Lang, string> = {
  en: "en-AU", mn: "mn-MN", ne: "ne-NP", pt: "pt-BR", es: "es-ES", zh: "zh-CN",
};

/** `{name}` and friends, filled in after the lookup so a translation can put them wherever its grammar needs. */
export function translate(dict: Record<string, string>, key: string, vars?: Record<string, string | number>): string {
  let out = dict[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

export type T = (key: string, vars?: Record<string, string | number>) => string;

/**
 * One or many. Languages differ on where the line falls and on what changes, so both forms are their own
 * English key and the translation decides what to do with each — this only picks which one to ask for.
 */
export const plural = (t: T, n: number, one: string, many: string, vars?: Record<string, string | number>) =>
  t(n === 1 ? one : many, { n, ...vars });

/**
 * The language a browser asked for, when nobody has chosen one yet: the first of its preferences OnSite has,
 * matched on the base code ("pt-BR" and "pt-PT" are both Portuguese here). English when nothing matches.
 */
export function fromAcceptLanguage(header: string | null | undefined): Lang {
  for (const part of String(header ?? "").split(",")) {
    const tag = part.split(";")[0].trim().toLowerCase();
    if (!tag) continue;
    const base = tag.split("-")[0];
    if (isLang(base)) return base;
  }
  return "en";
}

/** A date on a translated screen: the reader's language, always Sydney's day. */
export const TZ_SYDNEY = "Australia/Sydney";
