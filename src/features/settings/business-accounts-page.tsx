import { FormSubmitButton } from "@/components/shared/form-submit-button";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, CheckCircle2, Clock3, Download, FileText, ShieldCheck } from "lucide-react";

import { Modal } from "@/components/shared/modal";
import { BusinessCreditControls } from "@/features/settings/business-credit-controls";
import { EmptyState, PageError, PageLoading } from "@/components/shared/page-state";
import { useAccess } from "@/features/auth/use-access";
import { useActiveHotel, usePaymentMethods } from "@/features/reception/use-reception";
import { formatNaira, nairaToKobo } from "@/lib/money";
import { supabase } from "@/lib/supabase/client";

type BusinessAccount = {
  id: string;
  account_number: string;
  account_type: "corporate" | "agency";
  legal_name: string;
  trading_name: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  credit_limit_kobo: number;
  payment_terms_days: number;
  direct_billing_enabled: boolean;
  status: "active" | "suspended" | "closed";
  billing_instructions: string | null;
};

type BusinessReceivable = {
  receivable_id: string;
  receivable_number: string;
  account_number: string;
  account_name: string;
  invoice_number: string | null;
  folio_number: string;
  principal_kobo: number;
  outstanding_kobo: number;
  due_date: string;
  days_overdue: number;
  status: string;
  created_at: string;
};

type ReceivablePayment = {
  payment_id: string;
  receivable_id: string;
  receivable_number: string;
  account_name: string;
  payment_number: string;
  payment_method_name: string;
  amount_kobo: number;
  reference: string | null;
  status: "pending_verification" | "completed" | "voided" | "refunded";
  received_at: string;
  receipt_number: string | null;
};

type ReceivableAgeing = {
  business_account_id: string;
  account_number: string;
  account_name: string;
  current_kobo: number;
  days_1_30_kobo: number;
  days_31_60_kobo: number;
  days_61_90_kobo: number;
  over_90_days_kobo: number;
  total_outstanding_kobo: number;
};

type StatementEntry = {
  entry_id: string;
  entry_type: "receivable" | "credit_note" | "payment" | "refund";
  occurred_at: string;
  document_number: string;
  related_document: string;
  reference: string | null;
  debit_kobo: number;
  credit_kobo: number;
  running_balance_kobo: number;
};

