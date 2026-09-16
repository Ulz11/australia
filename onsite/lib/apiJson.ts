import { NextResponse } from "next/server";

/**
 * A native app is not a browser and never sends an Origin, so the API needs no CORS in
 * production. `expo start --web` does though — it serves the app from :8081 and calls
 * :3000 — and being able to drive the real app in a browser is worth a lot during
 * development. So the headers go out in development only, and never in production.
 */
const dev = () => process.env.NODE_ENV !== "production";

function withCors(res: NextResponse, origin: string | null): NextResponse {
  if (!dev() || !origin) return res;
  res.headers.set("access-control-allow-origin", origin);
  res.headers.set("vary", "origin");
  res.headers.set("access-control-allow-headers", "content-type, authorization");
  res.headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  return res;
}

export const json = (req: Request, data: unknown, status = 200) =>
  withCors(NextResponse.json(data, { status }), req.headers.get("origin"));

/** The one error shape every /api/v1 route returns, so the app has one thing to read. */
export const fail = (req: Request, status: number, error: string) => json(req, { error }, status);

/** Pre-flight. Dev only — in production this answers 404 like any route that isn't there. */
export const preflight = (req: Request) =>
  dev()
    ? withCors(new NextResponse(null, { status: 204 }) as NextResponse, req.headers.get("origin"))
    : new NextResponse(null, { status: 404 });

/** Body parsing that answers with a sentence rather than throwing a 500 at a phone. */
export async function body<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
