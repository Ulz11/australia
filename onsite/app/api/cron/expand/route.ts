import { expandStaleShifts } from "@/lib/matching";
/** Hit this every 4 minutes — also keeps the free-tier Neon compute awake (it sleeps after 5 idle min).
 *  Widens matching on shifts still open after 20 min. */
export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key") ?? req.headers.get("authorization")?.replace("Bearer ", "");
  const secret = process.env.CRON_SECRET;
  if (process.env.NODE_ENV === "production" && !secret) return new Response("CRON_SECRET not set", { status: 503 });
  if (secret && key !== secret) return new Response("nope", { status: 401 });
  return Response.json(await expandStaleShifts());
}
