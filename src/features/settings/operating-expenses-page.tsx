import { FormSubmitButton } from "@/components/shared/form-submit-button";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock3, Plus, ReceiptText, X } from "lucide-react";

import { Modal } from "@/components/shared/modal";
import { EmptyState, PageError, PageLoading } from "@/components/shared/page-state";
import { useAccess } from "@/features/auth/use-access";
import { useActiveHotel } from "@/features/reception/use-reception";
import { formatNaira, nairaToKobo } from "@/lib/money";
import { supabase } from "@/lib/supabase/client";
import { loadAllPages } from "@/lib/supabase/load-all-pages";

type Expense = {
  id: string;
  expense_number: string;
  business_date: string;
  incurred_on: string;
  department: "hotel" | "restaurant" | "bar";
  category: string;
  description: string;
  payee: string;
  amount_kobo: number;
  paid_via: string;
  evidence_reference: string | null;
  status: "pending_review" | "approved" | "rejected";
  submitted_at: string;
  review_note: string | null;
};

type Summary = {
  department: Expense["department"];
  approved_amount_kobo: number;
  pending_amount_kobo: number;
  approved_count: number;
  pending_count: number;
  rejected_count: number;
};

const fieldClass = "w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-amber-700 focus:ring-2 focus:ring-amber-100";
const departmentNames: Record<Expense["department"], string> = { hotel: "Hotel", restaurant: "Restaurant", bar: "Bar" };
const statusNames: Record<Expense["status"], string> = { pending_review: "Awaiting review", approved: "Approved", rejected: "Rejected" };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
const weekAgo = () => { const date = new Date(`${today()}T12:00:00`); date.setDate(date.getDate() - 6); return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(date); };

