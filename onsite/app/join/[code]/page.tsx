import { redirect } from "next/navigation";
export default async function Join({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  redirect(`/login?invite=${encodeURIComponent(code)}`);
}
