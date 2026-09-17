import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { demoConsoleOn } from "@/lib/flags";
import { signSession, FRAME_COOKIES } from "@/lib/session";
import { normalisePhone } from "@/lib/sms";

/**
 * Signs a demo user into one control-room frame. Deliberately narrow:
 *  - only when DEMO_CONSOLE=1, and never on a Vercel production deployment (lib/flags.ts)
 *  - only seeded demo accounts (phones starting +6140000)
 *  - the cookie is scoped to /boss or /worker, so it can't leak into the other frame
 */
export async function GET(req: Request) {
  if (!demoConsoleOn()) return new Response("Control room is off. Set DEMO_CONSOLE=1.", { status: 404 });
  const url = new URL(req.url);
  const frame = url.searchParams.get("frame") === "boss" ? "boss" : "worker";
  const phone = normalisePhone(url.searchParams.get("phone") ?? "");
  if (!phone || !phone.startsWith("+6140000")) return new Response("demo accounts only", { status: 400 });
  const [u] = await sql`SELECT id, role FROM users WHERE phone = ${phone} AND role = ${frame}`;
  if (!u) return new Response("no such demo user for that frame", { status: 404 });
  const token = await signSession(u.id, { via: "code", label: "Control room", ttl: "1d" });                          // as long as the frame cookie, not a year
  if (!token) return new Response("no such demo user for that frame", { status: 404 });   // the row went away mid-request
  const res = NextResponse.redirect(new URL(`/${frame}`, req.url), 303);
  res.cookies.set(FRAME_COOKIES[frame], token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: `/${frame}`, maxAge: 60 * 60 * 24 });
  return res;
}
