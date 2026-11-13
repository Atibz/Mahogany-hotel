import { FormSubmitButton } from "@/components/shared/form-submit-button";
import { useActionMessage } from "@/components/shared/action-feedback";
import { useState, type FormEvent, type LabelHTMLAttributes, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers3, Plus, Utensils, WalletCards } from "lucide-react";

import { EmptyState, PageError, PageLoading } from "@/components/shared/page-state";
import { Modal } from "@/components/shared/modal";
import { useActiveHotel } from "@/features/reception/use-reception";
import { formatNaira, nairaToKobo } from "@/lib/money";
import { supabase } from "@/lib/supabase/client";
import { PosStockMapping } from "./pos-stock-mapping";

type Outlet = { id: string; code: string; name: string; outlet_type: "restaurant" | "bar"; department_code: string; kitchen_tickets_enabled: boolean; active: boolean };
type Category = { id: string; outlet_id: string; code: string; name: string; display_order: number; active: boolean };
type MenuItem = { id: string; outlet_id: string; category_id: string; code: string; name: string; description: string | null; display_order: number; active: boolean; stock_tracking_mode: "unconfigured" | "automatic" | "non_stock" };
type Price = { id: string; menu_item_id: string; amount_kobo: number; effective_from: string };
type ModifierGroup = { id: string; outlet_id: string; code: string; name: string; min_selections: number; max_selections: number; active: boolean };
type ModifierOption = { id: string; outlet_id: string; modifier_group_id: string; code: string; name: string; price_delta_kobo: number; active: boolean; stock_tracking_mode: "unconfigured" | "automatic" | "non_stock" };
type Department = { code: string; name: string };
type ModifierAssignment = { menu_item_id: string; modifier_group_id: string; active: boolean };
type CatalogData = { outlets: Outlet[]; categories: Category[]; items: MenuItem[]; prices: Price[]; groups: ModifierGroup[]; options: ModifierOption[]; assignments: ModifierAssignment[]; departments: Department[] };
type EditTarget =
  | { kind: "outlet"; record: Outlet; mode: "edit" | "status" }
  | { kind: "category"; record: Category; mode: "edit" | "status" }
  | { kind: "item"; record: MenuItem; mode: "edit" | "status" }
  | { kind: "group"; record: ModifierGroup; mode: "edit" | "status" }
  | { kind: "option"; record: ModifierOption; mode: "edit" | "status" };

const tabs = ["Outlets", "Menu", "Modifiers"] as const;
type Tab = (typeof tabs)[number];
const fieldClass = "mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-amber-700 focus:ring-2 focus:ring-amber-100";
const buttonClass = "inline-flex items-center justify-center gap-2 rounded-xl bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-950 disabled:cursor-not-allowed disabled:opacity-50";

async function loadCatalog(hotelId: string): Promise<CatalogData> {
  if (!supabase) throw new Error("Database connection is not configured.");
  const results = await Promise.all([
    supabase.from("pos_outlets").select("id, code, name, outlet_type, department_code, kitchen_tickets_enabled, active").eq("hotel_id", hotelId).order("name"),
    supabase.from("pos_menu_categories").select("id, outlet_id, code, name, display_order, active").eq("hotel_id", hotelId).order("display_order"),
    supabase.from("pos_menu_items").select("id, outlet_id, category_id, code, name, description, display_order, active, stock_tracking_mode").eq("hotel_id", hotelId).order("display_order"),
    supabase.from("pos_menu_item_prices").select("id, menu_item_id, amount_kobo, effective_from").eq("hotel_id", hotelId).order("effective_from", { ascending: false }),
    supabase.from("pos_modifier_groups").select("id, outlet_id, code, name, min_selections, max_selections, active").eq("hotel_id", hotelId).order("name"),
    supabase.from("pos_modifier_options").select("id, outlet_id, modifier_group_id, code, name, price_delta_kobo, active, stock_tracking_mode").eq("hotel_id", hotelId).order("name"),
    supabase.from("pos_menu_item_modifier_groups").select("menu_item_id, modifier_group_id, active").eq("hotel_id", hotelId).eq("active", true),
    supabase.from("departments").select("code, name").eq("hotel_id", hotelId).eq("active", true).order("name"),
  ]);
  const error = results.find((result) => result.error)?.error;
  if (error) throw error;
  return {
    outlets: (results[0].data ?? []) as Outlet[], categories: (results[1].data ?? []) as Category[],
    items: (results[2].data ?? []) as MenuItem[], prices: (results[3].data ?? []) as Price[],
    groups: (results[4].data ?? []) as ModifierGroup[], options: (results[5].data ?? []) as ModifierOption[],
    assignments: (results[6].data ?? []) as ModifierAssignment[], departments: (results[7].data ?? []) as Department[],
  };
}

