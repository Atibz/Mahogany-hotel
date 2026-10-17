import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { FileMinus2, Printer } from "lucide-react";

import { Modal } from "@/components/shared/modal";
import { formatNaira, nairaToKobo } from "@/lib/money";
import { printElementInIsolatedFrame } from "@/lib/print-document";
import { supabase } from "@/lib/supabase/client";

type Receivable = {
  receivable_id: string;
  receivable_number: string;
  account_name: string;
  invoice_number: string | null;
  principal_kobo: number;
  status: string;
};

type Payment = {
  payment_id: string;
  receivable_id: string;
  payment_number: string;
  payment_method_name: string;
  amount_kobo: number;
  status: string;
};

type CreditPosition = {
  receivable_id: string;
  receivable_number: string;
  business_account_id: string;
  account_name: string;
  invoice_number: string;
  credit_kobo: number;
};

type CreditNote = {
  credit_note_id: string;
  credit_note_number: string;
  receivable_id: string;
  receivable_number: string;
  account_name: string;
  invoice_number: string;
  amount_kobo: number;
  reason: string;
  issued_at: string;
  snapshot: Record<string, unknown>;
};

type Props = {
  hotelId: string;
  hotelName: string;
  roleCodes: string[];
  receivables: Receivable[];
  payments: Payment[];
  onChange: () => Promise<void>;
};

