import { revalidatePath as rp } from "next/cache";
/** revalidatePath that is a no-op outside a request (so actions can run from scripts/tests). */
export function revalidatePath(path: string) {
  try { rp(path); } catch { /* not in a request context */ }
}
