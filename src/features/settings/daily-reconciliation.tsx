import { FormSubmitButton } from "@/components/shared/form-submit-button";
import { useActionMessage } from "@/components/shared/action-feedback";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "@/features/auth/auth-provider";
import { useAccess } from "@/features/auth/use-access";
import { formatNaira } from "@/lib/money";
import { supabase } from "@/lib/supabase/client";
import {
  buildReconciliationCsv, departmentNames, expectedClosing, parseReconciliationAmount, reconciliationAmountInput, sameReconciliationSource,
  type AccountDeclaration, type DailyReconciliation as DailyData, type ReconciliationRecord, type ReconciliationSource,
} from "./internal-reconciliation";

const inputClass = "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm disabled:bg-stone-100";
const buttonClass = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";
const blockerLabels: Record<string, string> = {
  pending_payments: "Payments awaiting verification", unmapped_payments: "Payment or refund records without a funding account",
  unfunded_expenses: "Expenses without a funding account and payment date (including earlier incurred dates)",
  pending_expenses: "Paid expenses awaiting review", open_shifts: "Open cashier shifts", unreviewed_hotel_shifts: "Closed hotel shifts awaiting independent review",
  unconfirmed_combined_payments: "One-payment exceptions awaiting accountant confirmation or disputed",
};
type RunAction = (name: string, args: Record<string, unknown>) => Promise<boolean>;
type Draft = { opening: string; closing: string; evidence: string; note: string };
const formData = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); return new FormData(event.currentTarget); };
const errorMessage = (error: unknown) => error && typeof error === "object" && "message" in error ? String(error.message) : "Unable to complete this action.";

function download(source: ReconciliationSource, record?: ReconciliationRecord) {
  const url = URL.createObjectURL(new Blob(["\uFEFF", buildReconciliationCsv(source, record)], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = `internal-reconciliation-${source.business_date}-${record?.status ?? "preview"}.csv`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DailyReconciliation({ hotelId }: { hotelId: string }) {
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useActionMessage<{ message: string; error: boolean } | null>(null);
  const queryClient = useQueryClient();
  const access = useAccess();
  const { session } = useAuth();
  const report = useQuery({
    queryKey: ["internal-daily-reconciliation", hotelId, date],
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!supabase) throw new Error("Supabase is not configured.");
      const { data, error } = await supabase.rpc("get_internal_daily_reconciliation", { target_hotel_id: hotelId, date_value: date || null });
      if (error) throw error;
      return data as DailyData;
    },
  });
  const canSubmit = access.roleCodes.some((r) => ["owner", "general_manager", "accountant"].includes(r));
  const canReview = access.roleCodes.some((r) => ["owner", "general_manager", "accountant"].includes(r));
  const run: RunAction = async (name, args) => {
    if (!supabase || busy) return false;
    setBusy(true); setNotice(null);
    try {
      const { error } = await supabase.rpc(name, args);
      if (error) throw error;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["internal-daily-reconciliation", hotelId] }),
        queryClient.invalidateQueries({ queryKey: ["internal-collection-expense-summary", hotelId] }),
        queryClient.invalidateQueries({ queryKey: ["activity-register"] }),
      ]);
      setNotice({ message: "Reconciliation record saved.", error: false });
      return true;
    } catch (error) {
      setNotice({ message: errorMessage(error), error: true });
      return false;
    } finally { setBusy(false); }
  };

  return <section className="space-y-4 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5" aria-label="Daily internal reconciliation">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><h2 className="text-xl font-semibold">Daily reconciliation</h2><p className="mt-1 text-sm text-stone-600">Match expected money to a cash count or bank settlement, then record a documented review.</p></div>
      <div className="flex items-end gap-2"><label className="text-xs text-stone-600">Business date<input type="date" aria-label="Daily reconciliation business date" className={`${inputClass} mt-1`} value={date || report.data?.source.business_date || ""} max={report.data?.current_business_date} disabled={busy} onChange={(e) => { setDate(e.target.value); setNotice(null); }} /></label>
        <button className={buttonClass} disabled={busy || report.isFetching} onClick={() => void report.refetch()} aria-label="Refresh daily reconciliation"><RefreshCw className={`size-4 ${report.isFetching ? "animate-spin" : ""}`} /></button></div>
    </div>
    <p className="rounded-xl bg-stone-50 p-3 text-sm leading-6 text-stone-600">Expected closing = opening + completed collections − refunds − expenses paid from this account + other documented movements. Enter the balance attributable to each business line and payment method; a shared bank balance must be allocated once. Card or transfer receipts still awaiting bank settlement need a variance explanation. Cashier shifts below are supporting evidence; their floats and counts are not added again.</p>
    <div className="flex flex-wrap gap-4 text-sm text-amber-900 underline"><Link to="/payments">Hotel payments and cashier review</Link><Link to="/expenses">Expense review</Link><Link to="/restaurant-pos">Restaurant POS</Link><Link to="/bar-pos">Bar POS</Link></div>
    {notice && <p role={notice.error ? "alert" : "status"} className={`rounded-lg p-3 text-sm ${notice.error ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-800"}`}>{notice.message}</p>}
    {report.isLoading && <p className="text-sm text-stone-500">Loading daily evidence…</p>}
    {(report.error || access.error) && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{errorMessage(report.error ?? access.error)}</p>}
    {report.data && <ReconciliationWorkspace key={`${hotelId}:${report.data.source.business_date}`} data={report.data} hotelId={hotelId} userId={session?.user.id} canSubmit={canSubmit} canReview={canReview} canAccountantSelfReview={access.roleCodes.includes("accountant")} busy={busy || access.isLoading || Boolean(report.error)} run={run} />}
  </section>;
}

