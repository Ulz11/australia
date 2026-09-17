import { cookies } from "next/headers";
import { sql } from "@/lib/db";
import { relyingParty } from "@/lib/passkeys";
import { PASSKEY_OFFER_COOKIE } from "@/lib/passkeyClient";
import { PasskeyOffer } from "./PasskeyOffer";

/**
 * The boss and worker layouts mount this in a Suspense boundary. It costs nothing on an ordinary visit: only
 * right after a code sign-in or onboarding (the offer cookie) does it look up which passkeys the person already has.
 */
export async function PasskeyOfferGate({ userId }: { userId: string }) {
  const rp = relyingParty();
  if (!rp || !(await cookies()).has(PASSKEY_OFFER_COOKIE)) return null;
  const rows = await sql<{ credential_id: string }[]>`SELECT credential_id FROM passkeys WHERE user_id = ${userId}`;
  return <PasskeyOffer origin={rp.origin} serverIds={rows.map((r) => r.credential_id)} />;
}
