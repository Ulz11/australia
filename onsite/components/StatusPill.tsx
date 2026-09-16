import { Flag, type Tone } from "./ui";

/**
 * One state, one pill. Orange only where the person reading it has to do something:
 * hours to approve and a shift still short of workers are the boss's jobs, not the worker's.
 */
const BOSS: Record<string, [string, Tone]> = {
  accepted: ["Coming", "grey"],
  clocked_in: ["On site", "green"],
  clocked_out: ["Approve hours", "orange"],
  approved: ["Owed", "dark"],
  paid: ["Paid", "green"],
  removed: ["Removed", "grey"],
  cancelled: ["Pulled out", "red"],
  open: ["Needs workers", "orange"],
  filled: ["All spots taken", "green"],
  closed: ["Done", "grey"],
};
const WORKER: Record<string, [string, Tone]> = {
  ...BOSS,
  clocked_out: ["Hours sent", "grey"],
  approved: ["Owed to you", "dark"],
  removed: ["Taken off", "grey"],
  cancelled: ["You pulled out", "red"],
};

export function StatusPill({ s, view = "boss" }: { s: string; view?: "boss" | "worker" }) {
  const [label, tone] = (view === "worker" ? WORKER : BOSS)[s] ?? [s, "grey" as Tone];
  return <Flag tone={tone} icon={tone === "dark" || tone === "grey" ? null : undefined}>{label}</Flag>;
}