function ReconciliationWorkspace({ data, hotelId, userId, canSubmit, canReview, canAccountantSelfReview, busy, run }: {
  data: DailyData; hotelId: string; userId?: string; canSubmit: boolean; canReview: boolean; canAccountantSelfReview: boolean; busy: boolean; run: RunAction;
}) {
  const [view, setView] = useState("latest");
  const pending = data.history.find((r) => r.status === "submitted");
  const approved = data.history.find((r) => r.status === "approved");
  const active = pending ?? approved;
  const record = view === "live" ? undefined : view === "latest" ? active : data.history.find((r) => r.id === view);
  const source = record?.source_snapshot ?? data.source;
  const changed = record && !sameReconciliationSource(record.source_snapshot, data.source);
  const correction = Boolean(approved);
  const editable = canSubmit && !pending && !record && !busy;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-3"><label className="text-xs text-stone-600">Report version<select className={`${inputClass} mt-1`} value={view} disabled={busy} onChange={(e) => setView(e.target.value)}>
      <option value="latest">{active ? `Current ${active.status} snapshot` : "Live records"}</option><option value="live">Live records</option>
      {data.history.map((r) => <option key={r.id} value={r.id}>{r.status} · {new Date(r.submitted_at).toLocaleString()} · {r.id.slice(0, 8)}</option>)}
    </select></label><button className={`${buttonClass} flex items-center gap-2`} onClick={() => download(source, record)}><Download className="size-4" />Export {record ? "snapshot" : "live preview"}</button></div>
    {record && <div className="rounded-xl border border-stone-200 p-3 text-sm leading-6"><p className="font-semibold capitalize">{record.status} · {record.business_date}{record.reviewed_by && record.reviewed_by === record.submitted_by ? " · Self-reviewed" : ""}</p><p>Submitted {new Date(record.submitted_at).toLocaleString()} · Staff ID {record.submitted_by}</p>{record.reviewed_at && <p>Reviewed {new Date(record.reviewed_at).toLocaleString()} · Staff ID {record.reviewed_by}</p>}{record.review_note && <p>Review: {record.review_note}</p>}{record.exception_note && <p>Exceptions: {record.exception_note}</p>}</div>}
    {changed && <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">Source records have changed since this snapshot. {record.status === "submitted" ? "Reject this submission and prepare a new one before approval." : "The signed snapshot remains preserved. Select Live records to investigate the changes."}</p>}
    {active && !record && <p className="text-sm text-stone-600">This date has a {active.status} reconciliation. {pending ? "Reject the pending submission before making corrections." : "Explain any correction and submit the revised figures for documented review. Earlier signed versions remain preserved."}</p>}
    <div className="rounded-xl border border-stone-200 p-3"><h3 className="font-semibold">Checks before submission</h3><ul className="mt-2 space-y-1 text-sm">{Object.entries(source.blockers).map(([key, count]) => <li key={key} className={count ? "text-red-800" : "text-emerald-800"}>{blockerLabels[key] ?? key}: {count}</li>)}</ul></div>
    {(source.hotel_collected_for_outlets_kobo ?? 0) > 0 && <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">Of the hotel's recorded collections, {formatNaira(source.hotel_collected_for_outlets_kobo)} was received on behalf of independent restaurant/bar businesses. This is not hotel room revenue and must not be counted again as an outlet tender. Document its settlement separately.</p>}
    <AccountDeclarations key={record?.id ?? `draft:${source.accounts.map((a) => `${a.id}:${a.previous_closing_kobo ?? "none"}`).join()}`} source={source} record={record} hotelId={hotelId} editable={editable} correction={correction} run={run} />
    {record?.status === "submitted" && <ReviewForm record={record} canReview={canReview && (record.submitted_by !== userId || canAccountantSelfReview)} busy={busy} changed={Boolean(changed)} run={run} />}
    {!record && canSubmit && <details className="rounded-xl border border-stone-200 p-3"><summary className="cursor-pointer font-semibold">Set up funding accounts and document other movements</summary><p className="mt-2 text-sm text-stone-600">Create one named drawer or settlement account for each business line and payment method used. Other movements record transfers, deposits, or corrections already made outside this app; use a negative amount for money out. Record both sides of an internal transfer. These entries do not move money. Correct mistakes with an opposite entry and a reference to the original.</p><SetupForms hotelId={hotelId} data={data} disabled={Boolean(pending) || busy} run={run} /></details>}
    <SourceEvidence source={source} editable={!record && canSubmit && !pending && !busy} run={run} />
  </div>;
}

function AccountDeclarations({ source, record, hotelId, editable, correction, run }: {
  source: ReconciliationSource; record?: ReconciliationRecord; hotelId: string; editable: boolean; correction: boolean; run: RunAction;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(source.accounts.map((a) => {
    const d = record?.declarations.find((item) => item.account_id === a.id);
    return [a.id, { opening: d ? reconciliationAmountInput(d.opening_kobo) : a.previous_closing_kobo == null ? "" : reconciliationAmountInput(a.previous_closing_kobo), closing: d ? reconciliationAmountInput(d.closing_kobo) : "", evidence: d?.evidence_reference ?? "", note: d?.variance_note ?? "" }];
  })));
  const [exceptionNote, setExceptionNote] = useState(record?.exception_note ?? "");
  const [error, setError] = useActionMessage<string>("", "error");
  const blocked = Object.values(source.blockers).some((count) => count > 0) || source.accounts.length === 0;
  const update = (id: string, field: keyof Draft, value: string) => setDrafts((current) => ({ ...current, [id]: { ...current[id], [field]: value } }));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    try {
      const declarations: AccountDeclaration[] = source.accounts.map((a) => {
        const d = drafts[a.id];
        const opening = parseReconciliationAmount(d.opening); const closing = parseReconciliationAmount(d.closing);
        const variance = closing - expectedClosing(a, opening);
        if (!Number.isSafeInteger(variance)) throw new Error("Amount exceeds supported precision.");
        if (a.previous_closing_kobo !== null && opening !== a.previous_closing_kobo) throw new Error("Opening must match the previous approved closing balance.");
        if (d.evidence.trim().length < 3) throw new Error("Provide cash-count or bank-statement evidence for every account.");
        if (variance !== 0 && d.note.trim().length < 3) throw new Error("Explain every variance.");
        return { account_id: a.id, opening_kobo: opening, closing_kobo: closing, evidence_reference: d.evidence.trim(), variance_note: d.note.trim() };
      });
      await run("submit_internal_daily_reconciliation", { target_hotel_id: hotelId, date_value: source.business_date, declarations_value: declarations, exception_note_value: exceptionNote, expected_source_value: source });
    } catch (caught) { setError(errorMessage(caught)); }
  }
  return <form onSubmit={(e) => void submit(e)} className="space-y-3">
    <h3 className="font-semibold">Account balances and actual money</h3>
    {!source.accounts.length && <p className="text-sm text-stone-600">Set up the funding accounts below to begin.</p>}
    <fieldset disabled={!editable} className="grid gap-3 lg:grid-cols-2">{source.accounts.map((a) => {
      const draft = drafts[a.id];
      let expected: number | null = null; let variance: number | null = null;
      try { expected = expectedClosing(a, parseReconciliationAmount(draft.opening)); variance = parseReconciliationAmount(draft.closing) - expected; } catch { /* Empty or invalid amounts are validated on submit. */ }
      return <article key={a.id} className="space-y-3 rounded-xl border border-stone-200 bg-stone-50 p-4"><h4 className="font-semibold">{departmentNames[a.department]} · {a.method_name}<span className="mt-1 block text-sm font-normal text-stone-600">{a.name}</span></h4>
        <dl className="grid grid-cols-2 gap-2 text-sm"><dt>Collections</dt><dd className="text-right">{formatNaira(a.collections_kobo)}</dd><dt>Refunds</dt><dd className="text-right">{formatNaira(a.refunds_kobo)}</dd><dt>Expenses paid</dt><dd className="text-right">{formatNaira(a.expenses_kobo)}</dd><dt>Other movements</dt><dd className="text-right">{formatNaira(a.movements_kobo)}</dd></dl>
        <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs">Opening balance (NGN)<input className={`${inputClass} mt-1`} inputMode="decimal" required value={draft.opening} readOnly={a.previous_closing_kobo !== null} onChange={(e) => update(a.id, "opening", e.target.value)} /></label><label className="text-xs">Actual closing balance (NGN)<input className={`${inputClass} mt-1`} inputMode="decimal" required value={draft.closing} onChange={(e) => update(a.id, "closing", e.target.value)} /></label></div>
        <p className="text-xs text-stone-600">{a.previous_closing_kobo === null ? "No previous-day approved balance. Opening evidence must be included below." : "Opening carried from the previous approved day."}</p>
        <p className="text-sm font-medium">Expected closing: {expected === null ? "Enter opening balance" : formatNaira(expected)}<span className={`mt-1 block ${variance ? "text-red-800" : "text-stone-700"}`}>Overage / (shortage): {variance === null ? "Enter actual closing" : formatNaira(variance)}</span></p>
        <label className="block text-xs">Cash count / bank evidence reference<input className={`${inputClass} mt-1`} required minLength={3} maxLength={500} value={draft.evidence} onChange={(e) => update(a.id, "evidence", e.target.value)} /></label>
        <label className="block text-xs">Variance explanation<textarea className={`${inputClass} mt-1`} required={variance !== null && variance !== 0} maxLength={500} value={draft.note} onChange={(e) => update(a.id, "note", e.target.value)} /></label>
      </article>;
    })}</fieldset>
    {!record && <><label className="block text-sm">Exception explanation (required for corrections or rejected paid expenses)<textarea className={`${inputClass} mt-1`} disabled={!editable} maxLength={2000} required={correction || source.expenses.some((e) => e.status === "rejected")} value={exceptionNote} onChange={(e) => setExceptionNote(e.target.value)} /></label>{error && <p role="alert" className="text-sm text-red-800">{error}</p>}<FormSubmitButton className={`${buttonClass} border-amber-900 bg-amber-950 text-white`} disabled={!editable || blocked}>Submit for review</FormSubmitButton></>}
  </form>;
}

function ReviewForm({ record, canReview, busy, changed, run }: { record: ReconciliationRecord; canReview: boolean; busy: boolean; changed: boolean; run: RunAction }) {
  return <form className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3" onSubmit={(e) => {
    const form = formData(e); const decision = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
    if (decision) void run("review_internal_daily_reconciliation", { target_id: record.id, decision_value: decision, note_value: String(form.get("note")) });
  }}><p className="text-sm">A review note is required. Accountant self-review is flagged in the audit trail; other roles cannot review their own submission.</p><fieldset disabled={busy || !canReview}><label className="text-sm">Review note<textarea name="note" className={`${inputClass} mt-1`} required minLength={3} maxLength={2000} /></label><div className="mt-2 flex gap-2"><FormSubmitButton className={buttonClass} value="approved" disabled={changed}>Approve snapshot</FormSubmitButton><FormSubmitButton className={buttonClass} value="rejected">Reject for correction</FormSubmitButton></div></fieldset></form>;
}

