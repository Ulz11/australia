/**
 * What OnSite calls the thing someone is using, in plain words, from its user agent. One phone can hold a
 * passkey and a session, and both are listed on Me under the same name — so the naming lives here, on its
 * own, and lib/passkeys.ts and lib/session.ts both read it (nothing else in this file, so a page that only
 * needs a label doesn't pull in the WebAuthn library).
 */

/** An iPad asks for the desktop site, so its touch screen gives it away. */
export function deviceLabel(ua: string, hints: { touch?: boolean } = {}): string {
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && hints.touch)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux computer";
  return "Phone or computer";
}
