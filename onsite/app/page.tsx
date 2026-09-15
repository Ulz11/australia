import { redirect } from "next/navigation";
import { getUser } from "@/lib/session";
export default async function Home() {
  const u = await getUser();
  if (!u) redirect("/login");
  if (!u.role || !u.name) redirect("/onboarding");
  redirect(u.role === "boss" ? "/boss" : "/worker");
}
