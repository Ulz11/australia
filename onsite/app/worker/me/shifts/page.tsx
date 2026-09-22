import { requireRole } from "@/lib/session";
import { Empty, Header, Page } from "@/components/Header";
import { workerRecord } from "@/lib/profileStats";
import { getT } from "@/lib/i18n/server";
import { plural } from "@/lib/i18n";
import { ShiftRow, wantsAnAnswer } from "../ShiftRow";
export const dynamic = "force-dynamic";

/** The whole record, newest first. Same rows as the ten on /worker/me — one component draws both. */
export default async function AllShifts() {
  const u = await requireRole("worker");
  const [t, r] = await Promise.all([getT(), workerRecord(u.id)]);
  // One orange on this screen too, and it goes to the newest pair of hours that don't match. Ten rows
  // shouting at once is the flattening the colour law exists to stop; the rest are `say-soft`.
  const loudest = r.history.find(wantsAnAnswer)?.id;
  return (
    <>
      <Header title={plural(t, r.history.length, "{n} shift", "{n} shifts")} back="/worker/me" />
      <Page>
        {r.history.length === 0
          ? <Empty>{t("Nothing on the record yet. Your first shift starts it.")}</Empty>
          : <div className="card divide-y divide-line">
              {r.history.map((h) => <ShiftRow key={h.id} h={h} t={t} gross={r.gross} loud={h.id === loudest} />)}
            </div>}
      </Page>
    </>
  );
}
