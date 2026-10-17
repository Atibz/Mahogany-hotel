import { useQuery } from "@tanstack/react-query";
import { ChartNoAxesCombined, RefreshCw } from "lucide-react";
import { useState } from "react";

import { EmptyState, PageError, PageLoading } from "@/components/shared/page-state";
import { useActiveHotel } from "@/features/reception/use-reception";
import { formatNaira } from "@/lib/money";
import { supabase } from "@/lib/supabase/client";

type Department = "hotel" | "restaurant" | "bar";
type BalanceRow = {
  department: Department;
  collections_received_kobo: number;
  refunds_kobo: number;
  net_collections_kobo: number;
  recorded_expenses_kobo: number;
  approved_expenses_kobo: number;
  pending_review_expenses_kobo: number;
  rejected_expenses_kobo: number;
  expense_record_count: number;
};

const inputClass = "rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-amber-700 focus:ring-2 focus:ring-amber-100";
const departmentNames: Record<Department, string> = { hotel: "Hotel", restaurant: "Restaurant", bar: "Bar" };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
const startOfWeek = () => {
  const date = new Date(`${today()}T12:00:00`);
  date.setDate(date.getDate() - 6);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(date);
};

export function InternalBalancingPage() {
  const hotel = useActiveHotel();
  const [fromDate, setFromDate] = useState(startOfWeek);
  const [toDate, setToDate] = useState(today);
  const summary = useQuery({
    queryKey: ["internal-collection-expense-summary", hotel.data?.id, fromDate, toDate],
    enabled: Boolean(supabase && hotel.data?.id && fromDate && toDate && fromDate <= toDate),
    queryFn: async () => {
      if (!supabase || !hotel.data) throw new Error("Supabase is not configured.");
      const { data, error } = await supabase.rpc("get_internal_collection_expense_summary", {
        target_hotel_id: hotel.data.id,
        from_date: fromDate,
        to_date: toDate,
      });
      if (error) throw error;
      return (data ?? []) as BalanceRow[];
    },
  });

  if (hotel.isLoading || summary.isLoading) return <PageLoading />;
  if (hotel.error || summary.error) return <PageError message={summary.error instanceof Error ? summary.error.message : "Unable to load the internal balancing report."} />;
  if (!hotel.data) return <EmptyState>No hotel is assigned to your account.</EmptyState>;

  const rows = (summary.data ?? []).slice().sort((a, b) => ["hotel", "restaurant", "bar"].indexOf(a.department) - ["hotel", "restaurant", "bar"].indexOf(b.department));
  return <section className="max-w-6xl space-y-5">
    <header className="rounded-3xl bg-gradient-to-br from-amber-950 via-amber-900 to-orange-800 p-6 text-white shadow-sm sm:p-8">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-200">Finance · internal view</p>
      <div className="mt-2 flex items-start gap-3"><div className="rounded-2xl bg-white/10 p-3"><ChartNoAxesCombined className="size-6" aria-hidden="true" /></div><div><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Collections &amp; expenses</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-amber-50/85">Compare money received with recorded expenses by business line. This is an internal balancing aid, not a profit, tax, or statutory accounting report.</p></div></div>
    </header>

    <aside className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950"><p className="font-semibold">Separate ledgers; no automatic netting</p><p className="mt-1">Hotel collections come from completed hotel payments (including company-account settlements); Restaurant and Bar collections come from their own POS payment records. Refunds are shown separately and reduce net collections. Expenses are grouped by incurred date and shown by review status; because the register records already-paid expenses, recorded expense totals include approved, pending, and rejected entries. No money is moved, and no expense is automatically deducted from collections. A difference here is not profit.</p></aside>

    <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-semibold">Business-line comparison</h2><p className="text-sm text-stone-500">Up to 93 days · collections by payment/refund business date · expenses by incurred date</p></div><div className="flex flex-wrap items-end gap-2"><label className="text-xs text-stone-600">From<input aria-label="Balancing report from date" type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} className={`${inputClass} mt-1 block`} /></label><label className="text-xs text-stone-600">To<input aria-label="Balancing report to date" type="date" value={toDate} min={fromDate || undefined} max={today()} onChange={(event) => setToDate(event.target.value)} className={`${inputClass} mt-1 block`} /></label>{summary.isFetching && <RefreshCw className="mb-2 size-4 animate-spin text-stone-400" aria-label="Updating report" />}</div></div>
      {fromDate > toDate && <p className="mt-3 text-sm text-red-700">The start date must be on or before the end date.</p>}
      <div className="mt-4 grid gap-3 md:grid-cols-3">{rows.map((row) => <article key={row.department} className="rounded-xl border border-stone-200 bg-stone-50/70 p-4"><h3 className="text-lg font-semibold">{departmentNames[row.department]}</h3><dl className="mt-3 space-y-2 text-sm"><div className="flex justify-between gap-3"><dt className="text-stone-600">Collections received</dt><dd className="font-semibold">{formatNaira(row.collections_received_kobo)}</dd></div><div className="flex justify-between gap-3"><dt className="text-stone-600">Refunds paid</dt><dd className="font-semibold">{formatNaira(row.refunds_kobo)}</dd></div><div className="flex justify-between gap-3 border-t border-stone-200 pt-2"><dt className="font-medium">Net collections</dt><dd className="font-semibold">{formatNaira(row.net_collections_kobo)}</dd></div><div className="flex justify-between gap-3 border-t border-stone-200 pt-2"><dt className="text-stone-600">Recorded expenses</dt><dd className="font-semibold">{formatNaira(row.recorded_expenses_kobo)}</dd></div></dl><div className="mt-3 rounded-lg bg-white p-3 text-xs text-stone-600"><p>Expense review status · {row.expense_record_count} records</p><p className="mt-1">Approved {formatNaira(row.approved_expenses_kobo)} · Pending {formatNaira(row.pending_review_expenses_kobo)} · Rejected {formatNaira(row.rejected_expenses_kobo)}</p></div></article>)}</div>
    </section>
  </section>;
}
