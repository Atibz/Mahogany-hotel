import { useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Box, PackagePlus, Plus, Truck, TriangleAlert } from "lucide-react";

import { Modal } from "@/components/shared/modal";
import { EmptyState, PageError, PageLoading } from "@/components/shared/page-state";
import { useAccess } from "@/features/auth/use-access";
import { useActiveHotel } from "@/features/reception/use-reception";
import { supabase } from "@/lib/supabase/client";

type Location = { id: string; code: string; name: string; active: boolean };
type Item = { id: string; item_code: string; name: string; category: string; base_unit: string; reorder_level: number; active: boolean };
type Supplier = { id: string; name: string; contact_name: string | null; phone: string | null; email: string | null; notes: string | null; active: boolean };
type Balance = { item_id: string; item_code: string; item_name: string; category: string; base_unit: string; reorder_level: number; location_code: string; location_name: string; on_hand: number; active: boolean };
type Movement = { id: string; movement_group_id: string; item_id: string; location_id: string; movement_type: string; quantity_delta: number; supplier_id: string | null; reference: string | null; reason: string; created_at: string };
type Tab = "stock" | "movements" | "suppliers";

const field = "mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-amber-700 focus:ring-2 focus:ring-amber-100";
const tabs: { id: Tab; label: string }[] = [{ id: "stock", label: "Stock overview" }, { id: "movements", label: "Movement history" }, { id: "suppliers", label: "Suppliers" }];
const movementLabels: Record<string, string> = { receipt: "Received", issue: "Issued", transfer_in: "Transfer in", transfer_out: "Transfer out", waste: "Waste" };
const quantity = (value: number, unit: string) => `${new Intl.NumberFormat("en-NG", { maximumFractionDigits: 3 }).format(value)} ${unit}`;

