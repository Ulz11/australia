import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, renewSession, sessionCookie } from "@/lib/session";

/**
 * Keeps a signed-in browser signed in (lib/session.ts). A Server Component can't set a cookie and there is no
 * proxy, so components/SessionRefresh.tsx calls this from the boss and worker layouts, at most every 6 hours.
 *
 *  - a valid session more than a day old, for a user who still exists → re-issued for another year, 204
 *  - a valid, younger session → left alone, 204
 *  - no session, a forged or expired one, or a deleted user → cookie cleared, 401
 *
 * Only `onsite_session` is read or written. The control room's frame cookies are scoped to /boss and /worker, so
 * the browser never sends them here, and this route never touches them.
 */
export async function POST(req: NextRequest) {
  const r = await renewSession(req.cookies.get(SESSION_COOKIE)?.value);
  const res = new NextResponse(null, { status: r ? 204 : 401 });
  if (!r) res.cookies.delete(SESSION_COOKIE);
  else if (r.renewed) res.cookies.set(sessionCookie(r.token));
  return res;
}
