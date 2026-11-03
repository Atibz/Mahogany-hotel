import { FormSubmitButton } from "@/components/shared/form-submit-button";
import { useActionMessage } from "@/components/shared/action-feedback";
import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatNaira, nairaToKobo } from "@/lib/money";
import { printElementInIsolatedFrame } from "@/lib/print-document";
import {
  getCombinedGuestPayments,
  getCombinedPaymentCandidates,
  recordCombinedGuestPayment,
  reviewCombinedGuestPayment,
  requestCombinedGuestPaymentRefund,
  type CombinedGuestPayment,
} from "./reception-service";

type Method = { id: string; name: string; requires_reference: boolean; requires_verification: boolean };

export function CombinedPaymentPanel({ hotelId, folioId, folioBalanceKobo, methods, canCollect, isAccountant, canRequestRefund, onChanged }: {
  hotelId: string;
  folioId: string;
  folioBalanceKobo: number;
  methods: Method[];
  canCollect: boolean;
  isAccountant: boolean;
  canRequestRefund: boolean;
  onChanged: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [orderNumbersText, setOrderNumbersText] = useState("");
  const requestedNumbers = orderNumbersText.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean).slice(0, 10);
  const candidates = useQuery({
    queryKey: ["combined-candidates", folioId, requestedNumbers.join(",")],
    queryFn: () => getCombinedPaymentCandidates(folioId, requestedNumbers),
    enabled: canCollect && requestedNumbers.length > 0 && requestedNumbers.every((value) => value.length >= 5),
  });
  const records = useQuery({ queryKey: ["combined-payments", hotelId], queryFn: () => getCombinedGuestPayments(hotelId) });
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [hotelAmount, setHotelAmount] = useState("");
  const [methodId, setMethodId] = useState("");
  const [reference, setReference] = useState("");
  const [accountantName, setAccountantName] = useState("");
  const [reason, setReason] = useState("");
  const [phoneApproved, setPhoneApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useActionMessage<string>("");
  const [reviewAction, setReviewAction] = useState<{ paymentId: string; paymentNumber: string; decision: "confirmed" | "disputed" } | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [printRecord, setPrintRecord] = useState<CombinedGuestPayment | null>(null);
  const printRef = useRef<HTMLDivElement>(null);
  const chosen = (candidates.data ?? []).filter((order) => selected[order.order_id]);
  const outletTotal = chosen.reduce((sum, order) => sum + Number(order.balance_kobo), 0);
  const hotelKobo = /^\d+(?:\.\d{0,2})?$/.test(hotelAmount) ? nairaToKobo(hotelAmount) : 0;
  const method = methods.find((item) => item.id === methodId);

  async function reload() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["combined-payments", hotelId] }),
      queryClient.invalidateQueries({ queryKey: ["combined-candidates", folioId] }),
      queryClient.invalidateQueries({ queryKey: ["restaurant-pos"] }),
      onChanged(),
    ]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!methodId || !phoneApproved || !chosen.length || hotelKobo <= 0 || hotelKobo > folioBalanceKobo) return;
    setBusy(true); setMessage("");
    try {
      await recordCombinedGuestPayment({
        folioId, paymentMethodId: methodId, hotelAmountKobo: hotelKobo,
        allocations: chosen.map((order) => ({ order_id: order.order_id, amount_kobo: Number(order.balance_kobo) })),
        reference, accountantName, reason,
      });
      setSelected({}); setOrderNumbersText(""); setHotelAmount(""); setReference(""); setAccountantName(""); setReason(""); setPhoneApproved(false);
      await reload();
      setMessage(method?.requires_verification
        ? "Combined payment recorded pending bank verification; accountant confirmation is also required."
        : "Combined collection recorded. Accountant confirmation is still required.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Combined payment could not be recorded.");
    } finally { setBusy(false); }
  }

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reviewAction) return;
    const note = reviewNote.trim();
    if (note.length < 3) { setMessage("Enter a review note of at least three characters."); return; }
    setBusy(true); setMessage("");
    try { await reviewCombinedGuestPayment(reviewAction.paymentId, reviewAction.decision, note); await reload(); setMessage(`${reviewAction.paymentNumber}: phone-approval claim ${reviewAction.decision}.`); setReviewAction(null); setReviewNote(""); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Review failed."); }
    finally { setBusy(false); }
  }

  async function requestRefund(payment: CombinedGuestPayment) {
    const reasonValue = window.prompt("Reason for refunding the entire combined collection (at least 10 characters):");
    if (!reasonValue) return;
    const referenceValue = window.prompt("Payout reference (required for non-cash refunds):") ?? "";
    setBusy(true); setMessage("");
    try { await requestCombinedGuestPaymentRefund(payment.payment_id, reasonValue, referenceValue); await reload(); setMessage("Full combined refund requested for independent approval."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Refund request failed."); }
    finally { setBusy(false); }
  }

  function printAcknowledgement(payment: CombinedGuestPayment) {
    setPrintRecord(payment);
    window.setTimeout(() => {
      if (!printRef.current) return;
      const opened = printElementInIsolatedFrame({
        source: printRef.current,
        title: `Collection acknowledgement ${payment.payment_number}`,
        styles: `@page { margin: 14mm; } body { font: 14px/1.5 system-ui, sans-serif; color: #1c1917; } h1 { font-size: 22px; } h2 { font-size: 17px; } p { margin: 10px 0; }`,
      });
      if (!opened) setMessage("Print could not open in this browser.");
    }, 0);
  }

  const folioRecords = (records.data ?? []).filter((payment) => payment.folio_id === folioId);
  return <section className="mt-5 rounded-2xl border border-amber-200 bg-amber-50/50 p-4 text-sm">
    <h3 className="font-semibold text-stone-900">One-payment exception</h3>
    <p className="mt-1 text-stone-600">Normally, the guest pays the hotel and each outlet separately. Use this only after the accountant approves a single hotel collection by phone. Outlet sales remain separate from hotel revenue.</p>
    {message && <p role="status" className="mt-3 rounded-lg bg-white p-2 text-amber-950">{message}</p>}
    {canCollect && <details className="mt-3 rounded-xl border border-amber-200 bg-white p-3">
      <summary className="cursor-pointer font-semibold">Record exceptional combined collection</summary>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <p className="text-stone-600">Ask each outlet for its exact order number. Enter up to ten numbers, separated by commas or spaces. The full unpaid amount of each selected order will be included.</p>
        <input value={orderNumbersText} onChange={(event) => { setOrderNumbersText(event.target.value); setSelected({}); }} placeholder="Outlet order numbers" className="w-full rounded-lg border border-stone-300 p-2" />
        {candidates.isError && <p className="text-red-700">Unable to load eligible outlet orders. Check that the database migration is applied.</p>}
        {candidates.isLoading && <p>Loading outlet orders…</p>}
        {requestedNumbers.length > 0 && candidates.data?.length === 0 && <p>No matching unpaid restaurant or bar orders were found. Check the exact number with the outlet.</p>}
        <div className="max-h-48 space-y-2 overflow-y-auto">
          {candidates.data?.map((order) => <label key={order.order_id} className="flex items-center gap-2 rounded-lg border border-stone-200 p-2">
            <input type="checkbox" checked={Boolean(selected[order.order_id])} onChange={(event) => setSelected((current) => ({ ...current, [order.order_id]: event.target.checked }))} />
            <span>{order.outlet_name} · {order.order_number} · {formatNaira(Number(order.balance_kobo))} due</span>
          </label>)}
        </div>
        <label className="block">Hotel folio portion (₦)
          <input type="number" min="0.01" step="0.01" required value={hotelAmount} onChange={(event) => setHotelAmount(event.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 p-2" />
        </label>
        <p>Outlet portion: {formatNaira(outletTotal)} · Total received by hotel: {formatNaira(hotelKobo + outletTotal)}</p>
        {hotelKobo > folioBalanceKobo && <p className="text-red-700">Hotel portion exceeds the folio balance of {formatNaira(folioBalanceKobo)}.</p>}
        <select required value={methodId} onChange={(event) => setMethodId(event.target.value)} className="w-full rounded-lg border border-stone-300 p-2">
          <option value="">Hotel payment method</option>{methods.map((item) => <option key={item.id} value={item.id}>{item.name}{item.requires_verification ? " — verification required" : ""}</option>)}
        </select>
        <input value={reference} onChange={(event) => setReference(event.target.value)} required minLength={3} maxLength={200} placeholder="Unique collection reference (required, including cash)" className="w-full rounded-lg border border-stone-300 p-2" />
        <input value={accountantName} onChange={(event) => setAccountantName(event.target.value)} minLength={3} maxLength={120} required placeholder="Accountant who approved by phone" className="w-full rounded-lg border border-stone-300 p-2" />
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={10} maxLength={500} required placeholder="Why the guest needs one payment" className="w-full rounded-lg border border-stone-300 p-2" />
        <label className="flex items-start gap-2"><input type="checkbox" checked={phoneApproved} onChange={(event) => setPhoneApproved(event.target.checked)} /> I spoke with the accountant and received verbal approval before collecting.</label>
        <FormSubmitButton disabled={busy || !phoneApproved || !chosen.length || !methodId || hotelKobo <= 0 || hotelKobo > folioBalanceKobo} className="rounded-lg bg-amber-900 px-4 py-2 font-semibold text-white disabled:opacity-50">Record combined payment</FormSubmitButton>
      </form>
    </details>}
    {records.isError && <p className="mt-3 text-red-700">Unable to load combined-payment records.</p>}
    {folioRecords.map((payment) => <div key={payment.payment_id} className="mt-3 rounded-xl border border-stone-200 bg-white p-3">
      <p className="font-semibold">{payment.payment_number} · {formatNaira(Number(payment.amount_kobo))} received by hotel</p>
      <p className="text-stone-600">Hotel folio {formatNaira(Number(payment.hotel_amount_kobo))}; outlet portions {formatNaira(Number(payment.amount_kobo) - Number(payment.hotel_amount_kobo))}. {payment.status.replaceAll("_", " ")} · Accountant review: {payment.review_status.replaceAll("_", " ")}</p>
      {payment.orders.map((order) => <p key={order.order_id} className="text-stone-600">{order.outlet_name} · {order.order_number} · {formatNaira(Number(order.amount_kobo))} guest-paid · {formatNaira(Number(order.amount_kobo) - Number(order.settled_kobo))} still held by hotel</p>)}
      <p className="text-stone-600">Phone approval claimed from {payment.verbal_approver_name}. {payment.review_note && `Review: ${payment.review_note}`}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => printAcknowledgement(payment)} className="font-semibold text-amber-900">Print collection acknowledgement</button>
        {isAccountant && payment.review_status === "awaiting_accountant" && <>
          <button type="button" disabled={busy} onClick={() => { setReviewAction({ paymentId: payment.payment_id, paymentNumber: payment.payment_number, decision: "confirmed" }); setReviewNote(""); setMessage(""); }} className="min-h-10 rounded-lg bg-emerald-800 px-4 py-2 font-semibold text-white hover:bg-emerald-900 disabled:opacity-50">Confirm phone approval</button>
          <button type="button" disabled={busy} onClick={() => { setReviewAction({ paymentId: payment.payment_id, paymentNumber: payment.payment_number, decision: "disputed" }); setReviewNote(""); setMessage(""); }} className="min-h-10 rounded-lg border border-red-300 px-4 py-2 font-semibold text-red-800 hover:bg-red-50 disabled:opacity-50">Dispute claim</button>
        </>}
        {canRequestRefund && payment.status === "completed" && <button type="button" disabled={busy} onClick={() => requestRefund(payment)} className="font-semibold text-red-700">Request full refund</button>}
      </div>
      {reviewAction?.paymentId === payment.payment_id && <form onSubmit={review} className="mt-3 grid gap-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
        <p className="font-medium">{reviewAction.decision === "confirmed" ? "Confirm that you gave the claimed phone approval." : "Explain why the claimed phone approval is disputed."}</p>
        <label className="grid gap-1 font-medium">Review note
          <textarea required minLength={3} maxLength={2000} rows={3} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} className="rounded-lg border border-stone-300 bg-white px-3 py-2 font-normal outline-none focus:border-amber-700 focus:ring-2 focus:ring-amber-200" />
        </label>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" disabled={busy} onClick={() => setReviewAction(null)} className="min-h-10 rounded-lg border border-stone-300 px-4 py-2 font-semibold disabled:opacity-50">Cancel</button>
          <FormSubmitButton type="submit" disabled={busy} className={`min-h-10 rounded-lg px-4 py-2 font-semibold text-white disabled:opacity-50 ${reviewAction.decision === "confirmed" ? "bg-emerald-800" : "bg-red-700"}`}>{busy ? "Saving review…" : reviewAction.decision === "confirmed" ? "Confirm approval" : "Submit dispute"}</FormSubmitButton>
        </div>
      </form>}
    </div>)}
    {printRecord && <div ref={printRef} className="hidden print:block"><h1>Mahogany Hotel</h1><h2>Combined payment collection acknowledgement</h2><p>This acknowledges one payment received by Mahogany Hotel on behalf of the businesses below. It is not a tax invoice or outlet receipt.</p><p>{printRecord.payment_number} · {new Date(printRecord.received_at).toLocaleString("en-NG")}</p><p>Hotel folio {printRecord.folio_number}: {formatNaira(Number(printRecord.hotel_amount_kobo))}</p>{printRecord.orders.map((order) => <p key={order.order_id}>{order.outlet_name} · {order.order_number}: {formatNaira(Number(order.amount_kobo))}</p>)}<p>Total collected: {formatNaira(Number(printRecord.amount_kobo))}</p><p>Status: {printRecord.status.replaceAll("_", " ")}</p></div>}
  </section>;
}
