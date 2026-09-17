import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Say } from "@/components/ui";
import { DemoBillingNote } from "../DemoBillingNote";
import { InvoiceStatus } from "../InvoiceStatus";
import { PayWithQpay } from "./PayWithQpay";
import { QpayWatch } from "./QpayWatch";
import { bossBilling, invoiceWithLines, type InvoiceRow } from "@/lib/invoicing";
import { invoicePayState, type InvoicePayState } from "@/lib/invoiceQpay";
import {
  FX_AT_TAP, QPAY_HOW_TO, QPAY_NOT_SET_UP, audMoney, billingBusiness, fmtInvoiceDay, gstRegistered, isInvoiceNumber, isOverdue, mntWords, money,
} from "@/lib/subscription";
export const dynamic = "force-dynamic";

/**
 * One invoice, laid out as a tax invoice: who it is from, who it is to, what the lines are, and what is owed by
 * when. An open one is paid through QPay and nothing else: one big "Pay with QPay", which turns into a QR, a
 * button per bank app and QPay's own link, and the page flips to Paid by itself once QPay confirms it. GST
 * appears only when OnSite is registered for it, and then it is the eleventh already inside the total.
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
  const pay = await invoicePayState(invoice);

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
            : <OpenInvoice invoice={invoice} pay={pay} />}

        <p className="text-steel">
          Covers {fmtInvoiceDay(invoice.period_start)} to {fmtInvoiceDay(invoice.period_end)}. OnSite never
          charges a card{pay.kind === "unavailable" || pay.kind === "closed"
            ? " — when you've paid, we mark it paid here."
            : ". You pay through QPay in your own bank app, and this invoice shows Paid as soon as QPay confirms it."}
          {" "}<Link href="/terms" className="underline font-bold">The rules</Link>.
        </p>
      </Page>
    </>
  );
}

/** Due (or overdue) in words, then the one way to pay it. Orange only once it is past due. */
function OpenInvoice({ invoice, pay }: { invoice: InvoiceRow; pay: InvoicePayState }) {
  const overdue = isOverdue(invoice, new Date());
  const due = <Say tone={overdue ? "orange" : "grey"}
    title={overdue ? `Overdue — was due ${fmtInvoiceDay(invoice.due_at)}` : `Due ${fmtInvoiceDay(invoice.due_at)}`}
    sub={pay.kind === "unavailable" ? QPAY_NOT_SET_UP : undefined} />;
  if (pay.kind !== "button" && pay.kind !== "qr") return due;
  const { quote } = pay;

  return (
    <>
      {due}
      <section className="card space-y-4" aria-labelledby="pay-qpay">
        <div>
          <div id="pay-qpay" className="label">Pay with QPay</div>
          <div className="text-3xl font-extrabold num leading-tight">{audMoney(invoice.total_cents)}</div>
          {quote
            ? <div className="text-lg num">{mntWords(quote.amountMnt, quote)}</div>
            : <div className="text-lg">{FX_AT_TAP}</div>}
          {/* ExchangeRate-API's open endpoint asks for this link wherever its rates are shown. */}
          {quote?.source === "fallback" && (
            <a href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer" className="text-sm text-steel underline">Rates By Exchange Rate API</a>
          )}
        </div>

        {pay.kind === "button"
          ? <>
              <PayWithQpay number={invoice.number} />
              <p className="text-steel text-base">This invoice is in Australian dollars. You pay it in tögrög from your Mongolian bank app — we&apos;ll show a QR code and a button for your bank.</p>
              {pay.watch && <QpayWatch number={invoice.number} />}
            </>
          : <>
              <p className="text-lg font-bold">{QPAY_HOW_TO}</p>

              {pay.qr.urls.length > 0 && (
                <div className="space-y-2">
                  <div className="label">Open your bank app</div>
                  <ul className="grid grid-cols-2 gap-2">
                    {pay.qr.urls.map((b, i) => (
                      <li key={`${i}:${b.name}`} className="min-w-0">
                        {/* Logo above the name: two tiles to a phone's width leave no room beside a logo for "Trade and Development bank". */}
                        <a href={b.link} className="flex flex-col items-center justify-center gap-1.5 min-h-[88px] h-full rounded-2xl border-2 border-line bg-white px-2 py-2.5 text-center text-[15px] font-bold leading-tight active:scale-[0.98] transition">
                          {b.logo
                            ? <img src={b.logo} alt="" width={36} height={36} loading="lazy" className="w-9 h-9 rounded-lg object-contain shrink-0" />
                            : <span aria-hidden className="w-9 h-9 rounded-lg bg-site shrink-0" />}
                          <span className="min-w-0">{b.name}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-col items-center gap-2 pt-1">
                <img src={`data:image/png;base64,${pay.qr.qr_image}`} alt={`QPay QR code for invoice ${invoice.number}`}
                  width={224} height={224} className="w-56 h-56 rounded-xl border border-line bg-white" />
                <p className="text-steel text-base text-center">Paying from another phone or a computer? Scan this in your bank app.</p>
              </div>

              {pay.qr.short_url && (
                <a href={pay.qr.short_url} target="_blank" rel="noopener noreferrer" className="btn-ghost">
                  <ExternalLink size={22} strokeWidth={2.25} aria-hidden />Open in QPay
                </a>
              )}
              <QpayWatch number={invoice.number} />
            </>}
      </section>
    </>
  );
}
