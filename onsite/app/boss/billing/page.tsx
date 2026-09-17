import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { Row, Say, Section } from "@/components/ui";
import { ConfirmButton } from "@/components/ConfirmButton";
import { DemoBillingNote } from "./DemoBillingNote";
import { InvoiceStatus } from "./InvoiceStatus";
import { bossBilling, listInvoices, matchesThisPeriod, type InvoiceRow } from "@/lib/invoicing";
import {
  fmtBillingDay, isOverdue, matchFeeCents, money, periodSoFar, priceWords, qpayPayable, statusWords, subscriptionCents,
} from "@/lib/subscription";
import { startSubscriptionNow, cancelSubscriptionNow, keepSubscription } from "@/actions/billing";
export const dynamic = "force-dynamic";

/**
 * What the boss is paying, in the order he'd ask: where do I stand, what has this month cost, what
 * have I been billed. No card is stored and nothing here charges anything: an open invoice has a "Pay" link
 * to its own page, where it is paid through QPay.
 */
export default async function Billing() {
  const u = await requireRole("boss");
  const [b, invoices, matches] = await Promise.all([bossBilling(u.id), listInvoices(u.id), matchesThisPeriod(u.id)]);
  if (!b) return <><Header title="Billing" back="/boss/me" /><Page><Row href="/boss/me/settings" tone="orange" title="Company details missing" sub="Your company name goes on the top of every invoice. Add it in Settings." /></Page></>;

  const words = statusWords({ status: b.subscription_status, trial_ends_at: b.trial_ends_at, period_ends_at: b.period_ends_at });
  const tone = b.subscription_status === "active" ? "green" : b.subscription_status === "lapsed" ? "orange" : "grey";
  const so = periodSoFar({ matches, status: b.subscription_status });
  const fee = matchFeeCents();
  const payable = qpayPayable();
  const now = new Date();

  return (
    <>
      <Header title="Billing" back="/boss/me" />
      <Page>
        <DemoBillingNote />
        <Say tone={tone} title={words.title} sub={words.sub} />

        <Section title="This period so far" hint={payable
          ? "Nothing is charged to a card. We invoice you, and you pay each invoice through QPay in your bank app."
          : "Nothing is charged to a card. We invoice you and send you payment details."} />
        <div className="card num divide-y divide-line">
          <div className="py-2 flex justify-between gap-3">
            <span>{so.matches} new worker{so.matches === 1 ? "" : "s"} OnSite found you × {priceWords(fee)}</span>
            <span>{money(so.matchCents)}</span>
          </div>
          {b.subscription_status !== "cancelling" && b.subscription_status !== "lapsed" && (
            <div className="py-2 flex justify-between gap-3">
              <span>Pay tools, next month{b.period_ends_at ? ` from ${fmtBillingDay(b.period_ends_at)}` : ""}</span>
              <span>{money(subscriptionCents())}</span>
            </div>
          )}
          <div className="py-2 flex justify-between text-lg font-extrabold"><span>Next invoice</span><span>{money(so.totalCents)}</span></div>
        </div>
        <p className="text-steel">
          {priceWords(fee)} each time OnSite finds you a worker you haven&apos;t worked with, charged when you approve their
          first shift. Shifts with the same worker after that are free. Posting, matching and approving hours are always free.
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
                      <div className="num font-bold">{money(i.total_cents)}</div>
                      <InvoiceStatus s={i.status} />
                    </div>} />)}
            </div>}

        {b.subscription_status === "lapsed"
          ? <form action={startSubscriptionNow}><button className="btn-primary">Start subscription</button></form>
          : b.subscription_status === "cancelling"
            ? <form action={keepSubscription}><button className="btn-ghost">Keep the pay tools</button></form>
            : <ConfirmButton action={cancelSubscriptionNow}
                msg={`Cancel the subscription? The pay tools keep working until ${b.period_ends_at ? fmtBillingDay(b.period_ends_at) : "the end of this period"}, then the pay run, the approvals record and Export stop. Posting shifts, matching and approving hours stay free. You can start again any time.`}>
                Cancel subscription
              </ConfirmButton>}
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
        <div className="shrink-0 num font-bold">{money(i.total_cents)}</div>
      </Link>
      <Link href={href} className="btn btn-sm bg-ink text-white shrink-0" aria-label={`Pay invoice ${i.number}`}>Pay</Link>
    </div>
  );
}
