import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { sql } from "./db";

const COOKIE = "onsite_session";
/**
 * The control room shows a Boss phone and a Worker phone side by side on one origin.
 * Each frame gets its own cookie, scoped to its own path, so /boss/* and /worker/*
 * can be two different people at once. Only ever set by /api/console/login, which is
 * off unless DEMO_CONSOLE=1.
 */
export const FRAME_COOKIES = { boss: "onsite_frame_boss", worker: "onsite_frame_worker" } as const;
const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production" && (!s || s.length < 32))
    throw new Error("SESSION_SECRET must be set to a random string of 32+ characters in production");
  return new TextEncoder().encode(s || "dev-secret-change-me");
};

export type SessionUser = { id: string; phone: string; name: string | null; role: "boss" | "worker" | null; lang: string };

/**
 * The signed cookie carries the whole user (id, role, name), so reading "who is this"
 * costs zero database trips. Re-issue it whenever role or name changes (createSession again).
 */
export async function signSession(userId: string): Promise<string | null> {
  const [u] = await sql<SessionUser[]>`SELECT id, phone, name, role, lang FROM users WHERE id = ${userId}`;
  if (!u) return null;
  return new SignJWT({ sub: u.id, phone: u.phone, name: u.name, role: u.role, lang: u.lang })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("30d").sign(secret());
}

export async function createSession(userId: string) {
  if (process.env.TEST_USER_ID && process.env.NODE_ENV !== "production") return; // scripts/tests: no cookie jar
  const token = await signSession(userId);
  if (!token) return;
  (await cookies()).set(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 24 * 30, path: "/" });
}

export async function destroySession() { (await cookies()).delete(COOKIE); }

/** One verification per request (React cache), no DB. */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  if (process.env.TEST_USER_ID && process.env.NODE_ENV !== "production") {
    const rows = await sql<SessionUser[]>`SELECT id, phone, name, role, lang FROM users WHERE id = ${process.env.TEST_USER_ID}`;
    return rows[0] ?? null;
  }
  const jar = await cookies();
  // A control-room frame cookie only reaches its own path, so if one is present it wins.
  const token = jar.get(FRAME_COOKIES.boss)?.value ?? jar.get(FRAME_COOKIES.worker)?.value ?? jar.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.sub) return null;
    return { id: payload.sub, phone: String(payload.phone ?? ""), name: (payload.name as string) ?? null, role: (payload.role as SessionUser["role"]) ?? null, lang: String(payload.lang ?? "en") };
  } catch { return null; }
});

export async function requireRole(role: "boss" | "worker"): Promise<SessionUser> {
  const u = await getUser();
  if (!u) redirect("/login");
  if (!u.role || !u.name) redirect("/onboarding");
  if (u.role !== role) redirect(u.role === "boss" ? "/boss" : "/worker");
  return u;
}