export function BusinessAccountsPage() {
  const hotel = useActiveHotel();
  const access = useAccess();
  const queryClient = useQueryClient();
  const methods = usePaymentMethods(hotel.data?.id);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [settlementTarget, setSettlementTarget] = useState<BusinessReceivable | null>(null);
  const [reviewTarget, setReviewTarget] = useState<ReceivablePayment | null>(null);
  const [statementAccountId, setStatementAccountId] = useState("");
  const [statementFromDate, setStatementFromDate] = useState("");
  const [statementToDate, setStatementToDate] = useState("");
  const canManage = access.roleCodes.some((role) => role === "owner" || role === "general_manager");
  const canSettle = access.roleCodes.some((role) => role === "owner" || role === "accountant");
  const canVerify = access.roleCodes.some((role) => role === "owner" || role === "general_manager" || role === "accountant");
  const accounts = useQuery({
    queryKey: ["business-accounts", hotel.data?.id],
    enabled: Boolean(supabase && hotel.data?.id),
    queryFn: async () => {
      if (!supabase || !hotel.data) return [] as BusinessAccount[];
      const { data, error } = await supabase.from("business_accounts").select("id, account_number, account_type, legal_name, trading_name, contact_name, contact_email, contact_phone, credit_limit_kobo, payment_terms_days, direct_billing_enabled, status, billing_instructions").eq("hotel_id", hotel.data.id).order("legal_name");
      if (error) throw error;
      return (data ?? []) as BusinessAccount[];
    },
  });
  const receivables = useQuery({
    queryKey: ["business-receivables", hotel.data?.id],
    enabled: Boolean(supabase && hotel.data?.id),
    queryFn: async () => {
      if (!supabase || !hotel.data) return [] as BusinessReceivable[];
      const { data, error } = await supabase.rpc("get_business_receivables", { target_hotel_id: hotel.data.id });
      if (error) throw error;
      return (data ?? []) as BusinessReceivable[];
    },
  });
  const payments = useQuery({
    queryKey: ["business-receivable-payments", hotel.data?.id],
    enabled: Boolean(supabase && hotel.data?.id),
    queryFn: async () => {
      if (!supabase || !hotel.data) return [] as ReceivablePayment[];
      const { data, error } = await supabase.rpc("get_business_receivable_payments", { target_hotel_id: hotel.data.id });
      if (error) throw error;
      return (data ?? []) as ReceivablePayment[];
    },
  });
  const ageing = useQuery({
    queryKey: ["business-receivable-ageing", hotel.data?.id],
    enabled: Boolean(supabase && hotel.data?.id),
    queryFn: async () => {
      if (!supabase || !hotel.data) return [] as ReceivableAgeing[];
      const { data, error } = await supabase.rpc("get_business_receivable_ageing", {
        target_hotel_id: hotel.data.id,
        target_as_of_date: null,
      });
      if (error) throw error;
      return (data ?? []) as ReceivableAgeing[];
    },
  });
  const statement = useQuery({
    queryKey: ["business-account-statement", statementAccountId, statementFromDate, statementToDate],
    enabled: Boolean(supabase && statementAccountId),
    queryFn: async () => {
      if (!supabase || !statementAccountId) return [] as StatementEntry[];
      const { data, error } = await supabase.rpc("get_business_account_statement", {
        target_business_account_id: statementAccountId,
        target_from_date: statementFromDate || null,
        target_to_date: statementToDate || null,
      });
      if (error) throw error;
      return (data ?? []) as StatementEntry[];
    },
  });

  async function refreshReceivables() {
    if (!hotel.data) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["business-receivables", hotel.data.id] }),
      queryClient.invalidateQueries({ queryKey: ["business-receivable-payments", hotel.data.id] }),
      queryClient.invalidateQueries({ queryKey: ["business-receivable-ageing", hotel.data.id] }),
      queryClient.invalidateQueries({ queryKey: ["business-account-statement"] }),
      queryClient.invalidateQueries({ queryKey: ["business-credit-positions", hotel.data.id] }),
      queryClient.invalidateQueries({ queryKey: ["business-credit-notes", hotel.data.id] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard", hotel.data.id] }),
    ]);
  }

  async function recordSettlement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !settlementTarget || !canSettle) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setMessage(null);
    try {
      const { error } = await supabase.rpc("record_business_receivable_payment", {
        target_receivable_id: settlementTarget.receivable_id,
        target_payment_method_id: String(values.get("paymentMethod")),
        payment_amount_kobo: nairaToKobo(String(values.get("amount"))),
        payment_reference: String(values.get("reference") || "") || null,
      });
      if (error) throw error;
      setSettlementTarget(null);
      setMessage("Company payment recorded. Payments requiring verification remain pending until reviewed.");
      await refreshReceivables();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Company payment could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  async function reviewPayment(form: HTMLFormElement, decision: "verify" | "reject") {
    if (!supabase || !reviewTarget || !canVerify) return;
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const note = String(values.get("reviewNote") || "");
    setBusy(true);
    setMessage(null);
    try {
      const { error } = decision === "verify"
        ? await supabase.rpc("verify_business_receivable_payment", { target_payment_id: reviewTarget.payment_id, verification_note_value: note })
        : await supabase.rpc("reject_business_receivable_payment", { target_payment_id: reviewTarget.payment_id, rejection_reason: note });
      if (error) throw error;
      setReviewTarget(null);
      setMessage(decision === "verify" ? "Company payment verified and receipt issued." : "Company payment rejected with an audit reason.");
      await refreshReceivables();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Payment review could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !hotel.data || !canManage) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setMessage(null);
    try {
      const { error } = await supabase.rpc("create_business_account", {
        target_hotel_id: hotel.data.id,
        account_type_value: String(values.get("accountType")),
        legal_name_value: String(values.get("legalName")),
        trading_name_value: String(values.get("tradingName") || "") || null,
        contact_name_value: String(values.get("contactName") || "") || null,
        contact_email_value: String(values.get("contactEmail") || "") || null,
        contact_phone_value: String(values.get("contactPhone") || "") || null,
        billing_address_value: null,
        tax_identifier_value: null,
        credit_limit_kobo_value: nairaToKobo(String(values.get("creditLimit"))),
        payment_terms_days_value: Number(values.get("paymentTerms")),
        direct_billing_enabled_value: values.get("directBilling") === "on",
        billing_instructions_value: String(values.get("instructions") || "") || null,
      });
      if (error) throw error;
      form.reset();
      setShowForm(false);
      setMessage("Business account created and added to the audit trail.");
      await queryClient.invalidateQueries({ queryKey: ["business-accounts", hotel.data.id] });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Business account could not be created.");
    } finally {
      setBusy(false);
    }
  }

  if (hotel.isLoading || access.isLoading || accounts.isLoading || receivables.isLoading || payments.isLoading || methods.isLoading || ageing.isLoading) return <PageLoading />;
  if (hotel.error || access.error || accounts.error || receivables.error || payments.error || methods.error || ageing.error) return <PageError message="Unable to load business accounts." />;
  if (!hotel.data) return <EmptyState>No hotel is assigned to this account.</EmptyState>;

  return (
    <section className="max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><p className="text-sm font-medium text-amber-800">Finance</p><h1 className="mt-1 text-3xl font-semibold tracking-tight">Business accounts</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">Maintain approved corporate and agency identities, credit limits, payment terms, and billing instructions.</p></div>
        {canManage && <button type="button" onClick={() => setShowForm((value) => !value)} className="rounded-xl bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white">{showForm ? "Close form" : "New business account"}</button>}
      </div>
      <div className="mt-5 flex gap-2 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900"><ShieldCheck className="mt-0.5 size-5 shrink-0"/><p>This register does not itself charge a company. Direct-bill settlement remains unavailable until a reservation is explicitly linked and its credit is validated.</p></div>
      {message && <p role="status" className="mt-4 rounded-xl bg-stone-100 p-4 text-sm">{message}</p>}
      {showForm && canManage && <form onSubmit={createAccount} className="mt-5 grid gap-4 rounded-2xl border bg-white p-5 shadow-sm sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Legal name" name="legalName" required />
        <Field label="Trading name" name="tradingName" />
        <label className="text-sm font-medium">Account type<select name="accountType" className="mt-2 w-full rounded-xl border px-3 py-2.5"><option value="corporate">Corporate</option><option value="agency">Agency</option></select></label>
        <Field label="Contact person" name="contactName" />
        <Field label="Contact email" name="contactEmail" type="email" />
        <Field label="Contact phone" name="contactPhone" />
        <Field label="Approved credit limit (naira)" name="creditLimit" type="number" min="0" defaultValue="0" required />
        <Field label="Payment terms (days)" name="paymentTerms" type="number" min="0" max="365" defaultValue="0" required />
        <label className="flex items-center gap-3 self-end rounded-xl border px-3 py-2.5 text-sm"><input name="directBilling" type="checkbox"/>Enable direct billing</label>
        <label className="text-sm font-medium sm:col-span-2 lg:col-span-3">Billing instructions<textarea name="instructions" rows={3} className="mt-2 w-full rounded-xl border px-3 py-2.5" /></label>
        <div className="sm:col-span-2 lg:col-span-3 flex justify-end"><FormSubmitButton disabled={busy} className="rounded-xl bg-amber-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{busy ? "Creating…" : "Create account"}</FormSubmitButton></div>
      </form>}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {(accounts.data ?? []).map((account) => <article key={account.id} className="rounded-2xl border bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3"><div className="flex gap-3"><span className="grid size-10 place-items-center rounded-xl bg-amber-50 text-amber-900"><Building2 className="size-5"/></span><div><h2 className="font-semibold">{account.trading_name || account.legal_name}</h2><p className="text-xs text-stone-500">{account.account_number} · {account.account_type}</p></div></div><span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs capitalize">{account.status}</span></div>
          {account.trading_name && <p className="mt-3 text-sm text-stone-600">Legal name: {account.legal_name}</p>}
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-stone-500">Credit limit</dt><dd className="font-semibold">{formatNaira(account.credit_limit_kobo)}</dd></div><div><dt className="text-stone-500">Payment terms</dt><dd className="font-semibold">{account.payment_terms_days} days</dd></div><div><dt className="text-stone-500">Direct billing</dt><dd className="font-semibold">{account.direct_billing_enabled ? "Approved" : "Disabled"}</dd></div><div><dt className="text-stone-500">Contact</dt><dd className="font-semibold">{account.contact_name || "Not provided"}</dd></div></dl>
          {(account.contact_email || account.contact_phone) && <p className="mt-3 text-xs text-stone-500">{[account.contact_email, account.contact_phone].filter(Boolean).join(" · ")}</p>}
          {account.billing_instructions && <p className="mt-3 rounded-xl bg-stone-50 p-3 text-xs leading-5 text-stone-600">{account.billing_instructions}</p>}
        </article>)}
      </div>
      {!accounts.data?.length && <div className="mt-6"><EmptyState>No corporate or agency accounts have been created.</EmptyState></div>}
      <div className="mt-10 flex items-end justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-800">Accounts receivable</p><h2 className="mt-1 text-xl font-semibold">Direct-bill ageing</h2><p className="mt-1 text-sm text-stone-600">Company obligations created from approved guest checkouts. They are not guest payments or cash receipts.</p></div><p className="text-sm font-semibold">Outstanding {formatNaira(receivables.data?.reduce((sum, item) => sum + item.outstanding_kobo, 0) ?? 0)}</p></div>
      <div className="mt-4 overflow-x-auto rounded-2xl border bg-white shadow-sm"><table className="w-full min-w-225 text-left text-sm"><thead className="bg-stone-50 text-stone-500"><tr><th className="px-4 py-3">Receivable</th><th className="px-4 py-3">Account</th><th className="px-4 py-3">Invoice / folio</th><th className="px-4 py-3">Outstanding</th><th className="px-4 py-3">Due</th><th className="px-4 py-3">Status</th>{canSettle && <th className="px-4 py-3">Action</th>}</tr></thead><tbody>{receivables.data?.map((item) => <tr key={item.receivable_id} className="border-t"><td className="px-4 py-3 font-semibold">{item.receivable_number}</td><td className="px-4 py-3">{item.account_name}<span className="block text-xs text-stone-500">{item.account_number}</span></td><td className="px-4 py-3">{item.invoice_number || "Checkout pending"}<span className="block text-xs text-stone-500">{item.folio_number}</span></td><td className="px-4 py-3 font-semibold">{formatNaira(item.outstanding_kobo)}</td><td className="px-4 py-3">{item.due_date}{item.days_overdue > 0 && <span className="block text-xs font-semibold text-red-700">{item.days_overdue} days overdue</span>}</td><td className="px-4 py-3 capitalize">{item.status.replace("_", " ")}</td>{canSettle && <td className="px-4 py-3">{item.outstanding_kobo > 0 && item.status !== "voided" ? <button type="button" onClick={() => setSettlementTarget(item)} className="font-semibold text-amber-900 hover:underline">Record settlement</button> : <span className="text-stone-400">Complete</span>}</td>}</tr>)}</tbody></table>{!receivables.data?.length && <p className="p-6 text-sm text-stone-500">No direct-bill receivables have been created.</p>}</div>

      <BusinessCreditControls hotelId={hotel.data.id} hotelName={hotel.data.trading_name} roleCodes={access.roleCodes} receivables={receivables.data ?? []} payments={payments.data ?? []} onChange={refreshReceivables} />

      <section className="mt-10 rounded-2xl border bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-800">Debtor report</p><h2 className="mt-1 text-xl font-semibold">Receivable ageing by company</h2><p className="mt-1 text-sm text-stone-600">Outstanding verified balances grouped by how long they have been overdue.</p></div>
          <button type="button" disabled={!ageing.data?.length} onClick={() => downloadCsv("company-receivable-ageing.csv", [["Account number", "Company", "Current (kobo)", "1-30 days (kobo)", "31-60 days (kobo)", "61-90 days (kobo)", "Over 90 days (kobo)", "Total outstanding (kobo)"], ...(ageing.data ?? []).map((row) => [row.account_number, row.account_name, row.current_kobo, row.days_1_30_kobo, row.days_31_60_kobo, row.days_61_90_kobo, row.over_90_days_kobo, row.total_outstanding_kobo])])} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold disabled:opacity-50"><Download className="size-4"/>Export ageing CSV</button>
        </div>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-225 text-left text-sm"><thead className="border-b text-stone-500"><tr><th className="py-3 pr-4">Company</th><th className="px-4 py-3">Current</th><th className="px-4 py-3">1–30 days</th><th className="px-4 py-3">31–60 days</th><th className="px-4 py-3">61–90 days</th><th className="px-4 py-3">90+ days</th><th className="px-4 py-3">Total</th><th className="py-3 pl-4">Statement</th></tr></thead><tbody>{ageing.data?.map((row) => <tr key={row.business_account_id} className="border-b last:border-0"><td className="py-3 pr-4 font-semibold">{row.account_name}<span className="block text-xs font-normal text-stone-500">{row.account_number}</span></td><td className="px-4 py-3">{formatNaira(row.current_kobo)}</td><td className="px-4 py-3">{formatNaira(row.days_1_30_kobo)}</td><td className="px-4 py-3">{formatNaira(row.days_31_60_kobo)}</td><td className="px-4 py-3">{formatNaira(row.days_61_90_kobo)}</td><td className="px-4 py-3">{formatNaira(row.over_90_days_kobo)}</td><td className="px-4 py-3 font-semibold">{formatNaira(row.total_outstanding_kobo)}</td><td className="py-3 pl-4"><button type="button" onClick={() => setStatementAccountId(row.business_account_id)} className="inline-flex items-center gap-1 font-semibold text-amber-900 hover:underline"><FileText className="size-4"/>View</button></td></tr>)}</tbody></table>{!ageing.data?.length && <p className="py-5 text-sm text-stone-500">There are no outstanding company balances.</p>}</div>
      </section>

      <section className="mt-10 rounded-2xl border bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-800">Account statement</p><h2 className="mt-1 text-xl font-semibold">Company ledger</h2><p className="mt-1 text-sm text-stone-600">Receivable debits, completed payments, refunds, and the resulting running balance.</p></div>{statementAccountId && <button type="button" disabled={!statement.data?.length} onClick={() => downloadCsv(`company-statement-${accounts.data?.find((account) => account.id === statementAccountId)?.account_number ?? "account"}.csv`, [["Date", "Type", "Document", "Related document", "Reference", "Debit (kobo)", "Credit (kobo)", "Running balance (kobo)"], ...(statement.data ?? []).map((row) => [row.occurred_at, row.entry_type, row.document_number, row.related_document, row.reference, row.debit_kobo, row.credit_kobo, row.running_balance_kobo])])} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold disabled:opacity-50"><Download className="size-4"/>Export statement CSV</button>}</div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3"><label className="text-sm font-medium">Company<select value={statementAccountId} onChange={(event) => setStatementAccountId(event.target.value)} className="mt-2 w-full rounded-xl border px-3 py-2.5"><option value="">Select company</option>{accounts.data?.map((account) => <option key={account.id} value={account.id}>{account.trading_name || account.legal_name} · {account.account_number}</option>)}</select></label><Field label="From date" name="statementFrom" type="date" value={statementFromDate} onChange={setStatementFromDate}/><Field label="To date" name="statementTo" type="date" value={statementToDate} onChange={setStatementToDate}/></div>
        {statement.error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">Unable to load this company statement.</p>}
        {statement.isFetching && statementAccountId && <p className="mt-4 text-sm text-stone-500">Loading statement…</p>}
        {statementAccountId && !statement.isFetching && !statement.error && <div className="mt-4 overflow-x-auto"><table className="w-full min-w-225 text-left text-sm"><thead className="border-b text-stone-500"><tr><th className="py-3 pr-4">Date</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Document</th><th className="px-4 py-3">Reference</th><th className="px-4 py-3">Debit</th><th className="px-4 py-3">Credit</th><th className="py-3 pl-4">Balance</th></tr></thead><tbody>{statement.data?.map((row) => <tr key={`${row.entry_type}-${row.entry_id}`} className="border-b last:border-0"><td className="py-3 pr-4">{new Date(row.occurred_at).toLocaleString("en-GB")}</td><td className="px-4 py-3 capitalize">{row.entry_type}</td><td className="px-4 py-3 font-semibold">{row.document_number}<span className="block text-xs font-normal text-stone-500">{row.related_document}</span></td><td className="px-4 py-3">{row.reference || "—"}</td><td className="px-4 py-3">{row.debit_kobo ? formatNaira(row.debit_kobo) : "—"}</td><td className="px-4 py-3">{row.credit_kobo ? formatNaira(row.credit_kobo) : "—"}</td><td className="py-3 pl-4 font-semibold">{formatNaira(row.running_balance_kobo)}</td></tr>)}</tbody></table>{!statement.data?.length && <p className="py-5 text-sm text-stone-500">No statement activity falls within the selected dates.</p>}</div>}
      </section>

      <div className="mt-10"><p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-800">Settlement history</p><h2 className="mt-1 text-xl font-semibold">Company payments and receipts</h2><p className="mt-1 text-sm text-stone-600">Every entry uses the hotel payment ledger. Transfer payments remain pending until an authorised reviewer confirms them.</p></div>
      <div className="mt-4 overflow-x-auto rounded-2xl border bg-white shadow-sm"><table className="w-full min-w-225 text-left text-sm"><thead className="bg-stone-50 text-stone-500"><tr><th className="px-4 py-3">Payment</th><th className="px-4 py-3">Receivable</th><th className="px-4 py-3">Method</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Receipt</th>{canVerify && <th className="px-4 py-3">Review</th>}</tr></thead><tbody>{payments.data?.map((payment) => <tr key={payment.payment_id} className="border-t"><td className="px-4 py-3 font-semibold">{payment.payment_number}<span className="block text-xs font-normal text-stone-500">{new Date(payment.received_at).toLocaleString("en-GB")}</span></td><td className="px-4 py-3">{payment.receivable_number}<span className="block text-xs text-stone-500">{payment.account_name}</span></td><td className="px-4 py-3">{payment.payment_method_name}{payment.reference && <span className="block text-xs text-stone-500">Ref: {payment.reference}</span>}</td><td className="px-4 py-3 font-semibold">{formatNaira(payment.amount_kobo)}</td><td className="px-4 py-3"><span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${payment.status === "completed" ? "bg-emerald-50 text-emerald-800" : payment.status === "pending_verification" ? "bg-amber-50 text-amber-800" : "bg-stone-100 text-stone-700"}`}>{payment.status === "pending_verification" ? <Clock3 className="size-3.5"/> : payment.status === "completed" ? <CheckCircle2 className="size-3.5"/> : null}{payment.status.replace("_", " ")}</span></td><td className="px-4 py-3">{payment.receipt_number || "Not issued"}</td>{canVerify && <td className="px-4 py-3">{payment.status === "pending_verification" ? <button type="button" onClick={() => setReviewTarget(payment)} className="font-semibold text-amber-900 hover:underline">Review</button> : <span className="text-stone-400">—</span>}</td>}</tr>)}</tbody></table>{!payments.data?.length && <p className="p-6 text-sm text-stone-500">No company settlement has been recorded.</p>}</div>
      <Modal open={Boolean(settlementTarget)} title="Record company settlement" onClose={() => !busy && setSettlementTarget(null)}>
        {settlementTarget && <form onSubmit={recordSettlement} className="space-y-4"><div className="rounded-xl bg-stone-50 p-4 text-sm"><p className="font-semibold">{settlementTarget.account_name}</p><p className="mt-1 text-stone-600">{settlementTarget.receivable_number} · Outstanding {formatNaira(settlementTarget.outstanding_kobo)}</p></div><Field label="Amount received (naira)" name="amount" type="number" min="0.01" defaultValue={(settlementTarget.outstanding_kobo / 100).toFixed(2)} required /><label className="block text-sm font-medium">Payment method<select name="paymentMethod" required className="mt-2 w-full rounded-xl border px-3 py-2.5"><option value="">Select method</option>{methods.data?.map((method) => <option key={method.id} value={method.id}>{method.name}{method.requires_verification ? " — verification required" : ""}</option>)}</select></label><Field label="Reference (required where configured)" name="reference" /><div className="flex justify-end gap-2 pt-2"><button type="button" disabled={busy} onClick={() => setSettlementTarget(null)} className="rounded-xl border px-4 py-2.5 text-sm font-semibold">Cancel</button><FormSubmitButton disabled={busy} className="rounded-xl bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{busy ? "Recording…" : "Record payment"}</FormSubmitButton></div></form>}
      </Modal>
      <Modal open={Boolean(reviewTarget)} title="Review company payment" onClose={() => !busy && setReviewTarget(null)}>
        {reviewTarget && <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void reviewPayment(event.currentTarget, "verify"); }}><div className="rounded-xl bg-stone-50 p-4 text-sm"><p className="font-semibold">{reviewTarget.payment_number} · {formatNaira(reviewTarget.amount_kobo)}</p><p className="mt-1 text-stone-600">{reviewTarget.account_name} · {reviewTarget.receivable_number}</p></div><label className="block text-sm font-medium">Review note<textarea name="reviewNote" required rows={3} className="mt-2 w-full rounded-xl border px-3 py-2.5" placeholder="State how the payment was verified or why it is rejected." /></label><div className="flex flex-wrap justify-end gap-2 pt-2"><button type="button" disabled={busy} onClick={() => setReviewTarget(null)} className="rounded-xl border px-4 py-2.5 text-sm font-semibold">Cancel</button><FormSubmitButton type="button" disabled={busy} onClick={(event) => { const form = event.currentTarget.form; if (form) void reviewPayment(form, "reject"); }} className="rounded-xl border border-red-300 px-4 py-2.5 text-sm font-semibold text-red-700">Reject</FormSubmitButton><FormSubmitButton type="submit" disabled={busy} className="rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white">Verify and issue receipt</FormSubmitButton></div></form>}
      </Modal>
    </section>
  );
}

function Field(props: {label:string; name:string; type?:string; min?:string; max?:string; defaultValue?:string; required?:boolean; value?:string; onChange?:(value:string)=>void}) {
  const { label, onChange, ...inputProps } = props;
  return <label className="text-sm font-medium">{label}<input {...inputProps} onChange={onChange ? (event) => onChange(event.target.value) : undefined} aria-label={label} className="mt-2 w-full rounded-xl border px-3 py-2.5" /></label>;
}

function downloadCsv(filename: string, rows: Array<Array<string | number | null>>) {
  const content = rows.map((row) => row.map((value) => {
    let text = value === null ? "" : String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
