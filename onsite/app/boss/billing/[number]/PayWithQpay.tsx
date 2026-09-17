"use client";
import { useActionState } from "react";
import { CircleAlert, QrCode } from "lucide-react";
import { payWithQpay } from "@/actions/billing";
import type { PayFormState } from "@/lib/invoiceQpay";

/**
 * The one big button on an open invoice. Tapping it asks the server for a QPay QR (raised only if the invoice
 * doesn't already have one it can use); the page then re-renders with the QR and the bank buttons. With
 * JavaScript off it is a plain form post and works the same.
 */
export function PayWithQpay({ number }: { number: string }) {
  const [state, action, pending] = useActionState<PayFormState, FormData>(payWithQpay, { error: null });
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="number" value={number} />
      <button className="btn-primary min-h-[64px] text-xl" disabled={pending} aria-busy={pending}>
        <QrCode size={26} strokeWidth={2.25} aria-hidden className="shrink-0" />
        {pending ? "Getting your QR code…" : "Pay with QPay"}
      </button>
      {state.error && !pending && (
        <div role="alert" className="say-orange flex items-start gap-3">
          <CircleAlert size={24} strokeWidth={2.25} aria-hidden className="shrink-0 mt-0.5" />
          <div className="font-bold">{state.error}</div>
        </div>
      )}
    </form>
  );
}