function SetupForms({ hotelId, data, disabled, run }: { hotelId: string; data: DailyData; disabled: boolean; run: RunAction }) {
  const [error, setError] = useActionMessage<string>("", "error");
  return <fieldset disabled={disabled} className="mt-4 grid gap-4 md:grid-cols-2"><form className="space-y-2" onSubmit={(e) => {
    const form = formData(e); const element = e.currentTarget;
    void run("create_internal_funding_account", { target_hotel_id: hotelId, department_value: String(form.get("department")), method_id: String(form.get("method")), name_value: String(form.get("name")) }).then((ok) => { if (ok) element.reset(); });
  }}><h4 className="text-sm font-semibold">Create funding account</h4><label className="block text-xs">Business line<select name="department" className={`${inputClass} mt-1`}>{Object.entries(departmentNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label className="block text-xs">Payment method<select name="method" className={`${inputClass} mt-1`} required>{data.payment_methods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="block text-xs">Drawer / settlement account name<input name="name" className={`${inputClass} mt-1`} required minLength={3} maxLength={120} /></label><FormSubmitButton className={buttonClass}>Create account</FormSubmitButton></form>
    <form className="space-y-2" onSubmit={(e) => {
      const form = formData(e); const element = e.currentTarget; setError("");
      try {
        const magnitude = parseReconciliationAmount(String(form.get("amount"))); if (!magnitude) throw new Error("Movement amount must be greater than zero.");
        void run("record_internal_fund_movement", { target_account_id: String(form.get("account")), date_value: data.source.business_date, amount_value_kobo: form.get("direction") === "out" ? -magnitude : magnitude, reference_value: String(form.get("reference")), reason_value: String(form.get("reason")) }).then((ok) => { if (ok) element.reset(); });
      } catch (caught) { setError(errorMessage(caught)); }
    }}><h4 className="text-sm font-semibold">Document another money movement</h4><label className="block text-xs">Account<select name="account" className={`${inputClass} mt-1`} required>{data.source.accounts.map((a) => <option key={a.id} value={a.id}>{departmentNames[a.department]} · {a.name}</option>)}</select></label><div className="grid grid-cols-2 gap-2"><label className="text-xs">Direction<select name="direction" className={`${inputClass} mt-1`}><option value="out">Money out</option><option value="in">Money in</option></select></label><label className="text-xs">Amount (NGN)<input name="amount" className={`${inputClass} mt-1`} inputMode="decimal" required /></label></div><label className="block text-xs">Evidence reference<input name="reference" className={`${inputClass} mt-1`} required minLength={3} maxLength={500} /></label><label className="block text-xs">Reason<input name="reason" className={`${inputClass} mt-1`} required minLength={3} maxLength={500} /></label>{error && <p role="alert" className="text-sm text-red-800">{error}</p>}<FormSubmitButton className={buttonClass}>Record movement</FormSubmitButton></form></fieldset>;
}

function SourceEvidence({ source, editable, run }: { source: ReconciliationSource; editable: boolean; run: RunAction }) {
  return <div className="space-y-3"><h3 className="font-semibold">Source evidence</h3><p className="text-sm text-stone-600">Expand an account to trace its collections, refunds, paid expenses, and other movements.</p>{source.accounts.map((a) => <details key={a.id} className="rounded-xl border border-stone-200 p-3"><summary className="cursor-pointer text-sm font-medium">{departmentNames[a.department]} · {a.name} · {a.method_name}</summary><EventTable events={source.events.filter((e) => e.department === a.department && e.payment_method_id === a.payment_method_id)} /><div className="mt-3 space-y-2 text-sm">{source.expenses.filter((e) => e.account_id === a.id).map((e) => <p key={e.id}>{e.expense_number} · {e.description} · {e.payee} · {formatNaira(e.amount_kobo)} · {e.status} · Paid {e.paid_on} · {e.funding_reference}{e.review_note && ` · Review: ${e.review_note}`}</p>)}{source.movements.filter((m) => m.account_id === a.id).map((m) => <p key={m.id}>{formatNaira(m.amount_kobo)} · {m.reason} · {m.evidence_reference} · Movement ID {m.id}</p>)}</div></details>)}
    <details className="rounded-xl border border-stone-200 p-3"><summary className="cursor-pointer text-sm font-medium">All payment and refund records ({source.events.length})</summary><EventTable events={source.events} /></details>
    <details className="rounded-xl border border-stone-200 p-3" open={source.expenses.some((e) => !e.account_id)}><summary className="cursor-pointer text-sm font-medium">Expense funding and evidence ({source.expenses.length})</summary><p className="mt-2 text-xs text-stone-600">Unassigned expenses incurred on or before this date must be linked to their actual payment business date. Paid totals include rejected expenses because rejection does not recover money.</p><div className="mt-3 space-y-3">{source.expenses.map((e) => <div key={e.id} className="rounded-lg bg-stone-50 p-3 text-sm"><p className="font-medium">{e.expense_number} · {departmentNames[e.department]} · {formatNaira(e.amount_kobo)} · {e.status}</p><p>{e.description} · {e.payee} · Incurred {e.incurred_on}</p><p className="text-xs text-stone-600">Recorded paid via: {e.paid_via} · Evidence: {e.evidence_reference ?? "None"}</p>{e.funding_reference && <p className="text-xs text-stone-600">Paid {e.paid_on} · Funding evidence: {e.funding_reference}</p>}{e.review_note && <p className="text-xs text-stone-600">Review: {e.review_note}</p>}
      {editable && <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(event) => { const form = formData(event); void run("record_internal_expense_funding", { target_expense_id: e.id, target_account_id: String(form.get("account")), paid_on_value: String(form.get("paidOn")), reference_value: String(form.get("reference")) }); }}><label className="text-xs">Funding account<select name="account" className={`${inputClass} mt-1`} defaultValue={e.account_id ?? ""} required><option value="" disabled>Choose account</option>{source.accounts.filter((a) => a.department === e.department).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label className="text-xs">Payment business date<input type="date" name="paidOn" className={`${inputClass} mt-1`} defaultValue={e.paid_on ?? source.business_date} required /></label><label className="grow text-xs">Payment evidence<input name="reference" className={`${inputClass} mt-1`} defaultValue={e.funding_reference ?? e.evidence_reference ?? ""} required minLength={3} maxLength={500} /></label><FormSubmitButton className={buttonClass}>Save funding</FormSubmitButton></form>}
    </div>)}</div></details>
    <details className="rounded-xl border border-stone-200 p-3"><summary className="cursor-pointer text-sm font-medium">Cashier shift reconciliation ({source.shifts.length})</summary><div className="mt-3 space-y-3 text-sm">{!source.shifts.length && <p>No shifts recorded for this date.</p>}{source.shifts.map((s) => <div key={s.id}><p className="font-medium">{departmentNames[s.department]} · {s.shift_number} · {s.status} · {s.business_date}</p><p>Float {formatNaira(s.opening_float_kobo)} · Expected {s.expected_cash_kobo === null ? "Not closed" : formatNaira(s.expected_cash_kobo)} · Counted {s.declared_cash_kobo === null ? "Not counted" : formatNaira(s.declared_cash_kobo)} · Variance {s.variance_kobo === null ? "Pending" : formatNaira(s.variance_kobo)}</p><p className="text-xs text-stone-600">{s.variance_reason ?? "No variance reason"} · Handover {s.handover_reference ?? "Not recorded"} · {s.department === "hotel" ? s.reviewed_at ? "Independently reviewed" : "Awaiting review" : "Reviewed through this daily sign-off"}</p></div>)}</div></details>
  </div>;
}

function EventTable({ events }: { events: ReconciliationSource["events"] }) {
  return <div className="mt-3 overflow-x-auto">{events.length ? <table className="w-full text-left text-xs"><thead><tr>{["Business line", "Type", "Reference", "Evidence", "Amount", "Status", "Occurred at"].map((label) => <th key={label} className="whitespace-nowrap p-2 font-medium">{label}</th>)}</tr></thead><tbody>{events.map((e) => <tr key={`${e.kind}:${e.id}`} className="border-t border-stone-100"><td className="p-2">{departmentNames[e.department]}</td><td className="p-2">{e.kind}</td><td className="p-2" title={e.id}>{e.reference}</td><td className="p-2">{e.evidence ?? "—"}</td><td className="whitespace-nowrap p-2">{formatNaira(e.amount_kobo)}</td><td className="p-2">{e.status}</td><td className="whitespace-nowrap p-2">{new Date(e.occurred_at).toLocaleString()}</td></tr>)}</tbody></table> : <p className="text-xs text-stone-500">No payment or refund records.</p>}</div>;
}
