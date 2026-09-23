import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { Row, Section } from "@/components/ui";
import { DemoBillingNote } from "./DemoBillingNote";
import { InvoiceStatus } from "./InvoiceStatus";
import { bossBilling, listInvoices, matchesThisFortnight, type InvoiceRow } from "@/lib/invoicing";
import { fmtBillingDay, isOverdue, matchFeeCents, moneyCents, periodSoFar, priceWords, qpayPayable } from "@/lib/subscription";
export const dynamic = "force-dynamic";

/**
 * What the boss is paying, in the order he'd ask: what is this fortnight running at, and what have I been
 * billed. There is no status to report — nothing can lapse, nothing can be cancelled and nothing is ever
 * switched off — so the screen is a number and a list, with no state block above them to read first.
 *
 * No card is stored and nothing here charges anything: an open invoice has a "Pay" link to its own page,
 * where it is paid through QPay.
 */
export default async function Billing() {
  const u = await requireRole("boss");
  const [b, invoices, matches] = await Promise.all([bossBilling(u.id), listInvoices(u.id), matchesThisFortnight(u.id)]);
  if (!b) return <><Header title="Billing" back="/boss/me" /><Page><Row href="/boss/me/settings" tone="orange" title="Company details missing" sub="Your company name goes on the top of every invoice. Add it in Settings." /></Page></>;

  const so = periodSoFar({ matches });
  const fee = matchFeeCents();
  const payable = qpayPayable();
  const now = new Date();

  return (
    <>
      <Header title="Billing" back="/boss/me" />
      <Page>
        <DemoBillingNote />

        <Section title="This fortnight so far" hint={payable
          ? "Nothing is charged to a card. We invoice you, and you pay each invoice through QPay in your bank app."
          : "Nothing is charged to a card. We invoice you and send you payment details."} />
        {/* A fortnight OnSite introduced nobody in costs nothing and raises no invoice at all, so it is said in
            words. A "$0.00" tile beside a due date reads like a bill for nothing and has bosses ringing up. */}
        {so.matches === 0
          ? <div className="card">
              <div className="text-lg font-bold">Nothing to invoice this fortnight.</div>
              <div className="text-steel mt-0.5">
                {priceWords(fee)} is charged when you approve the first shift of a worker OnSite found you. There
                haven&apos;t been any{b.period_ends_at ? ` since ${fmtBillingDay(b.period_started_at ?? b.period_ends_at)}` : ""}, so
                there is nothing to pay.
              </div>
            </div>
          : <div className="card num divide-y divide-line">
              <div className="py-2 flex justify-between gap-3">
                <span>{so.matches} new worker{so.matches === 1 ? "" : "s"} OnSite found you × {priceWords(fee)}</span>
                <span>{moneyCents(so.totalCents)}</span>
              </div>
              <div className="py-2 flex justify-between text-lg font-extrabold">
                <span>Next invoice{b.period_ends_at ? <span className="text-steel text-base font-normal"> · {fmtBillingDay(b.period_ends_at)}</span> : null}</span>
                <span>{moneyCents(so.totalCents)}</span>
              </div>
            </div>}
        <p className="text-steel">
          {priceWords(fee)} each time OnSite finds you a worker you haven&apos;t worked with, charged when you approve their
          first shift. Shifts with the same worker after that are free, and a worker you brought yourself is never
          charged for at all. Posting, matching and approving hours are always free. That is the whole price list.
        </p>

        <Section title="Invoices" />
        {invoices.length === 0
          ? <Empty>No invoices yet.</Empty>
          : <div className="space-y-2">
              {invoices.map((i) => i.status === "open" && payable
                ? <OpenInvoiceRow key={i.id} i={i} overdue={isOverdue(i, now)} />
                : <Row key={i.id} href={`/boss/billing/${i.number}`}
                    title={<span className="num">{i.number}</span>}
                    sub={fmtBillingDay(i.issued_at)}
                    right={<div className="space-y-1">
                      <div className="num font-bold">{moneyCents(i.total_cents)}</div>
                      <InvoiceStatus s={i.status} />
                    </div>} />)}
            </div>}

        <p className="text-steel"><Link href="/terms" className="underline font-bold">The rules</Link> — what you and your workers agree to, and every fee on this screen.</p>
      </Page>
    </>
  );
}

/**
 * An open invoice, with a "Pay" beside it. Two links side by side rather than a button inside a link: the row
 * opens the invoice, "Pay" opens the same page, where the QPay button is. Orange only once it is overdue.
 */
function OpenInvoiceRow({ i, overdue }: { i: InvoiceRow; overdue: boolean }) {
  const href = `/boss/billing/${i.number}`;
  return (
    <div className={`card flex items-center gap-3 ${overdue ? "border-hv border-2 bg-hv-soft" : ""}`}>
      <Link href={href} className="flex-1 min-w-0 flex items-center gap-3 min-h-[56px]">
        <div className="flex-1 min-w-0">
          <div className="text-lg font-bold leading-tight num">{i.number}</div>
          <div className="text-base text-steel mt-0.5">
            {overdue
              ? <span className="text-ink font-bold inline-flex items-center gap-1.5"><CircleAlert size={16} strokeWidth={2.5} aria-hidden className="shrink-0" />Overdue — was due {fmtBillingDay(i.due_at)}</span>
              : `Due ${fmtBillingDay(i.due_at)}`}
          </div>
        </div>
        <div className="shrink-0 num font-bold">{moneyCents(i.total_cents)}</div>
      </Link>
      <Link href={href} className="btn btn-sm bg-ink text-white shrink-0" aria-label={`Pay invoice ${i.number}`}>Pay</Link>
    </div>
  );
}
