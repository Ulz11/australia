import { notFound } from "next/navigation";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Say } from "@/components/ui";
import { DemoBillingNote } from "../DemoBillingNote";
import { InvoiceStatus } from "../InvoiceStatus";
import { bossBilling, invoiceWithLines } from "@/lib/invoicing";
import {
  billingBusiness, fmtInvoiceDay, gstRegistered, isInvoiceNumber, money, payInstructions,
} from "@/lib/subscription";
export const dynamic = "force-dynamic";

/**
 * One invoice, laid out as a tax invoice: who it is from, who it is to, what the lines are, and what
 * is owed by when. It is a record, not a payment screen — there is nothing here to tap to pay, because
 * OnSite never charges anything. GST appears only when OnSite is registered for it, and then it is the
 * eleventh already inside the total, never added on top.
 */
export default async function Invoice({ params }: { params: Promise<{ number: string }> }) {
  const u = await requireRole("boss");
  const { number } = await params;
  if (!isInvoiceNumber(number)) notFound();
  const [found, boss] = await Promise.all([invoiceWithLines(number, u.id), bossBilling(u.id)]);
  if (!found) notFound();
  const { invoice, lines } = found;
  const from = billingBusiness();
  const gst = gstRegistered();

  return (
    <>
      <Header title={invoice.number} back="/boss/billing" />
      <Page>
        <DemoBillingNote />

        <div className="card space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="label">{gst ? "Tax invoice" : "Invoice"}</div>
              <div className="text-2xl font-extrabold num">{invoice.number}</div>
            </div>
            <InvoiceStatus s={invoice.status} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {from && (
              <div>
                <div className="label">From</div>
                <div className="font-bold">{from.name}</div>
                {from.abn && <div className="text-steel num">ABN {from.abn}</div>}
              </div>
            )}
            <div>
              <div className="label">To</div>
              <div className="font-bold">{boss?.company ?? u.name}</div>
              {boss?.abn && <div className="text-steel num">ABN {boss.abn}</div>}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 num">
            <div><div className="label">Issued</div><div>{fmtInvoiceDay(invoice.issued_at)}</div></div>
            <div><div className="label">Due</div><div>{fmtInvoiceDay(invoice.due_at)}</div></div>
          </div>
        </div>

        <div className="card num divide-y divide-line">
          {lines.map((l) => (
            <div key={l.id} className="py-2 flex justify-between gap-3">
              <span className="min-w-0">{l.description}{l.qty > 1 ? ` × ${l.qty}` : ""}</span>
              <span className="shrink-0">{money(l.amount_cents)}</span>
            </div>
          ))}
          <div className="py-2 flex justify-between gap-3"><span>Subtotal</span><span>{money(invoice.subtotal_cents)}</span></div>
          {gst && <div className="py-2 flex justify-between gap-3"><span>GST</span><span>{money(invoice.gst_cents)}</span></div>}
          <div className="py-2 flex justify-between text-xl font-extrabold"><span>Total</span><span>{money(invoice.total_cents)}</span></div>
          {gst && <div className="text-sm text-steel pt-1">Total includes GST.</div>}
        </div>

        {invoice.status === "paid"
          ? <Say tone="green" title={`Paid${invoice.paid_at ? ` ${fmtInvoiceDay(invoice.paid_at)}` : ""}`} sub={invoice.paid_note ?? undefined} />
          : invoice.status === "void"
            ? <Say tone="grey" title="Cancelled" sub="Nothing to pay on this one." />
            : <Say tone="grey" title={`Due ${fmtInvoiceDay(invoice.due_at)}`} sub={payInstructions()} />}

        <p className="text-steel">
          Covers {fmtInvoiceDay(invoice.period_start)} to {fmtInvoiceDay(invoice.period_end)}. OnSite never
          charges a card — when you&apos;ve paid, we mark it paid here.
        </p>
      </Page>
    </>
  );
}