function FormCard({ title, children, onSubmit, busy, submitLabel = "Save" }: { title: string; children: ReactNode; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean; submitLabel?: string }) {
  return <form onSubmit={onSubmit} className="space-y-3 rounded-2xl border border-stone-200 bg-stone-50 p-4">
    <h3 className="font-semibold text-stone-900">{title}</h3>{children}
    <FormSubmitButton className={buttonClass} disabled={busy}><Plus className="size-4" />{submitLabel}</FormSubmitButton>
  </form>;
}

function Label({ children, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label {...props} className={`block text-xs font-medium text-stone-600 ${props.className ?? ""}`}>{children}</label>;
}

export function PosCatalogPage() {
  const hotel = useActiveHotel();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("Outlets");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useActionMessage<string | null>(null);
  const [errorMessage, setErrorMessage] = useActionMessage<string | null>(null, "error");
  const [selectedMenuOutlet, setSelectedMenuOutlet] = useState("");
  const [selectedModifierItem, setSelectedModifierItem] = useState("");
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [unassignTarget, setUnassignTarget] = useState<ModifierAssignment | null>(null);
  const catalog = useQuery({ queryKey: ["pos-catalog", hotel.data?.id], queryFn: () => loadCatalog(hotel.data!.id), enabled: Boolean(hotel.data?.id) });
  const activeOutlets = catalog.data?.outlets.filter((outlet) => outlet.active) ?? [];
  const activeItems = catalog.data?.items.filter((item) => item.active) ?? [];
  const activeGroups = catalog.data?.groups.filter((group) => group.active) ?? [];
  const categories = catalog.data?.categories ?? [];
  const prices = catalog.data?.prices ?? [];
  const currentPrices = new Map<string, Price>();
  for (const price of prices) if (!currentPrices.has(price.menu_item_id)) currentPrices.set(price.menu_item_id, price);

  async function save(action: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true); setMessage(null); setErrorMessage(null);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ["pos-catalog", hotel.data?.id] });
      setMessage(success);
      return true;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The catalog change could not be saved.");
      return false;
    } finally { setBusy(false); }
  }
  async function rpc(name: string, args: Record<string, unknown>) {
    if (!supabase) throw new Error("Database connection is not configured.");
    const { error } = await supabase.rpc(name, args as never);
    if (error) throw error;
  }
  function submit(event: FormEvent<HTMLFormElement>, action: (form: FormData) => Promise<unknown>, success: string) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    void save(() => action(form), success).then((saved) => {
      if (saved) {
        formElement.reset();
        setSelectedMenuOutlet("");
        setSelectedModifierItem("");
      }
    });
  }
  function signedNairaToKobo(rawValue: string) {
    const normalized = rawValue.replace(/,/g, "").trim();
    const amount = Number(normalized);
    if (!normalized || !Number.isFinite(amount)) throw new Error("Enter a valid price adjustment.");
    return Math.round(amount * 100);
  }
  function submitCatalogChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editTarget) return;
    const form = new FormData(event.currentTarget);
    const reason = String(form.get("reason") ?? "");
    const active = editTarget.mode === "status" ? !editTarget.record.active : undefined;
    let action: Promise<unknown>;
    if (editTarget.kind === "outlet") {
      action = editTarget.mode === "status"
        ? rpc("set_pos_outlet_active", { target_outlet_id: editTarget.record.id, should_be_active: active, change_reason: reason })
        : rpc("update_pos_outlet", { target_outlet_id: editTarget.record.id, outlet_name_value: form.get("name"), department_code_value: form.get("department"), kitchen_tickets_enabled_value: form.get("tickets") === "on", change_reason: reason });
    } else if (editTarget.kind === "category") {
      action = editTarget.mode === "status"
        ? rpc("set_pos_menu_category_active", { target_category_id: editTarget.record.id, should_be_active: active, change_reason: reason })
        : rpc("update_pos_menu_category", { target_category_id: editTarget.record.id, category_name_value: form.get("name"), display_order_value: Number(form.get("order")), change_reason: reason });
    } else if (editTarget.kind === "item") {
      action = editTarget.mode === "status"
        ? rpc("set_pos_menu_item_active", { target_menu_item_id: editTarget.record.id, should_be_active: active, change_reason: reason })
        : rpc("update_pos_menu_item", { target_menu_item_id: editTarget.record.id, target_category_id: form.get("category"), item_name_value: form.get("name"), item_description_value: form.get("description"), display_order_value: Number(form.get("order")), change_reason: reason });
    } else if (editTarget.kind === "group") {
      action = editTarget.mode === "status"
        ? rpc("set_pos_modifier_group_active", { target_modifier_group_id: editTarget.record.id, should_be_active: active, change_reason: reason })
        : rpc("update_pos_modifier_group", { target_modifier_group_id: editTarget.record.id, group_name_value: form.get("name"), minimum_selections: Number(form.get("minimum")), maximum_selections: Number(form.get("maximum")), display_order_value: Number(form.get("order")), change_reason: reason });
    } else {
      action = editTarget.mode === "status"
        ? rpc("set_pos_modifier_option_active", { target_modifier_option_id: editTarget.record.id, should_be_active: active, change_reason: reason })
        : rpc("update_pos_modifier_option", { target_modifier_option_id: editTarget.record.id, option_name_value: form.get("name"), price_delta_kobo_value: signedNairaToKobo(String(form.get("delta"))), display_order_value: Number(form.get("order")), change_reason: reason });
    }
    const title = editTarget.mode === "status"
      ? active ? "Catalog record reactivated and logged." : "Catalog record retired and logged."
      : "Catalog record updated and logged.";
    void save(() => action, title).then((saved) => { if (saved) setEditTarget(null); });
  }
  function submitUnassign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!unassignTarget) return;
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
    void save(() => rpc("remove_pos_modifier_group", {
      target_menu_item_id: unassignTarget.menu_item_id,
      target_modifier_group_id: unassignTarget.modifier_group_id,
      change_reason: reason,
    }), "Modifier group removed from the item and logged.").then((saved) => { if (saved) setUnassignTarget(null); });
  }

  if (hotel.isLoading || catalog.isLoading) return <PageLoading />;
  if (hotel.error || catalog.error) return <PageError message="Unable to load the POS catalog. Confirm the GM catalog permission and that the catalog migration is installed." />;
  if (!hotel.data || !catalog.data) return <EmptyState>POS catalog is not available for this hotel.</EmptyState>;

  const outletOptions = activeOutlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name} ({outlet.outlet_type})</option>);
  const itemOptions = activeItems.map((item) => <option key={item.id} value={item.id}>{item.name} · {activeOutlets.find((outlet) => outlet.id === item.outlet_id)?.name}</option>);
  const groupOptions = activeGroups.map((group) => <option key={group.id} value={group.id}>{group.name} · {activeOutlets.find((outlet) => outlet.id === group.outlet_id)?.name}</option>);
  const compatibleGroupOptions = activeGroups.filter((group) => group.outlet_id === activeItems.find((item) => item.id === selectedModifierItem)?.outlet_id).map((group) => <option key={group.id} value={group.id}>{group.name}</option>);

  return <section className="max-w-6xl space-y-5">
    <header className="rounded-3xl bg-gradient-to-br from-amber-950 via-amber-900 to-orange-800 p-6 text-white shadow-sm sm:p-8">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-200">Food & beverage setup</p>
      <div className="mt-2 flex items-start gap-3"><div className="rounded-2xl bg-white/10 p-3"><Utensils className="size-6" /></div><div><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">POS catalog</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-amber-50/85">Configure outlets, menu items, and options. This page does not record sales, collect payments, post charges to guest folios, or calculate tax.</p></div></div>
    </header>
    <aside className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-950">
      <p className="font-semibold">Keep outlet revenue separate</p>
      <p className="mt-1">Map restaurant and bar outlets to their own approved departments. Do not map food-and-beverage sales into hotel-room revenue or treat one combined guest payment as proof that the revenue has the same tax treatment. This catalog stores department routing only; separate POS accounts, tax rules, and internal balancing will be handled in the order/accounting workflow after the accountant confirms the mapping.</p>
    </aside>
    {message && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{message}</p>}
    {errorMessage && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">{errorMessage}</p>}
    <nav aria-label="POS catalog sections" className="flex gap-2 overflow-x-auto rounded-2xl border border-stone-200 bg-white p-2 shadow-sm">
      {tabs.map((name) => <button key={name} type="button" onClick={() => setTab(name)} aria-current={tab === name ? "page" : undefined} className={`rounded-xl px-4 py-2 text-sm font-medium ${tab === name ? "bg-amber-900 text-white" : "text-stone-600 hover:bg-stone-100"}`}>{name}</button>)}
    </nav>

    {tab === "Outlets" && <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,.8fr)]">
      <div className="space-y-3"><h2 className="text-lg font-semibold">Your outlets <span className="text-sm font-normal text-stone-500">{activeOutlets.length} active</span></h2>
        {catalog.data.outlets.length ? catalog.data.outlets.map((outlet) => <article key={outlet.id} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{outlet.name}</h3><p className="mt-1 text-sm text-stone-500">{outlet.code} · {outlet.outlet_type} · department {outlet.department_code}</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${outlet.active ? "bg-emerald-50 text-emerald-800" : "bg-stone-100 text-stone-600"}`}>{outlet.active ? "Active" : "Retired"}</span></div><p className="mt-3 text-xs text-stone-500">{outlet.kitchen_tickets_enabled ? "Kitchen tickets enabled" : "Kitchen tickets off"}</p><div className="mt-3 flex gap-2"><button type="button" onClick={() => setEditTarget({ kind: "outlet", record: outlet, mode: "edit" })} className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium hover:bg-stone-50">Edit outlet</button><button type="button" onClick={() => setEditTarget({ kind: "outlet", record: outlet, mode: "status" })} className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium hover:bg-stone-50">{outlet.active ? "Retire outlet" : "Reactivate outlet"}</button></div></article>) : <EmptyState>No POS outlets configured yet.</EmptyState>}</div>
      <FormCard title="Add an outlet" busy={busy} onSubmit={(event) => submit(event, (form) => rpc("create_pos_outlet", { target_hotel_id: hotel.data!.id, outlet_code_value: form.get("code"), outlet_name_value: form.get("name"), outlet_type_value: form.get("type"), department_code_value: form.get("department"), kitchen_tickets_enabled_value: form.get("tickets") === "on" }), "Outlet created and recorded in the audit trail.")}>
        <Label>Outlet name<input className={fieldClass} name="name" required maxLength={100} placeholder="e.g. 6393 Restaurant" /></Label>
        <Label>Unique code<input className={fieldClass} name="code" required pattern="[a-z][a-z0-9_]{1,48}" title="Use lowercase letters, numbers, and underscores; begin with a letter." placeholder="e.g. restaurant" /></Label>
        <Label>Outlet type<select className={fieldClass} name="type" required><option value="restaurant">Restaurant</option><option value="bar">Bar</option></select></Label>
        <Label>Revenue department<select className={fieldClass} name="department" required defaultValue=""><option value="" disabled>Select a department</option>{catalog.data.departments.map((department) => <option key={department.code} value={department.code}>{department.name} ({department.code})</option>)}</select></Label>
        <label className="flex items-center gap-2 text-sm text-stone-700"><input name="tickets" type="checkbox" className="size-4 accent-amber-900" />Enable kitchen tickets (leave off until the outlet confirms its process)</label>
      </FormCard>
    </div>}

    {tab === "Menu" && <div className="grid gap-5 xl:grid-cols-2">
      <FormCard title="Add a menu category" busy={busy} onSubmit={(event) => submit(event, (form) => rpc("create_pos_menu_category", { target_outlet_id: form.get("outlet"), category_code_value: form.get("code"), category_name_value: form.get("name"), display_order_value: Number(form.get("order") || 0) }), "Category created.")}>
        <Label>Outlet<select className={fieldClass} name="outlet" required defaultValue="">{outletOptions.length ? <option value="" disabled>Select an outlet</option> : <option value="" disabled>Create an outlet first</option>}{outletOptions}</select></Label>
        <div className="grid gap-3 sm:grid-cols-2"><Label>Category name<input className={fieldClass} name="name" required maxLength={100} placeholder="e.g. Main dishes" /></Label><Label>Code<input className={fieldClass} name="code" required pattern="[a-z][a-z0-9_]{1,48}" placeholder="main_dishes" /></Label></div>
        <Label>Display order<input className={fieldClass} name="order" type="number" min="0" max="32767" defaultValue="0" /></Label>
      </FormCard>
      <FormCard title="Add a menu item" busy={busy} onSubmit={(event) => submit(event, (form) => rpc("create_pos_menu_item", { target_outlet_id: form.get("outlet"), target_category_id: form.get("category"), item_code_value: form.get("code"), item_name_value: form.get("name"), item_description_value: form.get("description"), display_order_value: Number(form.get("order") || 0), initial_price_kobo: nairaToKobo(String(form.get("price"))), effective_from_value: form.get("effectiveFrom") || null }), "Menu item created with an effective-dated price.")}>
        <Label>Outlet<select className={fieldClass} name="outlet" required defaultValue="" onChange={(event) => setSelectedMenuOutlet(event.target.value)}><option value="" disabled>Select an outlet</option>{outletOptions}</select></Label>
        <Label>Category<select className={fieldClass} name="category" required defaultValue=""><option value="" disabled>Select a category</option>{categories.filter((category) => category.active && category.outlet_id === selectedMenuOutlet).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Label>
        <div className="grid gap-3 sm:grid-cols-2"><Label>Item name<input className={fieldClass} name="name" required maxLength={120} /></Label><Label>Code<input className={fieldClass} name="code" required pattern="[a-z][a-z0-9_]{1,48}" placeholder="grilled_chicken" /></Label></div>
        <Label>Description<textarea className={fieldClass} name="description" rows={2} maxLength={500} /></Label>
        <div className="grid gap-3 sm:grid-cols-2"><Label>Starting price (₦)<input className={fieldClass} name="price" required type="number" min="0.01" step="0.01" /></Label><Label>Price effective from<input className={fieldClass} name="effectiveFrom" type="date" /></Label></div>
        <Label>Display order<input className={fieldClass} name="order" type="number" min="0" max="32767" defaultValue="0" /></Label>
      </FormCard>
      <div className="xl:col-span-2">
        <div className="flex items-center gap-2"><Layers3 className="size-5 text-amber-900" /><h2 className="text-lg font-semibold">Menu categories</h2></div>
        {categories.length ? <div className="mt-3 grid gap-3 md:grid-cols-2">{categories.map((category) => <article key={category.id} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{category.name}</h3><p className="mt-1 text-sm text-stone-500">{catalog.data.outlets.find((outlet) => outlet.id === category.outlet_id)?.name} · {category.code} · order {category.display_order}</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${category.active ? "bg-emerald-50 text-emerald-800" : "bg-stone-100 text-stone-600"}`}>{category.active ? "Active" : "Retired"}</span></div><div className="mt-3 flex gap-2"><button type="button" onClick={() => setEditTarget({ kind: "category", record: category, mode: "edit" })} className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium hover:bg-stone-50">Edit</button><button type="button" onClick={() => setEditTarget({ kind: "category", record: category, mode: "status" })} className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium hover:bg-stone-50">{category.active ? "Retire" : "Reactivate"}</button></div></article>)}</div> : <div className="mt-3"><EmptyState>No categories have been added.</EmptyState></div>}
      </div>
      <div className="xl:col-span-2"><div className="flex items-center gap-2"><WalletCards className="size-5 text-amber-900" /><h2 className="text-lg font-semibold">Menu items · latest recorded prices</h2></div>
        {catalog.data.items.length ? <div className="mt-3 overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm"><div className="divide-y divide-stone-100">{catalog.data.items.map((item) => { const category = categories.find((entry) => entry.id === item.category_id); const outlet = catalog.data.outlets.find((entry) => entry.id === item.outlet_id); const price = currentPrices.get(item.id); const assignedGroups = catalog.data.assignments.filter((assignment) => assignment.menu_item_id === item.id).map((assignment) => ({ assignment, name: catalog.data.groups.find((group) => group.id === assignment.modifier_group_id)?.name ?? "Modifier group" })); return <article key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-4"><div className="min-w-[12rem] flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{item.name}</h3><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${item.active ? "bg-emerald-50 text-emerald-800" : "bg-stone-100 text-stone-600"}`}>{item.active ? "Active" : "Retired"}</span></div><p className="mt-1 text-sm text-stone-500">{outlet?.name} · {category?.name} · {item.code}</p>{assignedGroups.length > 0 && <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone-500">{assignedGroups.map(({ assignment, name }) => <li key={assignment.modifier_group_id} className="inline-flex items-center gap-1">{name}<button type="button" onClick={() => setUnassignTarget(assignment)} className="font-semibold text-amber-900 underline underline-offset-2">Remove</button></li>)}</ul>}<div className="mt-3 flex gap-2"><button type="button" onClick={() => setEditTarget({ kind: "item", record: item, mode: "edit" })} className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium hover:bg-stone-50">Edit item</button><button type="button" onClick={() => setEditTarget({ kind: "item", record: item, mode: "status" })} className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium hover:bg-stone-50">{item.active ? "Retire item" : "Reactivate item"}</button></div></div><p className="font-semibold text-stone-900">{price ? formatNaira(price.amount_kobo) : "No price"}<span className="ml-2 text-xs font-normal text-stone-500">{price?.effective_from ? `from ${price.effective_from}` : ""}</span></p></article>; })}</div></div> : <div className="mt-3"><EmptyState>Create an outlet and category, then add menu items.</EmptyState></div>}
      </div>
      <div className="xl:col-span-2"><PosStockMapping hotelId={hotel.data.id} menuItems={catalog.data.items} modifierOptions={catalog.data.options} outlets={catalog.data.outlets} /></div>
      <FormCard title="Schedule a new price" busy={busy} submitLabel="Add price period" onSubmit={(event) => submit(event, (form) => rpc("set_pos_menu_item_price", { target_menu_item_id: form.get("item"), new_price_kobo: nairaToKobo(String(form.get("price"))), effective_from_value: form.get("effectiveFrom") }), "Price period added. Earlier prices remain unchanged.")}>
        <Label>Menu item<select className={fieldClass} name="item" required defaultValue=""><option value="" disabled>Select an item</option>{itemOptions}</select></Label>
        <div className="grid gap-3 sm:grid-cols-2"><Label>New price (₦)<input className={fieldClass} name="price" required type="number" min="0.01" step="0.01" /></Label><Label>Effective from<input className={fieldClass} name="effectiveFrom" required type="date" /></Label></div>
        <p className="text-xs leading-5 text-stone-500">A new price period is appended; existing prices are never overwritten. The database rejects backdated prices.</p>
      </FormCard>
    </div>}

    {tab === "Modifiers" && <div className="grid gap-5 xl:grid-cols-2">
      <FormCard title="Create modifier group" busy={busy} onSubmit={(event) => submit(event, (form) => rpc("create_pos_modifier_group", { target_outlet_id: form.get("outlet"), group_code_value: form.get("code"), group_name_value: form.get("name"), minimum_selections: Number(form.get("minimum")), maximum_selections: Number(form.get("maximum")), display_order_value: Number(form.get("order") || 0) }), "Modifier group created.")}>
        <Label>Outlet<select className={fieldClass} name="outlet" required defaultValue=""><option value="" disabled>Select an outlet</option>{outletOptions}</select></Label>
        <div className="grid gap-3 sm:grid-cols-2"><Label>Group name<input className={fieldClass} name="name" required maxLength={100} placeholder="e.g. Choose a side" /></Label><Label>Code<input className={fieldClass} name="code" required pattern="[a-z][a-z0-9_]{1,48}" placeholder="side_choice" /></Label></div>
        <div className="grid gap-3 sm:grid-cols-3"><Label>Minimum<input className={fieldClass} name="minimum" type="number" min="0" max="20" defaultValue="0" /></Label><Label>Maximum<input className={fieldClass} name="maximum" type="number" min="1" max="20" defaultValue="1" /></Label><Label>Order<input className={fieldClass} name="order" type="number" min="0" max="32767" defaultValue="0" /></Label></div>
      </FormCard>
      <FormCard title="Add an option" busy={busy} onSubmit={(event) => submit(event, (form) => rpc("create_pos_modifier_option", { target_modifier_group_id: form.get("group"), option_code_value: form.get("code"), option_name_value: form.get("name"), price_delta_kobo_value: signedNairaToKobo(String(form.get("delta") || "0")), display_order_value: Number(form.get("order") || 0) }), "Modifier option created.")}>
        <Label>Modifier group<select className={fieldClass} name="group" required defaultValue=""><option value="" disabled>Select a group</option>{groupOptions}</select></Label>
        <div className="grid gap-3 sm:grid-cols-2"><Label>Option name<input className={fieldClass} name="name" required maxLength={100} /></Label><Label>Code<input className={fieldClass} name="code" required pattern="[a-z][a-z0-9_]{1,48}" /></Label></div>
        <div className="grid gap-3 sm:grid-cols-2"><Label>Price adjustment (₦)<input className={fieldClass} name="delta" type="number" step="0.01" defaultValue="0" /></Label><Label>Display order<input className={fieldClass} name="order" type="number" min="0" max="32767" defaultValue="0" /></Label></div>
      </FormCard>
      <FormCard title="Attach options to a menu item" busy={busy} onSubmit={(event) => submit(event, (form) => rpc("assign_pos_modifier_group", { target_menu_item_id: form.get("item"), target_modifier_group_id: form.get("group") }), "Modifier group attached to the menu item.")}>
        <Label>Menu item<select className={fieldClass} name="item" required defaultValue="" onChange={(event) => setSelectedModifierItem(event.target.value)}><option value="" disabled>Select an item</option>{itemOptions}</select></Label>
        <Label>Compatible modifier group<select className={fieldClass} name="group" required defaultValue=""><option value="" disabled>Select a group from the same outlet</option>{compatibleGroupOptions}</select></Label>
        <p className="text-xs leading-5 text-stone-500">The database enforces that the group belongs to the same outlet as the item and prevents duplicate assignments.</p>
      </FormCard>
      <div className="xl:col-span-2"><h2 className="flex items-center gap-2 text-lg font-semibold"><Layers3 className="size-5 text-amber-900" />Modifier groups and options</h2>
        {catalog.data.groups.length ? <div className="mt-3 grid gap-3 md:grid-cols-2">{catalog.data.groups.map((group) => <article key={group.id} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold">{group.name}</h3><p className="mt-1 text-xs text-stone-500">{catalog.data.outlets.find((outlet) => outlet.id === group.outlet_id)?.name} · {group.code} · choose {group.min_selections}–{group.max_selections}</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${group.active ? "bg-emerald-50 text-emerald-800" : "bg-stone-100 text-stone-600"}`}>{group.active ? "Active" : "Retired"}</span></div><div className="mt-3 flex gap-2"><button type="button" onClick={() => setEditTarget({ kind: "group", record: group, mode: "edit" })} className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium hover:bg-stone-50">Edit group</button><button type="button" onClick={() => setEditTarget({ kind: "group", record: group, mode: "status" })} className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium hover:bg-stone-50">{group.active ? "Retire group" : "Reactivate group"}</button></div><ul className="mt-3 space-y-2 border-t border-stone-100 pt-3 text-sm">{catalog.data.options.filter((option) => option.modifier_group_id === group.id).map((option) => <li key={option.id} className="flex flex-wrap items-center justify-between gap-2"><span>{option.name} <span className="text-xs text-stone-500">{option.active ? "" : "· retired"}</span></span><span className="ml-auto">{option.price_delta_kobo === 0 ? "Included" : `${option.price_delta_kobo < 0 ? "−" : "+"}${formatNaira(Math.abs(option.price_delta_kobo))}`}</span><span className="flex gap-1"><button type="button" onClick={() => setEditTarget({ kind: "option", record: option, mode: "edit" })} className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50">Edit</button><button type="button" onClick={() => setEditTarget({ kind: "option", record: option, mode: "status" })} className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50">{option.active ? "Retire" : "Reactivate"}</button></span></li>)}</ul></article>)}</div> : <div className="mt-3"><EmptyState>No modifier groups configured.</EmptyState></div>}
      </div>
    </div>}
    {editTarget && <Modal open title={`${editTarget.mode === "status" ? (editTarget.record.active ? "Retire " : "Reactivate ") : "Edit "}${editTarget.kind === "item" ? "menu item" : editTarget.kind}`} onClose={() => { if (!busy) setEditTarget(null); }}>
      <form onSubmit={submitCatalogChange} className="space-y-4">
        {editTarget.mode === "status" ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-5 text-amber-950">{editTarget.record.active ? "Retirement preserves its history and prevents it being selected for future setup/sales. Dependent records may also be retired." : "Reactivation affects this record only; previously retired child records stay retired and must be reactivated separately."}</div> : <>
          {editTarget.kind === "outlet" && <><Label>Outlet name<input className={fieldClass} name="name" defaultValue={editTarget.record.name} required maxLength={100} /></Label><Label>Accounting department<select className={fieldClass} name="department" defaultValue={editTarget.record.department_code} required>{catalog.data.departments.map((department) => <option key={department.code} value={department.code}>{department.name} ({department.code})</option>)}</select><span className="mt-1 block text-xs text-stone-500">Changing this mapping routes future POS activity only; it does not rewrite prior entries.</span></Label><label className="flex items-center gap-2 text-sm"><input name="tickets" type="checkbox" defaultChecked={editTarget.record.kitchen_tickets_enabled} className="size-4 accent-amber-900" />Kitchen tickets enabled</label></>}
          {editTarget.kind === "category" && <><Label>Category name<input className={fieldClass} name="name" defaultValue={editTarget.record.name} required maxLength={100} /></Label><Label>Display order<input className={fieldClass} name="order" type="number" min="0" max="32767" defaultValue={editTarget.record.display_order} required /></Label></>}
          {editTarget.kind === "item" && <><Label>Menu item name<input className={fieldClass} name="name" defaultValue={editTarget.record.name} required maxLength={120} /></Label><Label>Category<select className={fieldClass} name="category" defaultValue={editTarget.record.category_id} required>{categories.filter((category) => category.active && category.outlet_id === editTarget.record.outlet_id).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Label><Label>Description<textarea className={fieldClass} name="description" rows={2} maxLength={500} defaultValue={editTarget.record.description ?? ""} /></Label><Label>Display order<input className={fieldClass} name="order" type="number" min="0" max="32767" defaultValue={editTarget.record.display_order} required /></Label><p className="text-xs text-stone-500">Menu item code is permanent. Price changes must be added as new effective-dated periods.</p></>}
          {editTarget.kind === "group" && <><Label>Modifier group name<input className={fieldClass} name="name" defaultValue={editTarget.record.name} required maxLength={100} /></Label><div className="grid grid-cols-3 gap-2"><Label>Min<select className={fieldClass} name="minimum" defaultValue={editTarget.record.min_selections}>{Array.from({ length: 21 }, (_, value) => <option key={value} value={value}>{value}</option>)}</select></Label><Label>Max<select className={fieldClass} name="maximum" defaultValue={editTarget.record.max_selections}>{Array.from({ length: 20 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select></Label><Label>Order<input className={fieldClass} name="order" type="number" min="0" max="32767" defaultValue={0} /></Label></div></>}
          {editTarget.kind === "option" && <><Label>Option name<input className={fieldClass} name="name" defaultValue={editTarget.record.name} required maxLength={100} /></Label><div className="grid grid-cols-2 gap-2"><Label>Price adjustment (₦)<input className={fieldClass} name="delta" type="number" step="0.01" defaultValue={editTarget.record.price_delta_kobo / 100} required /></Label><Label>Display order<input className={fieldClass} name="order" type="number" min="0" max="32767" defaultValue={0} required /></Label></div></>}
        </>}
        <Label>Reason<input className={fieldClass} name="reason" required minLength={3} maxLength={500} placeholder="Why is this change needed?" /></Label>
        <div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => setEditTarget(null)} className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm">Cancel</button><FormSubmitButton className={buttonClass} disabled={busy}>{busy ? "Saving…" : editTarget.mode === "status" ? "Confirm status change" : "Save audited change"}</FormSubmitButton></div>
      </form>
    </Modal>}
    {unassignTarget && <Modal open title="Remove modifier group from item" onClose={() => { if (!busy) setUnassignTarget(null); }}><form onSubmit={submitUnassign} className="space-y-4"><p className="text-sm leading-5 text-stone-600">This removes the group from future selections on this menu item; it does not delete the group or its options.</p><Label>Reason<input className={fieldClass} name="reason" required minLength={3} maxLength={500} /></Label><div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => setUnassignTarget(null)} className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm">Cancel</button><FormSubmitButton className={buttonClass} disabled={busy}>Remove and record</FormSubmitButton></div></form></Modal>}
    <p className="text-xs leading-5 text-stone-500">Catalog edits and retirements require a reason and create audit evidence. Prices remain append-only. No sales, payments, guest-folio posting, or tax calculations happen here.</p>
  </section>;
}
