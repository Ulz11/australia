import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { Row, Say, Section } from "@/components/ui";
import { ConfirmButton } from "@/components/ConfirmButton";
import { DemoBillingNote } from "./DemoBillingNote";
import { InvoiceStatus } from "./InvoiceStatus";
import { bossBilling, listInvoices, matchesThisPeriod } from "@/lib/invoicing";
import {
  fmtBillingDay, matchFeeCents, money, periodSoFar, priceWords, statusWords, subscriptionCents,
} from "@/lib/subscription";
import { startSubscriptionNow, cancelSubscriptionNow, keepSubscription } from "@/actions/billing";
export const dynamic = "force-dynamic";

/**
 * What the boss is paying, in the order he'd ask: where do I stand, what has this month cost, what
 * have I been billed. No card is stored and nothing charges anything — invoices are records, and a
 * person marks them paid.
 */
export default async function Billing() {
  const u = await requireRole("boss");
  const [b, invoices, matches] = await Promise.all([bossBilling(u.id), listInvoices(u.id), matchesThisPeriod(u.id)]);
  if (!b) return <><Header title="Billing" back="/boss/me" /><Page><Empty>Company details missing — tell us and we&apos;ll fix it.</Empty></Page></>;

  const words = statusWords({ status: b.subscription_status, trial_ends_at: b.trial_ends_at, period_ends_at: b.period_ends_at });
  const tone = b.subscription_status === "active" ? "green" : b.subscription_status === "lapsed" ? "orange" : "grey";
  const so = periodSoFar({ matches, status: b.subscription_status });
  const fee = matchFeeCents();

  return (
    <>
      <Header title="Billing" back="/boss/me" />
      <Page>
        <DemoBillingNote />
        <Say tone={tone} title={words.title} sub={words.sub} />

        <Section title="This period so far" hint="Nothing is charged to a card. We invoice you and you pay it your usual way." />
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
              {invoices.map((i) => (
                <Row key={i.id} href={`/boss/billing/${i.number}`}
                  title={<span className="num">{i.number}</span>}
                  sub={fmtBillingDay(i.issued_at)}
                  right={<div className="space-y-1">
                    <div className="num font-bold">{money(i.total_cents)}</div>
                    <InvoiceStatus s={i.status} />
                  </div>} />
              ))}
            </div>}

        {b.subscription_status === "lapsed"
          ? <form action={startSubscriptionNow}><button className="btn-primary">Start subscription</button></form>
          : b.subscription_status === "cancelling"
            ? <form action={keepSubscription}><button className="btn-ghost">Keep the pay tools</button></form>
            : <ConfirmButton action={cancelSubscriptionNow}
                msg={`Cancel the subscription? The pay tools keep working until ${b.period_ends_at ? fmtBillingDay(b.period_ends_at) : "the end of this period"}, then the pay run, the approvals record and Export stop. Posting shifts, matching and approving hours stay free. You can start again any time.`}>
                Cancel subscription
              </ConfirmButton>}
      </Page>
    </>
  );
}