export function OperatingExpensesPage() {
  const hotel = useActiveHotel();
  const access = useAccess();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<Expense | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fromDate, setFromDate] = useState(weekAgo);
  const [toDate, setToDate] = useState(today);
  const canSubmit = access.roleCodes.some((role) => ["owner", "general_manager", "accountant"].includes(role));
  const canReview = access.roleCodes.some((role) => ["owner", "general_manager"].includes(role));

  const expenses = useQuery({
    queryKey: ["operating-expenses", hotel.data?.id],
    enabled: Boolean(supabase && hotel.data?.id),
    queryFn: async () => {
      if (!supabase || !hotel.data) throw new Error("Supabase is not configured.");
      const { data, error } = await supabase.from("operating_expenses").select("id, expense_number, business_date, incurred_on, department, category, description, payee, amount_kobo, paid_via, evidence_reference, status, submitted_at, review_note").eq("hotel_id", hotel.data.id).order("submitted_at", { ascending: false }).limit(100);
      if (error) throw error;
      return (data ?? []) as Expense[];
    },
  });

  const pendingExpenses = useQuery({
    queryKey: ["pending-operating-expenses", hotel.data?.id],
    enabled: Boolean(supabase && hotel.data?.id && canReview),
    queryFn: async () => loadAllPages<Expense>(async (from, to) => {
      if (!supabase || !hotel.data) throw new Error("Supabase is not configured.");
      const { data, error } = await supabase.from("operating_expenses")
        .select("id, expense_number, business_date, incurred_on, department, category, description, payee, amount_kobo, paid_via, evidence_reference, status, submitted_at, review_note")
        .eq("hotel_id", hotel.data.id)
        .eq("status", "pending_review")
        .order("submitted_at", { ascending: false })
        .order("id")
        .range(from, to);
      return { data: (data ?? []) as Expense[], error };
    }),
  });

  const summary = useQuery({
    queryKey: ["operating-expense-summary", hotel.data?.id, fromDate, toDate],
    enabled: Boolean(supabase && hotel.data?.id && fromDate && toDate && fromDate <= toDate),
    queryFn: async () => {
      if (!supabase || !hotel.data) throw new Error("Supabase is not configured.");
      const { data, error } = await supabase.rpc("get_operating_expense_summary", { target_hotel_id: hotel.data.id, from_date: fromDate, to_date: toDate });
      if (error) throw error;
      return (data ?? []) as Summary[];
    },
  });

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["operating-expenses", hotel.data?.id] }),
      queryClient.invalidateQueries({ queryKey: ["pending-operating-expenses", hotel.data?.id] }),
      queryClient.invalidateQueries({ queryKey: ["operating-expense-summary", hotel.data?.id] }),
      queryClient.invalidateQueries({ queryKey: ["internal-collection-expense-summary", hotel.data?.id] }),
      queryClient.invalidateQueries({ queryKey: ["internal-daily-reconciliation", hotel.data?.id] }),
      queryClient.invalidateQueries({ queryKey: ["activity-register"] }),
    ]);
  }

  async function submitExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !hotel.data) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true); setNotice(null);
    try {
      const { error } = await supabase.rpc("submit_operating_expense", {
        target_hotel_id: hotel.data.id,
        department_value: String(form.get("department")),
        category_value: String(form.get("category")),
        description_value: String(form.get("description")),
        payee_value: String(form.get("payee")),
        amount_value_kobo: nairaToKobo(String(form.get("amount"))),
        paid_via_value: String(form.get("paidVia")),
        evidence_reference_value: String(form.get("evidence") ?? "") || null,
        incurred_on_value: String(form.get("incurredOn")),
      });
      if (error) throw error;
      formElement.reset(); setShowForm(false);
      setNotice({ text: "Expense recorded and sent for independent review. No payment was initiated." });
      await refresh();
    } catch (caught) {
      setNotice({ text: caught instanceof Error ? caught.message : "Unable to record this expense.", error: true });
    } finally { setBusy(false); }
  }

  async function reviewExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !reviewTarget) return;
    const decision = String((event.nativeEvent as SubmitEvent).submitter && ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement).value) as "approved" | "rejected";
    if (decision !== "approved" && decision !== "rejected") return;
    const note = String(new FormData(event.currentTarget).get("reviewNote") ?? "").trim();
    setBusy(true); setNotice(null);
    const { error } = await supabase.rpc("review_operating_expense", { target_expense_id: reviewTarget.id, decision_value: decision, note_value: note });
    setBusy(false);
    if (error) { setNotice({ text: error.message, error: true }); return; }
    setReviewTarget(null);
    setNotice({ text: `Expense ${decision}. The record remains in the audit history; this does not release funds.` });
    await refresh();
  }

  if (hotel.isLoading || access.isLoading || expenses.isLoading || summary.isLoading || (canReview && pendingExpenses.isLoading)) return <PageLoading />;
  if (hotel.error || access.error || expenses.error || summary.error || (canReview && pendingExpenses.error)) return <PageError message={expenses.error instanceof Error ? expenses.error.message : pendingExpenses.error instanceof Error ? pendingExpenses.error.message : summary.error instanceof Error ? summary.error.message : "Unable to load operating expenses. Confirm expense permissions and that the latest migration is installed."} />;
  if (!hotel.data || !expenses.data || !summary.data) return <EmptyState>No hotel is assigned to your account.</EmptyState>;

  const pending = pendingExpenses.data ?? [];
  const departments = (["hotel", "restaurant", "bar"] as const).map((department) => ({ department, values: summary.data?.find((row) => row.department === department) }));

  return <section className="max-w-6xl space-y-5">
    <header className="rounded-3xl bg-gradient-to-br from-amber-950 via-amber-900 to-orange-800 p-6 text-white shadow-sm sm:p-8">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-200">Finance · internal control</p>
      <div className="mt-2 flex items-start gap-3"><div className="rounded-2xl bg-white/10 p-3"><ReceiptText className="size-6" aria-hidden="true" /></div><div><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Operating expenses</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-amber-50/85">Record expenses already paid, review them independently, and see totals by department. Money received (collections) is distinct from outstanding receivables.</p></div></div>
    </header>

    <aside className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950"><p className="font-semibold">Internal expense register only</p><p className="mt-1">Submitting records a payment that has already happened. Approval is a review decision—not a payment instruction, accounting journal, tax calculation, or automatic deduction from receivables or POS collections. Hotel, Restaurant, and Bar stay in separate totals.</p></aside>

    {notice && <p role="status" className={`rounded-xl border p-3 text-sm ${notice.error ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>{notice.text}</p>}

    <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-semibold">Department summary</h2><p className="text-sm text-stone-500">Approved and awaiting-review amounts by the date incurred—not profit or net collections.</p></div><div className="flex flex-wrap items-end gap-2"><label className="text-xs text-stone-600">From<input aria-label="Summary from date" type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} className={`${fieldClass} mt-1`} /></label><label className="text-xs text-stone-600">To<input aria-label="Summary to date" type="date" value={toDate} min={fromDate || undefined} max={today()} onChange={(event) => setToDate(event.target.value)} className={`${fieldClass} mt-1`} /></label></div></div>
      {fromDate > toDate && <p className="mt-3 text-sm text-red-700">The start date must be on or before the end date.</p>}
      <div className="mt-4 grid gap-3 md:grid-cols-3">{departments.map(({ department, values }) => <article key={department} className="rounded-xl border border-stone-200 bg-stone-50/70 p-4"><h3 className="font-semibold">{departmentNames[department]}</h3><dl className="mt-3 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-stone-500">Approved</dt><dd className="font-semibold">{formatNaira(values?.approved_amount_kobo)}</dd><dd className="text-xs text-stone-500">{values?.approved_count ?? 0} records</dd></div><div><dt className="text-xs text-stone-500">Awaiting review</dt><dd className="font-semibold">{formatNaira(values?.pending_amount_kobo)}</dd><dd className="text-xs text-stone-500">{values?.pending_count ?? 0} records</dd></div></dl><p className="mt-3 border-t border-stone-200 pt-2 text-xs text-stone-500">Rejected records: {values?.rejected_count ?? 0}</p></article>)}</div>
    </section>

    {canSubmit && <section className="rounded-2xl border border-stone-200 bg-white shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5"><div><h2 className="text-lg font-semibold">Record an expense</h2><p className="text-sm text-stone-500">For an expense that has already been paid; attach a reference where available.</p></div><button type="button" onClick={() => setShowForm((shown) => !shown)} className="inline-flex items-center gap-2 rounded-xl bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-950">{showForm ? <X className="size-4" /> : <Plus className="size-4" />}{showForm ? "Close form" : "Add expense"}</button></div>
      {showForm && <form onSubmit={(event) => void submitExpense(event)} className="grid gap-3 border-t border-stone-100 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-3">
        <label className="text-sm text-stone-700">Department<select name="department" required className={`${fieldClass} mt-1`}><option value="hotel">Hotel</option><option value="restaurant">Restaurant</option><option value="bar">Bar</option></select></label>
        <label className="text-sm text-stone-700">Category<input name="category" required minLength={2} maxLength={80} placeholder="e.g. Repairs, supplies" className={`${fieldClass} mt-1`} /></label>
        <label className="text-sm text-stone-700">Amount already paid (₦)<input name="amount" type="number" required min="0.01" step="0.01" inputMode="decimal" className={`${fieldClass} mt-1`} /></label>
        <label className="text-sm text-stone-700">Payee / supplier<input name="payee" required minLength={2} maxLength={160} className={`${fieldClass} mt-1`} /></label>
        <label className="text-sm text-stone-700">Paid via<input name="paidVia" required minLength={2} maxLength={80} placeholder="e.g. Cash, bank transfer" className={`${fieldClass} mt-1`} /></label>
        <label className="text-sm text-stone-700">Date incurred<input name="incurredOn" type="date" required max={today()} defaultValue={today()} className={`${fieldClass} mt-1`} /></label>
        <label className="text-sm text-stone-700 sm:col-span-2 lg:col-span-3">Description<textarea name="description" required minLength={3} maxLength={500} rows={2} placeholder="What was purchased or paid for?" className={`${fieldClass} mt-1`} /></label>
        <label className="text-sm text-stone-700 sm:col-span-2 lg:col-span-3">Receipt, invoice, or evidence reference <span className="text-stone-400">(optional)</span><input name="evidence" maxLength={160} placeholder="Receipt number or where the supporting document is filed" className={`${fieldClass} mt-1`} /></label>
        <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2 lg:col-span-3"><p className="text-xs leading-5 text-stone-500">Supporting documents are not uploaded here. Keep the original receipt/invoice and use its reference above.</p><FormSubmitButton type="submit" disabled={busy} className="rounded-xl bg-amber-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : "Submit for review"}</FormSubmitButton></div>
      </form>}</section>}

    {canReview && <section className="rounded-2xl border border-orange-200 bg-orange-50/60 p-4 sm:p-5"><div className="flex items-center gap-2"><Clock3 className="size-5 text-orange-800" /><div><h2 className="text-lg font-semibold">Needs your review</h2><p className="text-sm text-stone-600">You cannot approve an expense you submitted.</p></div><span className="ml-auto rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-900">{pending.length} pending</span></div>{pending.length ? <div className="mt-3 space-y-2">{pending.map((expense) => <ExpenseRow key={expense.id} expense={expense} onReview={() => setReviewTarget(expense)} canReview />)}</div> : <p className="mt-3 rounded-xl bg-white/70 p-4 text-sm text-stone-600">No expenses are waiting for review.</p>}</section>}

    <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5"><h2 className="text-lg font-semibold">Recent expense records</h2><p className="text-sm text-stone-500">Latest 100 entries · reviewed records are retained in history.</p><div className="mt-3 space-y-2">{expenses.data.map((expense) => <ExpenseRow key={expense.id} expense={expense} />)}{expenses.data.length === 0 && <EmptyState>No expense records yet.</EmptyState>}</div></section>

    <Modal open={Boolean(reviewTarget)} title="Review expense" onClose={() => { if (!busy) setReviewTarget(null); }}>
      {reviewTarget && <form className="space-y-4" onSubmit={(event) => void reviewExpense(event)}><div className="rounded-xl bg-stone-50 p-4 text-sm"><p className="font-semibold">{reviewTarget.expense_number} · {departmentNames[reviewTarget.department]}</p><p className="mt-1">{reviewTarget.description}</p><p className="mt-1 text-stone-600">{reviewTarget.payee} · {reviewTarget.category}</p><p className="mt-2 text-lg font-semibold">{formatNaira(reviewTarget.amount_kobo)}</p><p className="mt-1 text-xs text-stone-500">Paid via {reviewTarget.paid_via}{reviewTarget.evidence_reference ? ` · Evidence: ${reviewTarget.evidence_reference}` : " · No evidence reference"}</p></div><label className="block text-sm font-medium">Review note (required)<textarea name="reviewNote" required minLength={3} maxLength={500} rows={3} className={`${fieldClass} mt-1`} placeholder="Explain your decision or note any follow-up needed." /></label><div className="flex flex-wrap justify-end gap-2"><FormSubmitButton type="submit" value="rejected" disabled={busy} className="rounded-xl border border-red-300 px-4 py-2.5 text-sm font-semibold text-red-800 disabled:opacity-50">Reject</FormSubmitButton><FormSubmitButton type="submit" value="approved" disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"><Check className="size-4" />{busy ? "Saving…" : "Approve"}</FormSubmitButton></div></form>}
    </Modal>
  </section>;
}

function ExpenseRow({ expense, onReview, canReview = false }: { expense: Expense; onReview?: () => void; canReview?: boolean }) {
  const color = expense.status === "approved" ? "bg-emerald-50 text-emerald-800" : expense.status === "rejected" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900";
  return <article className="flex flex-col gap-3 rounded-xl border border-stone-200 p-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{expense.expense_number}</h3><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${color}`}>{statusNames[expense.status]}</span><span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-700">{departmentNames[expense.department]}</span></div><p className="mt-1 text-sm">{expense.description}</p><p className="mt-1 text-xs text-stone-500">{expense.category} · {expense.payee} · Paid via {expense.paid_via} · Incurred {expense.incurred_on}</p>{expense.evidence_reference && <p className="mt-1 text-xs text-stone-500">Evidence: {expense.evidence_reference}</p>}{expense.review_note && <p className="mt-2 rounded-lg bg-stone-50 p-2 text-xs text-stone-600">Review note: {expense.review_note}</p>}</div><div className="flex shrink-0 items-center justify-between gap-3 sm:flex-col sm:items-end"><b>{formatNaira(expense.amount_kobo)}</b>{canReview && onReview && expense.status === "pending_review" && <button type="button" onClick={onReview} className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold hover:bg-stone-50">Review</button>}</div></article>;
}
