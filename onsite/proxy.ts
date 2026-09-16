import { NextResponse, type NextRequest } from "next/server";
export function proxy(req: NextRequest) {
  const c = req.cookies;
  const demo = process.env.DEMO_CONSOLE === "1";           // the control room's frame cookies are sessions only while it's on
  const has = c.has("onsite_session") || (demo && (c.has("onsite_frame_boss") || c.has("onsite_frame_worker")));
  const p = req.nextUrl.pathname;
  if (!has && (p.startsWith("/boss") || p.startsWith("/worker") || p.startsWith("/onboarding")))
    return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}
export const config = { matcher: ["/boss/:path*", "/worker/:path*", "/onboarding"] };
