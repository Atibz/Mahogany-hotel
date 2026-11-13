import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { FormSubmitButton } from "@/components/shared/form-submit-button";
import { useActionMessage } from "@/components/shared/action-feedback";
import { supabase } from "@/lib/supabase/client";

type Mode = "unconfigured" | "automatic" | "non_stock";
type Target = { id: string; outlet_id: string; name: string; stock_tracking_mode: Mode };
type Outlet = { id: string; name: string; outlet_type: "restaurant" | "bar" };
type InventoryItem = { id: string; name: string; item_code: string; base_unit: string; active: boolean };
type Component = { id: string; menu_item_id: string | null; modifier_option_id: string | null; inventory_item_id: string; quantity_per_unit: number };
type Draft = { item_id: string; quantity: string };
const field = "mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

export function PosStockMapping({ hotelId, menuItems, modifierOptions, outlets }: {
  hotelId: string; menuItems: Target[]; modifierOptions: Target[]; outlets: Outlet[];
}) {
  const cache = useQueryClient();
  const [kind, setKind] = useState<"menu_item" | "modifier_option">("menu_item");
  const [targetId, setTargetId] = useState("");
  const [mode, setMode] = useState<"automatic" | "non_stock">("automatic");
  const [draft, setDraft] = useState<Draft[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useActionMessage<{ message: string; error: boolean } | null>(null);
  const inventory = useQuery({
    queryKey: ["pos-stock-inventory", hotelId],
    queryFn: async () => {
      if (!supabase) throw new Error("Database connection is not configured.");
      const { data, error } = await supabase.from("inventory_items")
        .select("id,name,item_code,base_unit,active").eq("hotel_id", hotelId).order("name");
      if (error) throw error;
      return (data ?? []) as InventoryItem[];
    },
  });
  const components = useQuery({
    queryKey: ["pos-stock-components", hotelId],
    queryFn: async () => {
      if (!supabase) throw new Error("Database connection is not configured.");
      const { data, error } = await supabase.from("pos_stock_components")
        .select("id,menu_item_id,modifier_option_id,inventory_item_id,quantity_per_unit")
        .eq("hotel_id", hotelId);
      if (error) throw error;
      return (data ?? []) as Component[];
    },
  });
  const targets = kind === "menu_item" ? menuItems : modifierOptions;
  const target = targets.find((entry) => entry.id === targetId);
  const outlet = outlets.find((entry) => entry.id === target?.outlet_id);
  const existing = (components.data ?? []).filter((entry) => kind === "menu_item"
    ? entry.menu_item_id === targetId : entry.modifier_option_id === targetId);

  function selectTarget(value: string, nextKind = kind) {
    setTargetId(value);
    const selected = (nextKind === "menu_item" ? menuItems : modifierOptions).find((entry) => entry.id === value);
    setMode(selected?.stock_tracking_mode === "non_stock" ? "non_stock" : "automatic");
    setDraft((components.data ?? []).filter((entry) => nextKind === "menu_item"
      ? entry.menu_item_id === value : entry.modifier_option_id === value)
      .map((entry) => ({ item_id: entry.inventory_item_id, quantity: String(entry.quantity_per_unit) })));
    setReason(""); setNotice(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !target || busy || reason.trim().length < 5) return;
    const rows = mode === "automatic" ? draft.map((entry) => ({ item_id: entry.item_id, quantity: Number(entry.quantity) })) : [];
    if (mode === "automatic" && (!rows.length || rows.some((entry) => !entry.item_id || !Number.isFinite(entry.quantity)
      || entry.quantity <= 0 || entry.quantity > 1_000_000 || Math.round(entry.quantity * 1000) !== entry.quantity * 1000)
      || new Set(rows.map((entry) => entry.item_id)).size !== rows.length)) {
      setNotice({ message: "Choose distinct active ingredients with valid quantities (up to three decimals).", error: true });
      return;
    }
    setBusy(true); setNotice(null);
    const { error } = await supabase.rpc("configure_pos_stock_components", {
      target_kind: kind, target_id: target.id, tracking_mode_value: mode,
      component_rows: rows, reason_value: reason.trim(),
    });
    setBusy(false);
    if (error) { setNotice({ message: error.message, error: true }); return; }
    setNotice({ message: "Stock mapping saved. New order lines will use it; earlier orders are unchanged.", error: false });
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["pos-stock-components", hotelId] }),
      cache.invalidateQueries({ queryKey: ["pos-catalog", hotelId] }),
      cache.invalidateQueries({ queryKey: ["restaurant-pos"] }),
    ]);
  }

  return <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5" aria-label="POS stock mapping">
    <h2 className="text-lg font-semibold">Automatic stock usage</h2>
    <p className="mt-1 text-sm leading-6 text-stone-600">Link a menu item or option to the actual stock consumed per unit sold. The restaurant draws from Restaurant stock; the bar draws from Bar stock. Transfer stock into those locations before selling. Existing orders are not backfilled.</p>
    <p className="mt-2 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-950">Unconfigured items still sell but do not reduce inventory. Complete the mapping before relying on stock-versus-sales figures. Use “No stock consumed” only for a genuinely non-stock option. An option that removes or substitutes an ingredient needs a carefully defined base recipe; do not mark it automatic until verified.</p>
    {notice && <p role={notice.error ? "alert" : "status"} className={`mt-3 rounded-lg p-3 text-sm ${notice.error ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-900"}`}>{notice.message}</p>}
    {(inventory.error || components.error) && <p role="alert" className="mt-3 text-sm text-red-800">Unable to load stock mappings. Confirm the latest migration and your catalog/inventory permissions.</p>}
    {(inventory.isLoading || components.isLoading) && <p className="mt-3 text-sm text-stone-500">Loading stock links…</p>}
    {inventory.data && components.data && <form onSubmit={(event) => void save(event)} className="mt-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Record type<select className={field} value={kind} onChange={(event) => { const nextKind = event.target.value as "menu_item" | "modifier_option"; setKind(nextKind); selectTarget("", nextKind); }}><option value="menu_item">Menu item</option><option value="modifier_option">Modifier option</option></select></label><label className="text-sm">Item or option<select className={field} required value={targetId} onChange={(event) => selectTarget(event.target.value)}><option value="">Select</option>{targets.map((entry) => <option key={entry.id} value={entry.id}>{outlets.find((outletEntry) => outletEntry.id === entry.outlet_id)?.name} · {entry.name} · {entry.stock_tracking_mode.replace("_", " ")}</option>)}</select></label></div>
      {target && <><p className="text-sm text-stone-600">{outlet?.name} · {existing.length} saved component{existing.length === 1 ? "" : "s"} · current mode {target.stock_tracking_mode.replace("_", " ")}</p><label className="block text-sm">Tracking mode<select className={field} value={mode} onChange={(event) => setMode(event.target.value as "automatic" | "non_stock")}><option value="automatic">Deduct stock automatically</option><option value="non_stock">No stock consumed</option></select></label>
        {mode === "automatic" && <div className="space-y-2"><p className="text-sm font-semibold">Ingredients per one sold unit</p>{draft.map((row, index) => <div key={index} className="flex flex-wrap items-end gap-2"><label className="min-w-48 flex-1 text-xs">Stock item<select className={field} required value={row.item_id} onChange={(event) => setDraft((current) => current.map((entry, at) => at === index ? { ...entry, item_id: event.target.value } : entry))}><option value="">Select stock item</option>{inventory.data.filter((item) => item.active || item.id === row.item_id).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.base_unit}{!item.active ? " (inactive)" : ""}</option>)}</select></label><label className="w-36 text-xs">Quantity per unit<input className={field} type="number" min="0.001" max="1000000" step="0.001" required value={row.quantity} onChange={(event) => setDraft((current) => current.map((entry, at) => at === index ? { ...entry, quantity: event.target.value } : entry))} /></label><button type="button" className="rounded-lg border border-stone-300 px-3 py-2 text-sm" onClick={() => setDraft((current) => current.filter((_, at) => at !== index))}>Remove</button></div>)}<button type="button" disabled={draft.length >= 30} onClick={() => setDraft((current) => [...current, { item_id: "", quantity: "1" }])} className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold disabled:opacity-50">Add ingredient</button></div>}
        <label className="block text-sm">Reason for this setup<input className={field} required minLength={5} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Verified against current kitchen or bar portion sheet" /></label>
        <FormSubmitButton disabled={busy || reason.trim().length < 5 || (mode === "automatic" && draft.length === 0)} className="rounded-lg bg-amber-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : "Save stock mapping"}</FormSubmitButton></>}
    </form>}
  </section>;
}
