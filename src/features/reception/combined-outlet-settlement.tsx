import { FormSubmitButton } from "@/components/shared/form-submit-button";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { formatNaira, nairaToKobo } from "@/lib/money";
import { recordCombinedGuestPaymentSettlement, reverseCombinedGuestPaymentSettlement, type CombinedGuestPayment } from "./reception-service";

export function CombinedOutletSettlement({ payment, onChanged }: {
  payment: CombinedGuestPayment;
  onChanged: () => Promise<void>;
}) {
  const [orderId, setOrderId] = useState("");
  const [amount, setAmount] = useState("");
  const [evidence, setEvidence] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [reversalId, setReversalId] = useState("");
  const [reversalEvidence, setReversalEvidence] = useState("");
  const [reversalNote, setReversalNote] = useState("");
  const outstanding = payment.orders.filter((order) => Number(order.amount_kobo) > Number(order.settled_kobo));
  const activeSettlements = payment.orders.flatMap((order) => order.settlements.filter((settlement) => !settlement.reversed).map((settlement) => ({ ...settlement, order })));
  const selected = outstanding.find((order) => order.order_id === orderId);
  const remaining = selected ? Number(selected.amount_kobo) - Number(selected.settled_kobo) : 0;
  const amountKobo = /^\d+(?:\.\d{0,2})?$/.test(amount) ? nairaToKobo(amount) : 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || amountKobo <= 0 || amountKobo > remaining) return;
    setBusy(true);
    setMessage("");
    try {
      await recordCombinedGuestPaymentSettlement({
        paymentId: payment.payment_id,
        orderId: selected.order_id,
        amountKobo,
        evidenceReference: evidence,
        note,
      });
      setOrderId(""); setAmount(""); setEvidence(""); setNote("");
      await onChanged();
      setMessage("Outlet settlement evidence recorded. This did not make a bank transfer.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not record outlet settlement.");
    } finally { setBusy(false); }
  }

  async function reverse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reversalId) return;
    setBusy(true); setMessage("");
    try {
      await reverseCombinedGuestPaymentSettlement(reversalId, reversalEvidence, reversalNote);
      setReversalId(""); setReversalEvidence(""); setReversalNote("");
      await onChanged();
      setMessage("Returned outlet funds documented. The original settlement remains in the audit history.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not document settlement reversal.");
    } finally { setBusy(false); }
  }

  if (payment.status !== "completed" || payment.review_status !== "confirmed" || (outstanding.length === 0 && activeSettlements.length === 0)) return null;
  return <details className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
    <summary className="cursor-pointer font-semibold">Outlet settlement and return evidence</summary>
    <p className="mt-2 text-stone-600">Only record a real transfer already made to the separate outlet business. This is not another guest payment. Also document the corresponding account movement in <Link to="/internal-balancing" className="font-semibold text-amber-900 underline">Internal balancing</Link>; this evidence entry does not move or net funds automatically.</p>
    {outstanding.length > 0 && <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="block">Outlet order
        <select required value={orderId} onChange={(event) => { setOrderId(event.target.value); setAmount(""); }} className="mt-1 w-full rounded-lg border border-stone-300 p-2">
          <option value="">Choose outlet order</option>
          {outstanding.map((order) => <option value={order.order_id} key={order.order_id}>{order.outlet_name} · {order.order_number} · {formatNaira(Number(order.amount_kobo) - Number(order.settled_kobo))} held</option>)}
        </select>
      </label>
      <label className="block">Amount actually passed (₦)
        <input required type="number" min="0.01" max={remaining / 100 || undefined} step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 p-2" />
      </label>
      <label className="block">Bank/cash transfer evidence reference
        <input required minLength={3} maxLength={200} value={evidence} onChange={(event) => setEvidence(event.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 p-2" />
      </label>
      <label className="block">Settlement note
        <input required minLength={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 p-2" />
      </label>
      <div className="sm:col-span-2">
        {amountKobo > remaining && <p className="text-red-700">Amount exceeds {formatNaira(remaining)} still held for this order.</p>}
        <FormSubmitButton type="submit" disabled={busy || !selected || amountKobo <= 0 || amountKobo > remaining} className="mt-2 rounded-lg bg-amber-900 px-4 py-2 font-semibold text-white disabled:opacity-50">Record settlement evidence</FormSubmitButton>
        {message && <p role="status" className="mt-2">{message}</p>}
      </div>
    </form>}
    {activeSettlements.length > 0 && <div className="mt-4 border-t border-stone-200 pt-3">
      <p className="font-semibold">Money already passed to outlets</p>
      {activeSettlements.map((settlement) => <p key={settlement.id} className="mt-1 text-stone-600">{settlement.order.outlet_name} · {settlement.order.order_number} · {formatNaira(Number(settlement.amount_kobo))} · {settlement.evidence_reference}</p>)}
      <details className="mt-2">
        <summary className="cursor-pointer text-amber-900">Document an actual return of outlet funds</summary>
        <form onSubmit={reverse} className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">Settlement to reverse
            <select required value={reversalId} onChange={(event) => setReversalId(event.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 p-2"><option value="">Choose settlement</option>{activeSettlements.map((item) => <option key={item.id} value={item.id}>{item.order.outlet_name} · {formatNaira(Number(item.amount_kobo))} · {item.evidence_reference}</option>)}</select>
          </label>
          <label className="block">Evidence of money returned to hotel
            <input required minLength={3} maxLength={200} value={reversalEvidence} onChange={(event) => setReversalEvidence(event.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 p-2" />
          </label>
          <label className="block sm:col-span-2">Reason for reversal
            <input required minLength={10} maxLength={500} value={reversalNote} onChange={(event) => setReversalNote(event.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 p-2" />
          </label>
          <FormSubmitButton type="submit" disabled={busy || !reversalId} className="rounded-lg border border-amber-900 px-4 py-2 font-semibold text-amber-900 disabled:opacity-50">Record returned funds</FormSubmitButton>
        </form>
      </details>
    </div>}
  </details>;
}
