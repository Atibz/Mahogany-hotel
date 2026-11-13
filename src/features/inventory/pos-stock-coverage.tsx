import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { supabase } from "@/lib/supabase/client";

type OutletCoverage = {
  outlet_id: string; outlet_name: string;
  menu_automatic_units: number; menu_unconfigured_units: number; menu_non_stock_units: number;
  option_automatic_units: number; option_unconfigured_units: number; option_non_stock_units: number;
};
type Usage = { outlet_id: string; outlet_name: string; item_id: string; item_name: string; unit: string; quantity: number };
type PhysicalCount = { item_name: string; unit: string; location_name: string; expected_quantity: number; observed_quantity: number; review_status: string; submitted_at: string };
type Report = { business_date: string; outlets: OutletCoverage[]; usage: Usage[]; physical_counts: PhysicalCount[] };
const number = (value: number) => new Intl.NumberFormat("en-NG", { maximumFractionDigits: 3 }).format(Number(value));

export function PosStockCoverage({ hotelId }: { hotelId: string }) {
  const [selectedDate, setSelectedDate] = useState("");
  const businessDate = useQuery({
    queryKey: ["pos-stock-business-date", hotelId],
    queryFn: async () => {
      if (!supabase) throw new Error("Database connection is not configured.");
      const { data, error } = await supabase.rpc("get_restaurant_pos_business_date", { target_hotel_id: hotelId });
      if (error) throw error;
      return String(data);
    },
  });
  const date = selectedDate || businessDate.data || "";
  const report = useQuery({
    queryKey: ["pos-stock-coverage", hotelId, date], enabled: Boolean(date),
    queryFn: async () => {
      if (!supabase) throw new Error("Database connection is not configured.");
      const { data, error } = await supabase.rpc("get_pos_stock_coverage_report", {
        target_hotel_id: hotelId, target_date: date,
      });
      if (error) throw error;
      return data as Report;
    },
  });
  const result = report.data;
  const unconfigured = result?.outlets.reduce((sum, outlet) => sum + Number(outlet.menu_unconfigured_units) + Number(outlet.option_unconfigured_units), 0) ?? 0;

  return <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5" aria-label="POS sales-to-stock coverage">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-semibold">POS sales-to-stock coverage</h2><p className="mt-1 max-w-3xl text-sm text-stone-600">See which sold items and add-ons had verified recipes, the stock deducted for them, and separately recorded physical counts. This is a quantity control, not a costing or profit report.</p></div><label className="text-sm font-medium text-stone-700">Business date<input type="date" value={date} max={businessDate.data || undefined} onChange={(event) => setSelectedDate(event.target.value)} className="mt-1 block rounded-lg border border-stone-300 px-3 py-2" /></label></div>
    {(businessDate.isLoading || report.isLoading) && <p className="mt-4 text-sm text-stone-500">Loading stock coverage…</p>}
    {(businessDate.error || report.error) && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800">Unable to load POS stock coverage. Confirm your access and the latest database migration.</p>}
    {result && <>
      <p role="status" className={`mt-4 rounded-xl p-3 text-sm ${unconfigured > 0 ? "bg-amber-50 text-amber-950" : "bg-emerald-50 text-emerald-900"}`}>{unconfigured > 0 ? `${number(unconfigured)} sold menu/add-on units were unconfigured and did not deduct stock. The figures below are incomplete.` : "No unconfigured sold units on this business date. Physical counts are still needed to verify the ledger."}</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">{result.outlets.map((outlet) => <article key={outlet.outlet_id} className="rounded-xl border border-stone-200 p-3"><h3 className="font-semibold">{outlet.outlet_name}</h3><dl className="mt-2 grid grid-cols-2 gap-2 text-sm"><div><dt className="text-stone-500">Menu units deducted</dt><dd className="font-semibold">{number(outlet.menu_automatic_units)}</dd></div><div><dt className="text-amber-800">Menu units unconfigured</dt><dd className="font-semibold">{number(outlet.menu_unconfigured_units)}</dd></div><div><dt className="text-stone-500">Add-on units deducted</dt><dd className="font-semibold">{number(outlet.option_automatic_units)}</dd></div><div><dt className="text-amber-800">Add-on units unconfigured</dt><dd className="font-semibold">{number(outlet.option_unconfigured_units)}</dd></div></dl><p className="mt-2 text-xs text-stone-500">Explicitly non-stock: {number(outlet.menu_non_stock_units)} menu units, {number(outlet.option_non_stock_units)} add-on units.</p></article>)}</div>
      {result.outlets.length === 0 && <p className="mt-4 text-sm text-stone-500">No outlet sales found for this date.</p>}
      <h3 className="mt-5 font-semibold">Stock deducted by POS orders</h3>
      <p className="mt-1 text-xs text-stone-500">Based on recorded sale movements for non-voided orders. Voided orders and their matching reversals are excluded.</p>
      {result.usage.length ? <ul className="mt-2 divide-y divide-stone-100">{result.usage.map((row) => <li key={`${row.outlet_id}-${row.item_id}`} className="flex justify-between gap-3 py-2 text-sm"><span>{row.outlet_name} · {row.item_name}</span><b>{number(row.quantity)} {row.unit}</b></li>)}</ul> : <p className="mt-2 text-sm text-stone-500">No recipe-linked POS stock deductions for this date.</p>}
      <h3 className="mt-5 font-semibold">Physical stock observations</h3>
      <p className="mt-1 text-xs text-stone-500">Latest submitted count per item and location on this date. The variance compares the observed count with the ledger snapshot at counting time—not directly with POS usage.</p>
      {result.physical_counts.length ? <ul className="mt-2 divide-y divide-stone-100">{result.physical_counts.map((count) => <li key={`${count.location_name}-${count.item_name}`} className="py-2 text-sm"><span className="font-medium">{count.location_name} · {count.item_name}</span><span className="block text-stone-600">Ledger {number(count.expected_quantity)} · counted {number(count.observed_quantity)} {count.unit} · variance {number(Number(count.observed_quantity) - Number(count.expected_quantity))} · {count.review_status}</span></li>)}</ul> : <p className="mt-2 text-sm text-amber-900">No physical counts on this date; stock usage cannot yet be independently verified.</p>}
    </>}
  </section>;
}