export function BusinessCreditControls({ hotelId, hotelName, roleCodes, receivables, payments, onChange }: Props) {
  const queryClient = useQueryClient();
  const documentRef = useRef<HTMLElement>(null);
  const [action, setAction] = useState<"credit" | "refund" | null>(null);
  const [note, setNote] = useState<CreditNote | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedReceivableId, setSelectedReceivableId] = useState("");
  const canRequestCredit = roleCodes.some((role) => ["owner", "general_manager", "accountant"].includes(role));
  const canRequestRefund = roleCodes.some((role) => ["owner", "accountant"].includes(role));
  const eligibleReceivables = receivables.filter((item) => item.invoice_number && item.status !== "voided");
  const positions = useQuery({
    queryKey: ["business-credit-positions", hotelId],
    enabled: Boolean(supabase && hotelId),
    queryFn: async () => {
      const { data, error } = await supabase!.rpc("get_business_credit_positions", { target_hotel_id: hotelId });
      if (error) throw error;
      return (data ?? []) as CreditPosition[];
    },
  });
  const notes = useQuery({
    queryKey: ["business-credit-notes", hotelId],
    enabled: Boolean(supabase && hotelId),
    queryFn: async () => {
      const { data, error } = await supabase!.rpc("get_business_credit_notes", { target_hotel_id: hotelId });
      if (error) throw error;
      return (data ?? []) as CreditNote[];
    },
  });
  const selectedPosition = positions.data?.find((item) => item.receivable_id === selectedReceivableId);
  const eligiblePayments = payments.filter((item) => item.receivable_id === selectedReceivableId && ["completed", "refunded"].includes(item.status));
  const noteAccountName = String(note?.snapshot.account_name ?? note?.account_name ?? "");
  const noteInvoiceNumber = String(note?.snapshot.original_invoice_number ?? note?.invoice_number ?? "");
  const noteReason = String(note?.snapshot.reason ?? note?.reason ?? "");
  const noteAmountKobo = Number(note?.snapshot.amount_kobo ?? note?.amount_kobo ?? 0);

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !action) return;
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setMessage(null);
    try {
      const amountKobo = nairaToKobo(String(values.get("amount")));
      if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
        throw new Error("Enter a valid amount greater than zero.");
      }
      const result = action === "credit"
        ? await supabase.rpc("request_business_credit_note", {
          target_receivable_id: String(values.get("receivable")),
          credit_amount_kobo: amountKobo,
          request_reason: String(values.get("reason")),
        })
        : await supabase.rpc("request_business_payment_refund", {
          target_payment_id: String(values.get("payment")),
          refund_amount_kobo: amountKobo,
          request_reason: String(values.get("reason")),
          payout_reference: String(values.get("reference") || "") || null,
        });
      if (result.error) throw result.error;
      setAction(null);
      setMessage("Request submitted. An independent GM or Owner must approve and execute it in Payments & receipts.");
      await queryClient.invalidateQueries({ queryKey: ["finance-approval-requests", hotelId] });
      await onChange();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The correction could not be requested.");
    } finally {
      setBusy(false);
    }
  }

  function printNote() {
    if (!note || !documentRef.current) return;
    const printed = printElementInIsolatedFrame({
      source: documentRef.current,
      title: note.credit_note_number,
      styles: "body{font-family:Arial,sans-serif;color:#292524;margin:36px}h1{font-size:25px}dl{display:grid;grid-template-columns:160px 1fr;gap:12px;margin-top:28px}dt{color:#78716c}dd{margin:0}p{line-height:1.5}.amount{font-size:24px;font-weight:bold}",
    });
    if (!printed) setMessage("Print view could not be opened in this browser.");
  }

  return (
    <section className="mt-10 rounded-2xl border bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-800">Approved corrections</p><h2 className="mt-1 text-xl font-semibold">Company credits</h2><p className="mt-1 max-w-2xl text-sm text-stone-600">A credit note adjusts a closed company invoice. A refund is a separate approved payout and is only available when the company has a credit balance.</p></div>
        {canRequestCredit && <button type="button" onClick={() => { setMessage(null); setAction("credit"); }} disabled={!eligibleReceivables.length} className="rounded-xl bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">Request credit note</button>}
      </div>
      {message && <p role="status" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-950">{message} <Link to="/payments" className="font-semibold underline">Open approvals</Link></p>}
      {(positions.error || notes.error) && <p role="alert" className="mt-4 text-sm text-red-700">Unable to load company credits. Check that the latest database migration is applied.</p>}
      {(positions.isLoading || notes.isLoading) && <p className="mt-4 text-sm text-stone-500">Loading company credits…</p>}
      {!positions.isLoading && !positions.error && <div className="mt-5"><h3 className="text-sm font-semibold">Available company credit</h3>{positions.data?.length ? <div className="mt-2 divide-y rounded-xl border">{positions.data.map((position) => <div key={position.receivable_id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm"><div><p className="font-semibold">{position.account_name}</p><p className="text-stone-500">{position.receivable_number} · {position.invoice_number}</p></div><div className="flex items-center gap-3"><span className="font-semibold">{formatNaira(position.credit_kobo)}</span>{canRequestRefund && <button type="button" onClick={() => { setSelectedReceivableId(position.receivable_id); setMessage(null); setAction("refund"); }} className="font-semibold text-amber-900 underline">Request refund</button>}</div></div>)}</div> : <p className="mt-2 text-sm text-stone-500">No company credit is awaiting refund.</p>}</div>}
      {!notes.isLoading && !notes.error && <div className="mt-6"><h3 className="text-sm font-semibold">Issued credit notes</h3>{notes.data?.length ? <div className="mt-2 divide-y rounded-xl border">{notes.data.map((item) => <div key={item.credit_note_id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm"><div><p className="font-semibold">{item.credit_note_number} · {formatNaira(item.amount_kobo)}</p><p className="text-stone-500">{item.account_name} · {item.invoice_number} · {new Date(item.issued_at).toLocaleDateString("en-GB")}</p></div><button type="button" onClick={() => setNote(item)} className="inline-flex items-center gap-1 font-semibold text-amber-900 underline"><FileMinus2 className="size-4"/>View document</button></div>)}</div> : <p className="mt-2 text-sm text-stone-500">No credit notes have been issued.</p>}</div>}

      <Modal open={Boolean(action)} title={action === "credit" ? "Request company credit note" : "Request company refund"} onClose={() => !busy && setAction(null)}>
        {action && <form onSubmit={submitRequest} className="space-y-4 text-sm">
          <p className="rounded-xl bg-stone-50 p-3 text-stone-600">An independent GM or Owner must approve and execute this request. The original invoice and payment remain in the audit trail.</p>
          {action === "credit" ? <label className="block font-medium">Closed company invoice<select name="receivable" required className="mt-2 w-full rounded-xl border px-3 py-2.5"><option value="">Select invoice</option>{eligibleReceivables.map((item) => <option key={item.receivable_id} value={item.receivable_id}>{item.account_name} · {item.invoice_number} · {item.receivable_number}</option>)}</select></label> : <><p className="font-semibold">{selectedPosition?.account_name} · Available credit {formatNaira(selectedPosition?.credit_kobo ?? 0)}</p><label className="block font-medium">Original company payment<select name="payment" required className="mt-2 w-full rounded-xl border px-3 py-2.5"><option value="">Select payment</option>{eligiblePayments.map((item) => <option key={item.payment_id} value={item.payment_id}>{item.payment_number} · {item.payment_method_name} · {formatNaira(item.amount_kobo)}</option>)}</select></label><label className="block font-medium">Payout reference (required for non-cash)<input name="reference" className="mt-2 w-full rounded-xl border px-3 py-2.5" /></label></>}
          <label className="block font-medium">Amount (naira)<input name="amount" type="number" min="0.01" step="0.01" max={action === "refund" ? ((selectedPosition?.credit_kobo ?? 0) / 100).toFixed(2) : undefined} required className="mt-2 w-full rounded-xl border px-3 py-2.5" /></label>
          <label className="block font-medium">Reason<textarea name="reason" rows={3} required className="mt-2 w-full rounded-xl border px-3 py-2.5" /></label>
          {message && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-800">{message}</p>}
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setAction(null)} disabled={busy} className="rounded-xl border px-4 py-2.5 font-semibold">Cancel</button><button disabled={busy} className="rounded-xl bg-amber-900 px-4 py-2.5 font-semibold text-white disabled:opacity-50">{busy ? "Submitting…" : "Submit for approval"}</button></div>
        </form>}
      </Modal>
      <Modal open={Boolean(note)} title={note?.credit_note_number ?? "Credit note"} onClose={() => setNote(null)}>
        {note && <><article ref={documentRef} className="text-sm"><p className="text-stone-500">{hotelName}</p><h1 className="mt-2 text-2xl font-semibold">Credit note</h1><dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2"><dt className="text-stone-500">Number</dt><dd>{note.credit_note_number}</dd><dt className="text-stone-500">Issued</dt><dd>{new Date(note.issued_at).toLocaleString("en-GB")}</dd><dt className="text-stone-500">Company</dt><dd>{noteAccountName}</dd><dt className="text-stone-500">Original invoice</dt><dd>{noteInvoiceNumber}</dd><dt className="text-stone-500">Receivable</dt><dd>{note.receivable_number}</dd><dt className="text-stone-500">Reason</dt><dd>{noteReason}</dd></dl><p className="amount mt-6 text-xl font-bold">Credit: {formatNaira(noteAmountKobo)}</p><p className="mt-4 text-xs text-stone-500">This document reduces the company invoice balance. It is not proof of a cash refund.</p></article><div className="mt-5 flex justify-end"><button type="button" onClick={printNote} className="inline-flex items-center gap-2 rounded-xl bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white"><Printer className="size-4"/>Print credit note</button></div></>}
      </Modal>
    </section>
  );
}
