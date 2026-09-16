import { bearerToken, renewSession, tokenExpiresAt } from "@/lib/session";
import { fail, json, preflight } from "@/lib/apiJson";

/**
 * Swap a working token for a fresh one, good for another year, so an app in daily use never asks for a new code.
 * Bearer only — no cookie fallback. Always re-signs (from the current user row, so name and role are current).
 * 401 for a missing, forged or expired token, or a user who no longer exists: the app should sign in again.
 */
export async function POST(req: Request) {
  const r = await renewSession(bearerToken(req.headers.get("authorization")), 0);
  if (!r) return fail(req, 401, "Sign in again.");
  return json(req, { token: r.token, expires_at: tokenExpiresAt(r.token).toISOString() });
}

export const OPTIONS = preflight;
