import { redirect } from "next/navigation";

/**
 * A boss's crew link. Same shape as a mate's invite (/join/[code]): it hands the code to the login screen,
 * which carries it through to onboarding, and completeOnboarding puts whoever finishes on that boss's crew.
 */
export default async function JoinCrew({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  redirect(`/login?invite=${encodeURIComponent(code)}`);
}
