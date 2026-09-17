import { cookies, headers } from "next/headers";
import { cache } from "react";
import { getUser } from "../session";
import { LANG_COOKIE, fromAcceptLanguage, isLang, translate, type Lang, type T } from ".";

/**
 * Which language this request is in, and the dictionary for it. Server half of lib/i18n.
 *
 * The order, and why: the **cookie** first, because it is set the moment anyone picks a language and it is the
 * only thing a signed-out page has; then **users.lang**, so a worker who picked Mongolian on their phone gets
 * Mongolian on a new browser as soon as they sign in; then what the **browser asked for**; then English.
 *
 * A boss is always English — boss screens aren't translated this round, and half a translated screen is worse
 * than none. That also means every shared component reads its language from here and needs no opinion of its own.
 */
export const getLang = cache(async (): Promise<Lang> => {
  const u = await getUser();
  if (u?.role === "boss") return "en";
  const cookie = (await cookies()).get(LANG_COOKIE)?.value;
  if (isLang(cookie)) return cookie;
  if (u && isLang(u.lang)) return u.lang;
  try {
    return fromAcceptLanguage((await headers()).get("accept-language"));
  } catch {
    return "en";                                          // outside a request (scripts, tests)
  }
});

/** Only the language being read is ever loaded, so the other five never reach a page or a bundle. */
const DICTS: Record<Lang, () => Promise<{ default: Record<string, string> }>> = {
  en: () => import("./en"),
  mn: () => import("./mn"),
  ne: () => import("./ne"),
  pt: () => import("./pt"),
  es: () => import("./es"),
  zh: () => import("./zh"),
};

export const dictionary = cache(async (lang: Lang): Promise<Record<string, string>> => (await DICTS[lang]()).default);

/** `const t = await getT()` in a server component. Cached, so a page that asks twice loads one dictionary. */
export const getT = cache(async (): Promise<T> => {
  const dict = await dictionary(await getLang());
  return (key, vars) => translate(dict, key, vars);
});

/** For a body written for somebody else — a reminder to a worker whose language isn't the caller's. */
export async function tFor(lang: Lang): Promise<T> {
  const dict = await dictionary(lang);
  return (key, vars) => translate(dict, key, vars);
}
