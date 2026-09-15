import { NextResponse, type NextRequest } from "next/server";
export function middleware(req: NextRequest) {
  const c = req.cookies;
  const has = c.has("onsite_session") || c.has("onsite_frame_boss") || c.has("onsite_frame_worker");
  const p = req.nextUrl.pathname;
  if (!has && (p.startsWith("/boss") || p.startsWith("/worker") || p.startsWith("/onboarding")))
    return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}
export const config = { matcher: ["/boss/:path*", "/worker/:path*", "/onboarding"] };
