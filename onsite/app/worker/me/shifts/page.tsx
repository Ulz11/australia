import { requireRole } from "@/lib/session";
import { Empty, Header, Page } from "@/components/Header";
import { workerRecord } from "@/lib/profileStats";
import { ShiftRow } from "../ShiftRow";
export const dynamic = "force-dynamic";

/** The whole record, newest first. Same rows as the ten on /worker/me — one component draws both. */
export default async function AllShifts() {
  const u = await requireRole("worker");
  const r = await workerRecord(u.id);
  return (
    <>
      <Header title={`${r.history.length} shifts`} back="/worker/me" />
      <Page>
        {r.history.length === 0
          ? <Empty>Nothing on the record yet. Your first shift starts it.</Empty>
          : <div className="card divide-y divide-line">
              {r.history.map((h) => <ShiftRow key={h.id} h={h} gross={r.gross} />)}
            </div>}
      </Page>
    </>
  );
}
