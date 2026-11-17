import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Printer } from "lucide-react";

import { formatNaira } from "@/lib/money";
import { printElementInIsolatedFrame } from "@/lib/print-document";
import { supabase } from "@/lib/supabase/client";
import { useBusinessDayCloseStatus } from "./use-reception";
import type {
  CashierShiftHistory,
  DailyPaymentReconciliation,
  DailyRevenueTaxReport,
} from "./reception-service";
import { buildOutletSummary, type OutletCollections, type OutletSales } from "./business-date-summary-model";

export function BusinessDateSummary({
  hotelId,
  hotelName,
  selectedDate,
  revenue,
  payments,
  shifts,
}: {
  hotelId: string;
  hotelName: string;
  selectedDate: string;
  revenue: DailyRevenueTaxReport;
  payments: DailyPaymentReconciliation[];
  shifts: CashierShiftHistory[];
}) {
  const printRef = useRef<HTMLElement>(null);
  const [printError, setPrintError] = useState("");
  const currentDate = useBusinessDayCloseStatus(hotelId, !selectedDate);
  const businessDate = selectedDate || currentDate.data?.business_date || "";
  const outletReport = useQuery({
    queryKey: ["business-date-outlet-summary", hotelId, businessDate],
    queryFn: async () => {
      if (!supabase) throw new Error("Database connection is unavailable.");
      const [sales, collections] = await Promise.all([
        supabase.rpc("get_restaurant_pos_sales_report", {
          target_hotel_id: hotelId,
          from_date: businessDate,
          to_date: businessDate,
        }),
        supabase.rpc("get_pos_refund_sales_summary", {
          target_hotel_id: hotelId,
          from_date: businessDate,
          to_date: businessDate,
        }),
      ]);
      if (sales.error) throw sales.error;
      if (collections.error) throw collections.error;
      return {
        sales: (sales.data ?? []) as OutletSales[],
        collections: (collections.data ?? []) as OutletCollections[],
      };
    },
    enabled: Boolean(businessDate),
  });
  const hotelRevenue = revenue.departments.reduce(
    (total, row) => total + Number(row.total_amount_kobo), 0,
  );
  const hotelCollections = payments.reduce(
    (total, row) => total + Number(row.net_collected_kobo), 0,
  );
  const dayShifts = shifts.filter((shift) => shift.business_date === businessDate);
  const outlets = buildOutletSummary(
    outletReport.data?.sales ?? [],
    outletReport.data?.collections ?? [],
  );

  function printSummary() {
    if (!printRef.current || !businessDate || outletReport.isLoading || outletReport.isError) return;
    setPrintError("");
    const opened = printElementInIsolatedFrame({
      source: printRef.current,
      title: `Business-date summary ${businessDate}`,
      styles: `@page{margin:14mm}body{font:12px/1.4 Arial,sans-serif;color:#222}h1{font-size:20px;margin:0}h2{font-size:15px;margin:18px 0 6px}p{margin:5px 0}.note{color:#555}.summary{display:flex;gap:24px;margin:12px 0}.summary b{display:block;font-size:16px}table{border-collapse:collapse;width:100%;margin:7px 0 12px}th,td{border-bottom:1px solid #ddd;padding:5px;text-align:left}th:last-child,td:last-child{text-align:right}.page-break{break-before:page}`,
    });
    if (!opened) setPrintError("Print could not open in this browser.");
  }

  return (
    <section className="mt-6 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Business-date handover summary</h2>
          <p className="mt-1 text-sm text-stone-600">A printable overview inspired by the shift report. Hotel, restaurant, and bar remain separate businesses.</p>
        </div>
        <button type="button" onClick={printSummary} disabled={!businessDate || outletReport.isLoading || outletReport.isError} className="inline-flex items-center gap-2 rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold disabled:opacity-50"><Printer className="size-4" /> Print summary</button>
      </div>
      {printError && <p role="alert" className="mt-3 text-sm text-rose-700">{printError}</p>}
      {currentDate.isError && !selectedDate && <p role="alert" className="mt-3 text-sm text-rose-700">Unable to identify the current hotel business date.</p>}
      {outletReport.isError && <p role="alert" className="mt-3 text-sm text-rose-700">Outlet figures could not be loaded. Printing is disabled to avoid an incomplete report.</p>}
      {outletReport.isLoading && <p className="mt-3 text-sm text-stone-500">Loading outlet figures…</p>}
      <article ref={printRef} className="mt-4 text-sm">
        <h1 className="text-lg font-bold">{hotelName}</h1>
        <p className="text-stone-600">Business-date financial and handover summary · {businessDate || "Loading date"}</p>
        <p className="text-xs text-stone-500">Prepared {new Date().toLocaleString("en-NG")}. Operational report, not an invoice or tax return.</p>
        <div className="summary mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-stone-50 p-3"><span>Hotel folio posted charges</span><b className="block font-semibold">{formatNaira(hotelRevenue)}</b></div>
          <div className="rounded-lg bg-stone-50 p-3"><span>Hotel net collections</span><b className="block font-semibold">{formatNaira(hotelCollections)}</b></div>
        </div>
        <p className="note mt-2 text-xs text-stone-600">Charges follow service date; corrections follow posting date. Collections follow payment date. These totals are different measures and must not be added together. Hotel collections may include money held for an outlet under a one-payment exception.</p>
        <h2 className="mt-5 font-semibold">Hotel folio charges by department</h2>
        <table className="mt-2 w-full text-left"><thead><tr><th>Department</th><th className="text-right">Posted charges</th></tr></thead><tbody>{revenue.departments.map((row) => <tr key={row.department_code}><td>{row.department_code}</td><td className="text-right">{formatNaira(Number(row.total_amount_kobo))}</td></tr>)}</tbody></table>
        {!revenue.departments.length && <p className="text-stone-500">No hotel charges posted for this date.</p>}
        <h2 className="mt-5 font-semibold">Hotel collections by method</h2>
        <table className="mt-2 w-full text-left"><thead><tr><th>Method</th><th className="text-right">Net collected</th></tr></thead><tbody>{payments.map((row) => <tr key={row.payment_method_name}><td>{row.payment_method_name}</td><td className="text-right">{formatNaira(Number(row.net_collected_kobo))}</td></tr>)}</tbody></table>
        {!payments.length && <p className="text-stone-500">No hotel collections for this date.</p>}
        <h2 className="mt-5 font-semibold">Separate restaurant and bar businesses</h2>
        <p className="note text-xs text-stone-600">Sales follow order date; direct collections and refunds follow transaction date. Hotel-side collections on behalf of an outlet are not outlet tender and are not included in its direct collections.</p>
        <table className="mt-2 w-full text-left"><thead><tr><th>Outlet</th><th className="text-right">Amount</th></tr></thead><tbody>{outlets.map((row) => <tr key={row.id}><td>{row.name} ({row.department})<span className="block text-xs text-stone-500">Sales {formatNaira(row.sales)} · received {formatNaira(row.received)} · refunds {formatNaira(row.refunds)} · pending {formatNaira(row.pending)} · open balance {formatNaira(row.openBalance)}</span></td><td className="text-right">{formatNaira(row.netCollected)} direct net collection</td></tr>)}</tbody></table>
        {!outlets.length && !outletReport.isLoading && !outletReport.isError && <p className="text-stone-500">No outlet sales or collection movements for this date.</p>}
        <h2 className="mt-5 font-semibold">Hotel cashier handovers</h2>
        <p className="note text-xs text-stone-600">These are hotel cashier shifts only, from the latest 100 shift records. Amounts are till counts, not sales.</p>
        <table className="mt-2 w-full text-left"><thead><tr><th>Shift / cashier</th><th className="text-right">Expected / declared / variance</th></tr></thead><tbody>{dayShifts.map((shift) => <tr key={shift.id}><td>{shift.shift_number} · {shift.opened_by_name} · {shift.status}{shift.reviewed_by_name ? ` · reviewed by ${shift.reviewed_by_name}` : ""}</td><td className="text-right">{shift.expected_cash_kobo === null ? "—" : formatNaira(Number(shift.expected_cash_kobo))} / {shift.declared_cash_kobo === null ? "—" : formatNaira(Number(shift.declared_cash_kobo))} / {shift.variance_kobo === null ? "—" : formatNaira(Number(shift.variance_kobo))}</td></tr>)}</tbody></table>
        {!dayShifts.length && <p className="text-stone-500">No hotel cashier shift in the available history for this date.</p>}
        <p className="note mt-5 text-xs text-stone-500">This report does not claim to cover unsupported Vitasoft categories such as payroll, banquets, petty cash, or statutory accounting statements.</p>
      </article>
    </section>
  );
}