export function InventoryPage() {
  const hotel = useActiveHotel();
  const access = useAccess();
  const cache = useQueryClient();
  const [tab, setTab] = useState<Tab>("stock");
  const [search, setSearch] = useState("");
  const [itemTarget, setItemTarget] = useState<Item | null>(null);
  const [supplierTarget, setSupplierTarget] = useState<Supplier | null>(null);
  const [showMovement, setShowMovement] = useState(false);
  const [movementType, setMovementType] = useState("receipt");
  const [sourceLocation, setSourceLocation] = useState("main_store");
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const hotelId = hotel.data?.id;
  const canManage = access.roleCodes.some((role) => ["owner", "general_manager", "storekeeper"].includes(role));

  const items = useQuery({
    queryKey: ["inventory-items", hotelId], enabled: Boolean(supabase && hotelId),
    queryFn: async () => {
      if (!supabase || !hotelId) throw new Error("Supabase is not configured.");
      const { data, error } = await supabase.from("inventory_items").select("id,item_code,name,category,base_unit,reorder_level,active").eq("hotel_id", hotelId).order("category").order("name");
      if (error) throw error; return (data ?? []) as Item[];
    },
  });
  const suppliers = useQuery({
    queryKey: ["inventory-suppliers", hotelId], enabled: Boolean(supabase && hotelId),
    queryFn: async () => {
      if (!supabase || !hotelId) throw new Error("Supabase is not configured.");
      const { data, error } = await supabase.from("inventory_suppliers").select("id,name,contact_name,phone,email,notes,active").eq("hotel_id", hotelId).order("name");
      if (error) throw error; return (data ?? []) as Supplier[];
    },
  });
  const locations = useQuery({
    queryKey: ["inventory-locations", hotelId], enabled: Boolean(supabase && hotelId),
    queryFn: async () => {
      if (!supabase || !hotelId) throw new Error("Supabase is not configured.");
      const { data, error } = await supabase.from("inventory_locations").select("id,code,name,active").eq("hotel_id", hotelId).eq("active", true).order("name");
      if (error) throw error; return (data ?? []) as Location[];
    },
  });
  const balances = useQuery({
    queryKey: ["inventory-balances", hotelId], enabled: Boolean(supabase && hotelId),
    queryFn: async () => {
      if (!supabase || !hotelId) throw new Error("Supabase is not configured.");
      const { data, error } = await supabase.rpc("get_inventory_balances", { target_hotel_id: hotelId });
      if (error) throw error; return (data ?? []) as Balance[];
    },
  });
  const movements = useQuery({
    queryKey: ["inventory-movements", hotelId], enabled: Boolean(supabase && hotelId),
    queryFn: async () => {
      if (!supabase || !hotelId) throw new Error("Supabase is not configured.");
      const { data, error } = await supabase.from("inventory_movements").select("id,movement_group_id,item_id,location_id,movement_type,quantity_delta,supplier_id,reference,reason,created_at").eq("hotel_id", hotelId).order("created_at", { ascending: false }).limit(250);
      if (error) throw error; return (data ?? []) as Movement[];
    },
  });

  const filteredBalances = useMemo(() => (balances.data ?? []).filter((row) => `${row.item_code} ${row.item_name} ${row.category} ${row.location_name}`.toLowerCase().includes(search.toLowerCase())), [balances.data, search]);
  const lowStockItems = useMemo(() => (items.data ?? []).filter((item) => item.active && (balances.data ?? []).filter((row) => row.item_id === item.id && row.location_code === "main_store").reduce((sum, row) => sum + Number(row.on_hand), 0) <= item.reorder_level), [items.data, balances.data]);
  const itemById = useMemo(() => new Map((items.data ?? []).map((item) => [item.id, item])), [items.data]);
  const locationById = useMemo(() => new Map((locations.data ?? []).map((location) => [location.id, location])), [locations.data]);
  const supplierById = useMemo(() => new Map((suppliers.data ?? []).map((supplier) => [supplier.id, supplier])), [suppliers.data]);
  const queryList = [items, suppliers, locations, balances, movements];

  async function refresh() {
    await Promise.all(["inventory-items", "inventory-suppliers", "inventory-locations", "inventory-balances", "inventory-movements", "activity-register"].map((key) => cache.invalidateQueries({ queryKey: [key, hotelId] })));
  }
  async function saveItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!supabase || !hotelId) return;
    const form = new FormData(event.currentTarget); setBusy(true); setNotice(null);
    const { error } = await supabase.rpc("save_inventory_item", { target_hotel_id: hotelId, target_item_id: itemTarget?.id || null, item_code_value: String(form.get("code")), name_value: String(form.get("name")), category_value: String(form.get("category")), base_unit_value: String(form.get("unit")), reorder_level_value: Number(form.get("reorderLevel")), active_value: form.get("active") === "on" });
    setBusy(false); if (error) { setNotice({ message: error.message, error: true }); return; }
    setItemTarget(null); setNotice({ message: "Item saved." }); await refresh();
  }
  async function saveSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!supabase || !hotelId) return;
    const form = new FormData(event.currentTarget); setBusy(true); setNotice(null);
    const { error } = await supabase.rpc("save_inventory_supplier", { target_hotel_id: hotelId, target_supplier_id: supplierTarget?.id || null, name_value: String(form.get("name")), contact_name_value: String(form.get("contact") ?? ""), phone_value: String(form.get("phone") ?? ""), email_value: String(form.get("email") ?? ""), notes_value: String(form.get("notes") ?? ""), active_value: form.get("active") === "on" });
    setBusy(false); if (error) { setNotice({ message: error.message, error: true }); return; }
    setSupplierTarget(null); setNotice({ message: "Supplier saved." }); await refresh();
  }
  async function recordMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!supabase || !hotelId) return;
    const form = new FormData(event.currentTarget); setBusy(true); setNotice(null);
    const { error } = await supabase.rpc("record_inventory_movement", { target_hotel_id: hotelId, target_item_id: String(form.get("item")), movement_type_value: String(form.get("type")), quantity_value: Number(form.get("quantity")), source_location_code: String(form.get("source")), destination_location_code: String(form.get("destination") ?? "") || null, supplier_value_id: String(form.get("supplier") ?? "") || null, reference_value: String(form.get("reference") ?? "") || null, reason_value: String(form.get("reason")) });
    setBusy(false); if (error) { setNotice({ message: error.message, error: true }); return; }
    setShowMovement(false); setNotice({ message: "Stock movement recorded in the permanent ledger." }); await refresh();
  }

  if (hotel.isLoading || access.isLoading || queryList.some((query) => query.isLoading)) return <PageLoading />;
  if (hotel.error || access.error || queryList.some((query) => query.error)) return <PageError message="Unable to load inventory. Confirm your inventory access and that the latest inventory migration has been applied." />;
  if (!hotel.data) return <EmptyState>No hotel is assigned to your account.</EmptyState>;

  const activeItems = (items.data ?? []).filter((item) => item.active);
  const activeSuppliers = (suppliers.data ?? []).filter((supplier) => supplier.active);
  return <section className="max-w-6xl space-y-5">
    <header className="rounded-3xl bg-gradient-to-br from-amber-950 via-amber-900 to-orange-800 p-6 text-white shadow-sm sm:p-8">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-200">Operations · stock control</p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4"><div className="flex items-start gap-3"><div className="rounded-2xl bg-white/10 p-3"><Box className="size-6" aria-hidden="true" /></div><div><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Inventory & suppliers</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-amber-50/85">Track quantities across the Main Store, Hotel, Restaurant, and Bar. Every stock change needs a reason and stays in the ledger.</p></div></div>{canManage && <button type="button" onClick={() => { setMovementType("receipt"); setSourceLocation("main_store"); setShowMovement(true); }} className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-amber-950 hover:bg-amber-50"><PackagePlus className="size-4" />Record stock movement</button>}</div>
    </header>

    <aside className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-950"><p className="font-semibold">Quantity register only</p><p className="mt-1">This first release does not calculate item costs, supplier balances, tax, profit, or payments; it does not automatically consume stock from Restaurant/Bar POS. Keep invoices and payment records in their existing workflows.</p></aside>
    {notice && <p role="status" className={`rounded-xl border p-3 text-sm ${notice.error ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>{notice.message}</p>}

    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-stone-200 bg-white p-3 shadow-sm"><div className="flex flex-wrap gap-1" role="tablist" aria-label="Inventory sections">{tabs.map((option) => <button key={option.id} type="button" role="tab" aria-selected={tab === option.id} onClick={() => setTab(option.id)} className={`rounded-xl px-4 py-2 text-sm font-semibold ${tab === option.id ? "bg-amber-900 text-white" : "text-stone-600 hover:bg-stone-100"}`}>{option.label}</button>)}</div>{canManage && tab === "stock" && <button type="button" onClick={() => setItemTarget({ id: "", item_code: "", name: "", category: "", base_unit: "", reorder_level: 0, active: true })} className="inline-flex items-center gap-2 rounded-xl border border-stone-300 px-3 py-2 text-sm font-semibold hover:bg-stone-50"><Plus className="size-4" />Add item</button>}{canManage && tab === "suppliers" && <button type="button" onClick={() => setSupplierTarget({ id: "", name: "", contact_name: null, phone: null, email: null, notes: null, active: true })} className="inline-flex items-center gap-2 rounded-xl border border-stone-300 px-3 py-2 text-sm font-semibold hover:bg-stone-50"><Plus className="size-4" />Add supplier</button>}</div>

    {tab === "stock" && <>
      <div className="grid gap-3 sm:grid-cols-2"><article className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"><p className="text-sm text-stone-500">Active items</p><p className="mt-1 text-2xl font-semibold">{activeItems.length}</p></article><article className={`rounded-2xl border p-4 shadow-sm ${lowStockItems.length ? "border-amber-200 bg-amber-50" : "border-stone-200 bg-white"}`}><p className="flex items-center gap-2 text-sm text-stone-600"><TriangleAlert className="size-4" />Main Store at or below reorder level</p><p className="mt-1 text-2xl font-semibold">{lowStockItems.length}</p><p className="mt-1 text-xs text-stone-500">A reorder level of 0 alerts when the item is out of stock.</p></article></div>
      {lowStockItems.length > 0 && <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4"><h2 className="font-semibold text-amber-950">Reorder attention</h2><div className="mt-2 flex flex-wrap gap-2">{lowStockItems.map((item) => <span key={item.id} className="rounded-full bg-white px-3 py-1.5 text-sm text-amber-950">{item.name} · reorder at {quantity(item.reorder_level, item.base_unit)}</span>)}</div></div>}
      <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-semibold">On hand by location</h2><p className="text-sm text-stone-500">Quantities are based on posted movement records.</p></div><label className="text-sm text-stone-600">Search<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Item, code, category, location" className={`${field} min-w-64`} /></label></div>
        {filteredBalances.length ? <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-500"><tr><th className="py-3 pr-3">Item</th><th className="py-3 pr-3">Category</th><th className="py-3 pr-3">Location</th><th className="py-3 pr-3 text-right">On hand</th><th className="py-3 text-right">Reorder level</th></tr></thead><tbody className="divide-y divide-stone-100">{filteredBalances.map((row) => <tr key={`${row.item_id}-${row.location_code}`} className="hover:bg-stone-50"><td className="py-3 pr-3"><p className="font-semibold">{row.item_name}</p><p className="text-xs text-stone-500">{row.item_code}{!row.active && " · inactive"}</p></td><td className="py-3 pr-3 text-stone-600">{row.category}</td><td className="py-3 pr-3 text-stone-600">{row.location_name}</td><td className={`py-3 pr-3 text-right font-semibold ${Number(row.on_hand) <= Number(row.reorder_level) ? "text-amber-800" : "text-stone-900"}`}>{quantity(Number(row.on_hand), row.base_unit)}</td><td className="py-3 text-right text-stone-600">{quantity(Number(row.reorder_level), row.base_unit)}</td></tr>)}</tbody></table></div> : <EmptyState>{activeItems.length ? "No items match your search." : "No stock items yet. Add an item, then record its opening receipt."}</EmptyState>}
      </section>
      {canManage && <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"><h2 className="text-lg font-semibold">Item register</h2><div className="mt-3 divide-y divide-stone-100">{(items.data ?? []).map((item) => <article key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="font-semibold">{item.name} <span className="font-normal text-stone-500">· {item.item_code}</span></p><p className="text-xs text-stone-500">{item.category} · {item.base_unit} · reorder at {quantity(item.reorder_level, item.base_unit)}{!item.active && " · inactive"}</p></div><button type="button" onClick={() => setItemTarget(item)} className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold hover:bg-stone-50">Edit</button></article>)}{items.data?.length === 0 && <p className="py-4 text-sm text-stone-500">The item register is empty.</p>}</div></section>}
    </>}

    {tab === "movements" && <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex items-center gap-2"><ArrowLeftRight className="size-5 text-amber-900" /><div><h2 className="text-lg font-semibold">Permanent movement history</h2><p className="text-sm text-stone-500">Latest 250 movements. Transfers appear as a paired out/in record.</p></div></div>{movements.data?.length ? <div className="mt-4 space-y-2">{movements.data.map((entry) => { const item = itemById.get(entry.item_id); const location = locationById.get(entry.location_id); const supplier = entry.supplier_id ? supplierById.get(entry.supplier_id) : null; return <article key={entry.id} className="flex flex-col gap-2 rounded-xl border border-stone-200 p-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{item?.name ?? "Unknown item"}</h3><span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-semibold">{movementLabels[entry.movement_type] ?? entry.movement_type}</span><span className="text-xs text-stone-500">{location?.name ?? "Location"}</span></div><p className="mt-1 text-sm text-stone-700">{entry.reason}</p><p className="mt-1 text-xs text-stone-500">{new Date(entry.created_at).toLocaleString("en-NG")}{supplier ? ` · Supplier: ${supplier.name}` : ""}{entry.reference ? ` · Ref: ${entry.reference}` : ""}</p></div><b className={Number(entry.quantity_delta) > 0 ? "text-emerald-800" : "text-stone-900"}>{Number(entry.quantity_delta) > 0 ? "+" : ""}{quantity(Number(entry.quantity_delta), item?.base_unit ?? "units")}</b></article>; })}</div> : <EmptyState>No stock movements recorded yet.</EmptyState>}</section>}

    {tab === "suppliers" && <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex items-center gap-2"><Truck className="size-5 text-amber-900" /><div><h2 className="text-lg font-semibold">Supplier register</h2><p className="text-sm text-stone-500">Contact directory only; supplier balances and payments are not recorded here.</p></div></div>{suppliers.data?.length ? <div className="mt-4 grid gap-3 md:grid-cols-2">{suppliers.data.map((supplier) => <article key={supplier.id} className="rounded-xl border border-stone-200 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{supplier.name}</h3>{supplier.contact_name && <p className="mt-1 text-sm text-stone-600">{supplier.contact_name}</p>}{(supplier.phone || supplier.email) && <p className="mt-1 break-words text-sm text-stone-600">{[supplier.phone, supplier.email].filter(Boolean).join(" · ")}</p>}{supplier.notes && <p className="mt-2 text-sm text-stone-500">{supplier.notes}</p>}{!supplier.active && <span className="mt-2 inline-flex rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-600">Inactive</span>}</div>{canManage && <button type="button" onClick={() => setSupplierTarget(supplier)} className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold hover:bg-stone-50">Edit</button>}</div></article>)}</div> : <EmptyState>No suppliers registered yet.</EmptyState>}</section>}

    <Modal open={Boolean(itemTarget)} title={itemTarget?.id ? "Edit stock item" : "Add stock item"} onClose={() => { if (!busy) setItemTarget(null); }}>
      {itemTarget && <form onSubmit={(event) => void saveItem(event)} className="space-y-3"><label className="block text-sm">Item code<input name="code" required minLength={2} maxLength={40} defaultValue={itemTarget.item_code} className={field} /></label><label className="block text-sm">Item name<input name="name" required minLength={2} maxLength={160} defaultValue={itemTarget.name} className={field} /></label><div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm">Category<input name="category" required minLength={2} maxLength={80} defaultValue={itemTarget.category} placeholder="e.g. Housekeeping" className={field} /></label><label className="block text-sm">Base unit<input name="unit" required minLength={1} maxLength={24} defaultValue={itemTarget.base_unit} placeholder="e.g. pieces, bottles" className={field} /></label></div><label className="block text-sm">Reorder level<input name="reorderLevel" type="number" min="0" step="0.001" required defaultValue={itemTarget.reorder_level} className={field} /></label><label className="flex items-center gap-2 text-sm"><input name="active" type="checkbox" defaultChecked={itemTarget.active} />Active and available for movements</label>{itemTarget.id && <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-950">Once an item has movements, its base unit cannot be changed. Record a correcting movement instead of editing stock directly.</p>}<div className="flex justify-end gap-2"><button type="button" onClick={() => setItemTarget(null)} disabled={busy} className="rounded-xl border border-stone-300 px-4 py-2 text-sm">Cancel</button><button disabled={busy} className="rounded-xl bg-amber-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : "Save item"}</button></div></form>}
    </Modal>
    <Modal open={Boolean(supplierTarget)} title={supplierTarget?.id ? "Edit supplier" : "Add supplier"} onClose={() => { if (!busy) setSupplierTarget(null); }}>
      {supplierTarget && <form onSubmit={(event) => void saveSupplier(event)} className="space-y-3"><label className="block text-sm">Supplier name<input name="name" required minLength={2} maxLength={160} defaultValue={supplierTarget.name} className={field} /></label><label className="block text-sm">Contact person<input name="contact" maxLength={120} defaultValue={supplierTarget.contact_name ?? ""} className={field} /></label><div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm">Phone<input name="phone" maxLength={60} defaultValue={supplierTarget.phone ?? ""} className={field} /></label><label className="block text-sm">Email<input name="email" type="email" maxLength={254} defaultValue={supplierTarget.email ?? ""} className={field} /></label></div><label className="block text-sm">Notes<textarea name="notes" maxLength={500} rows={3} defaultValue={supplierTarget.notes ?? ""} className={field} /></label><label className="flex items-center gap-2 text-sm"><input name="active" type="checkbox" defaultChecked={supplierTarget.active} />Active supplier</label><div className="flex justify-end gap-2"><button type="button" onClick={() => setSupplierTarget(null)} disabled={busy} className="rounded-xl border border-stone-300 px-4 py-2 text-sm">Cancel</button><button disabled={busy} className="rounded-xl bg-amber-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : "Save supplier"}</button></div></form>}
    </Modal>
    <Modal open={showMovement} title="Record stock movement" onClose={() => { if (!busy) setShowMovement(false); }}>
      <form onSubmit={(event) => void recordMovement(event)} className="space-y-3">
        <label className="block text-sm">Movement type
          <select name="type" value={movementType} required className={field} onChange={(event) => {
            const nextType = event.target.value;
            setMovementType(nextType);
            if (nextType === "receipt") setSourceLocation("main_store");
            else if ((nextType === "issue" || nextType === "waste") && sourceLocation === "main_store") {
              setSourceLocation((locations.data ?? []).find((location) => location.code !== "main_store")?.code ?? "");
            }
          }}>
            <option value="receipt">Receive stock into Main Store</option><option value="transfer">Transfer between locations</option><option value="issue">Issue stock for use</option><option value="waste">Record damaged / wasted stock</option>
          </select>
        </label>
        <label className="block text-sm">Item<select name="item" required defaultValue="" className={field}><option value="" disabled>Select an active item</option>{activeItems.map((item) => <option key={item.id} value={item.id}>{item.item_code} · {item.name} ({item.base_unit})</option>)}</select></label>
        <label className="block text-sm">Quantity<input name="quantity" type="number" inputMode="decimal" min="0.001" max="99999999999.999" step="0.001" required className={field} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">{movementType === "receipt" ? "Receive into" : "Source location"}
            <select name="source" value={sourceLocation} required className={field} onChange={(event) => setSourceLocation(event.target.value)}>
              {(locations.data ?? []).filter((location) => movementType === "receipt" ? location.code === "main_store" : movementType === "issue" || movementType === "waste" ? location.code !== "main_store" : true).map((location) => <option key={location.id} value={location.code}>{location.name}</option>)}
            </select>
          </label>
          {movementType === "transfer" && <label className="block text-sm">Transfer destination<select key={sourceLocation} name="destination" required defaultValue="" className={field}><option value="" disabled>Select destination</option>{(locations.data ?? []).filter((location) => location.code !== sourceLocation).map((location) => <option key={location.id} value={location.code}>{location.name}</option>)}</select></label>}
        </div>
        {movementType === "receipt" && <label className="block text-sm">Supplier <span className="text-stone-400">(optional)</span><select name="supplier" defaultValue="" className={field}><option value="">No supplier selected</option>{activeSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>}
        <label className="block text-sm">Document / reference <span className="text-stone-400">(optional)</span><input name="reference" maxLength={100} className={field} /></label>
        <label className="block text-sm">Reason<input name="reason" required minLength={5} maxLength={500} placeholder="Explain why this stock movement is being recorded" className={field} /></label>
        <p className="rounded-lg bg-stone-50 p-3 text-xs leading-5 text-stone-600">Receipts add stock to Main Store. Transfers move stock between locations. Issues and waste reduce stock at an operating location. Stock cannot go below zero.</p>
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setShowMovement(false)} disabled={busy} className="rounded-xl border border-stone-300 px-4 py-2 text-sm">Cancel</button><button disabled={busy || activeItems.length === 0} className="rounded-xl bg-amber-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Recording…" : "Record movement"}</button></div>
      </form>
    </Modal>
  </section>;
}
