"use server";
import { cookies } from "next/headers";
import { sql } from "@/lib/db";
import { createSession, getUser } from "@/lib/session";
import { LANG_COOKIE, LANG_COOKIE_DAYS, isLang } from "@/lib/i18n";

/**
 * Pick a language. Works signed out — the login screen is the first place anyone meets it — so this checks
 * who is calling rather than demanding a role, and only ever writes the caller's own row.
 *
 * The cookie is always set, because a logged-out page has nothing else to read. `users.lang` is set too when
 * there is an account, so the same person gets their language on a new phone the moment they sign in; the
 * session is re-issued because the token carries it.
 */
export async function setLanguage(lang: string) {
  const u = await getUser();
  if (!isLang(lang)) return;
  (await cookies()).set({
    name: LANG_COOKIE, value: lang, path: "/", maxAge: LANG_COOKIE_DAYS * 24 * 60 * 60,
    sameSite: "lax", httpOnly: false, secure: process.env.NODE_ENV === "production",
  });
  if (!u) return;
  await sql`UPDATE users SET lang = ${lang} WHERE id = ${u.id}`;
  await createSession(u.id);
}
