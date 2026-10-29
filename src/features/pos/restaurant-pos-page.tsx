import { FormSubmitButton } from "@/components/shared/form-submit-button";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock3, Plus, Printer, Utensils, WalletCards } from "lucide-react";

import { Modal } from "@/components/shared/modal";
import { EmptyState, PageError, PageLoading } from "@/components/shared/page-state";
import { useAccess } from "@/features/auth/use-access";
import { useActiveHotel } from "@/features/reception/use-reception";
import { formatNaira, nairaToKobo } from "@/lib/money";
import { printElementInIsolatedFrame } from "@/lib/print-document";
import { supabase } from "@/lib/supabase/client";
import { loadAllPages } from "@/lib/supabase/load-all-pages";
import { mergeRecentAndOpenOrders } from "./order-workspace";

type Outlet = { id: string; name: string; code: string; department_code: string };
type MenuItem = { id: string; outlet_id: string; category_id: string; name: string; code: string };
type Category = { id: string; name: string; display_order: number };
type Price = { menu_item_id: string; amount_kobo: number; effective_from: string };
type ModifierGroup = { id: string; outlet_id: string; name: string; min_selections: number; max_selections: number; display_order: number };
type ModifierOption = { id: string; outlet_id: string; modifier_group_id: string; name: string; price_delta_kobo: number; display_order: number };
type ModifierAssignment = { menu_item_id: string; modifier_group_id: string };
type LineModifier = { id: string; order_line_id: string; group_name_snapshot: string; option_name_snapshot: string; price_delta_kobo: number };
type Method = { id: string; name: string; code: string; requires_reference: boolean; requires_verification: boolean };
type Order = { id: string; outlet_id: string; order_number: string; business_date: string; service_mode: string; table_reference: string | null; guest_label: string | null; outlet_name_snapshot: string; department_code_snapshot: string; status: "open" | "settled" | "voided"; created_at: string };
type Line = { id: string; order_id: string; item_name_snapshot: string; base_unit_price_kobo: number; unit_price_kobo: number; quantity: number; line_total_kobo: number };
type Tender = { id: string; order_id: string; payment_number: string; payment_method_name_snapshot: string; amount_kobo: number; reference: string | null; status: "completed" | "pending_verification" | "voided"; received_at: string; verification_note: string | null };
type HotelCollection = { order_id: string; payment_number: string; amount_kobo: number; status: "completed" | "pending_verification" | "refunded" | "voided"; received_at: string; reference: string | null };
type Receipt = { id: string; payment_id: string; receipt_number: string; order_number_snapshot: string; outlet_name_snapshot: string; department_code_snapshot: string; payment_method_name_snapshot: string; amount_kobo: number; reference: string | null; issued_at: string };
type Refund = { id: string; order_id: string; payment_id: string; refund_number: string; amount_kobo: number; payment_method_name_snapshot: string; reference: string | null; reason: string; refunded_at: string };
type LineCorrection = { id: string; order_id: string; order_line_id: string; correction_number: string; line_name_snapshot: string; amount_delta_kobo: number; description: string; reason: string; corrected_at: string };
type Shift = { id: string; outlet_id: string; shift_number: string; opening_float_kobo: number; opened_at: string };
type Workspace = { date: string; userId: string; outlets: Outlet[]; categories: Category[]; items: MenuItem[]; prices: Price[]; modifierGroups: ModifierGroup[]; modifierOptions: ModifierOption[]; modifierAssignments: ModifierAssignment[]; lines: Line[]; lineModifiers: LineModifier[]; methods: Method[]; orders: Order[]; tenders: Tender[]; hotelCollections: HotelCollection[]; receipts: Receipt[]; shifts: Shift[]; refunds: Refund[]; corrections: LineCorrection[] };

const field = "w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-amber-700 focus:ring-2 focus:ring-amber-100";
const primary = "inline-flex items-center justify-center gap-2 rounded-xl bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-950 disabled:opacity-50";

type PosOutletType = "restaurant" | "bar";

async function loadRowsForIds<T>(
  ids: string[],
  loadPage: (ids: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const groups: string[][] = [];
  for (let index = 0; index < ids.length; index += 30) groups.push(ids.slice(index, index + 30));
  const pages = await Promise.all(groups.map((group) => loadAllPages<T>((from, to) => loadPage(group, from, to))));
  return pages.flat();
}

async function loadWorkspace(hotelId: string, outletType: PosOutletType): Promise<Workspace> {
  const client = supabase;
  if (!client) throw new Error("Database connection is not configured.");
  const [dateResult, userResult] = await Promise.all([
    client.rpc("get_restaurant_pos_business_date", { target_hotel_id: hotelId }),
    client.auth.getUser(),
  ]);
  if (dateResult.error) throw dateResult.error;
  if (userResult.error) throw userResult.error;
  if (!dateResult.data || !userResult.data.user) throw new Error("A hotel business date and signed-in user are required.");
  const date = dateResult.data;
  const userId = userResult.data.user.id;
  const results = await Promise.all([
    client.from("pos_outlets").select("id,name,code,department_code").eq("hotel_id", hotelId).eq("active", true).eq("outlet_type", outletType).order("name"),
    client.from("pos_menu_categories").select("id,name,display_order").eq("hotel_id", hotelId).eq("active", true).order("display_order"),
    client.from("pos_menu_items").select("id,outlet_id,category_id,name,code").eq("hotel_id", hotelId).eq("active", true).order("display_order"),
    client.from("pos_menu_item_prices").select("menu_item_id,amount_kobo,effective_from").eq("hotel_id", hotelId).lte("effective_from", date).order("effective_from", { ascending: false }),
    client.from("pos_modifier_groups").select("id,outlet_id,name,min_selections,max_selections,display_order").eq("hotel_id", hotelId).eq("active", true).order("display_order"),
    client.from("pos_modifier_options").select("id,outlet_id,modifier_group_id,name,price_delta_kobo,display_order").eq("hotel_id", hotelId).eq("active", true).order("display_order"),
    client.from("pos_menu_item_modifier_groups").select("menu_item_id,modifier_group_id").eq("hotel_id", hotelId).eq("active", true),
    client.from("payment_methods").select("id,name,code,requires_reference,requires_verification").eq("hotel_id", hotelId).eq("active", true).order("display_order"),
    client.from("pos_cashier_shifts").select("id,outlet_id,shift_number,opening_float_kobo,opened_at").eq("hotel_id", hotelId).eq("opened_by", userId).eq("status", "open").order("opened_at", { ascending: false }),
  ]);
  const error = results.find((result) => result.error)?.error;
  if (error) throw error;
  const outlets = (results[0].data ?? []) as Outlet[];
  const outletIds = new Set(outlets.map((outlet) => outlet.id));
  const [recentOrders, openOrders] = outletIds.size
    ? await Promise.all([
      client.from("pos_orders")
        .select("id,outlet_id,order_number,business_date,service_mode,table_reference,guest_label,outlet_name_snapshot,department_code_snapshot,status,created_at")
        .eq("hotel_id", hotelId).in("outlet_id", [...outletIds])
        .order("created_at", { ascending: false }).order("id").limit(60),
      loadAllPages<Order>(async (from, to) => {
        const { data, error: pageError } = await client.from("pos_orders")
          .select("id,outlet_id,order_number,business_date,service_mode,table_reference,guest_label,outlet_name_snapshot,department_code_snapshot,status,created_at")
          .eq("hotel_id", hotelId).in("outlet_id", [...outletIds]).eq("status", "open")
          .order("created_at", { ascending: false }).order("id").range(from, to);
        return { data: (data ?? []) as Order[], error: pageError };
      }),
    ])
    : [{ data: [], error: null }, [] as Order[]];
  if (recentOrders.error) throw recentOrders.error;
  const orders = mergeRecentAndOpenOrders((recentOrders.data ?? []) as Order[], openOrders, outletIds);
  const orderIds = orders.map((order) => order.id);
  const [lines, tenders, refunds, corrections] = await Promise.all([
    loadRowsForIds<Line>(orderIds, async (ids, from, to) => {
      const { data, error } = await client.from("pos_order_lines").select("id,order_id,item_name_snapshot,base_unit_price_kobo,unit_price_kobo,quantity,line_total_kobo").in("order_id", ids).order("created_at").order("id").range(from, to);
      return { data: (data ?? []) as Line[], error };
    }),
    loadRowsForIds<Tender>(orderIds, async (ids, from, to) => {
      const { data, error } = await client.from("pos_order_payments").select("id,order_id,payment_number,payment_method_name_snapshot,amount_kobo,reference,status,received_at,verification_note").in("order_id", ids).order("received_at", { ascending: false }).order("id").range(from, to);
      return { data: (data ?? []) as Tender[], error };
    }),
    loadRowsForIds<Refund>(orderIds, async (ids, from, to) => {
      const { data, error } = await client.from("pos_order_refunds").select("id,order_id,payment_id,refund_number,amount_kobo,payment_method_name_snapshot,reference,reason,refunded_at").in("order_id", ids).order("refunded_at", { ascending: false }).order("id").range(from, to);
      return { data: (data ?? []) as Refund[], error };
    }),
    loadRowsForIds<LineCorrection>(orderIds, async (ids, from, to) => {
      const { data, error } = await client.from("pos_order_line_corrections").select("id,order_id,order_line_id,correction_number,line_name_snapshot,amount_delta_kobo,description,reason,corrected_at").in("order_id", ids).order("corrected_at", { ascending: false }).order("id").range(from, to);
      return { data: (data ?? []) as LineCorrection[], error };
    }),
  ]);
  const [lineModifiers, receipts] = await Promise.all([
    loadRowsForIds<LineModifier>(lines.map((line) => line.id), async (ids, from, to) => {
      const { data, error } = await client.from("pos_order_line_modifiers").select("id,order_line_id,group_name_snapshot,option_name_snapshot,price_delta_kobo").in("order_line_id", ids).order("created_at").order("id").range(from, to);
      return { data: (data ?? []) as LineModifier[], error };
    }),
    loadRowsForIds<Receipt>(tenders.map((tender) => tender.id), async (ids, from, to) => {
      const { data, error } = await client.from("pos_order_receipts").select("id,payment_id,receipt_number,order_number_snapshot,outlet_name_snapshot,department_code_snapshot,payment_method_name_snapshot,amount_kobo,reference,issued_at").in("payment_id", ids).order("issued_at", { ascending: false }).order("id").range(from, to);
      return { data: (data ?? []) as Receipt[], error };
    }),
  ]);
  const hotelCollections = (await Promise.all(Array.from({ length: Math.ceil(orderIds.length / 100) }, async (_, index) => {
    const { data, error } = await client.rpc("get_pos_hotel_collected_allocations", {
      target_hotel_id: hotelId, target_order_ids: orderIds.slice(index * 100, (index + 1) * 100),
    });
    if (error) throw error;
    return (data ?? []) as HotelCollection[];
  }))).flat();
  return {
    date, userId,
    outlets, categories: (results[1].data ?? []) as Category[],
    items: (results[2].data ?? []) as MenuItem[], prices: (results[3].data ?? []) as Price[],
    modifierGroups: (results[4].data ?? []) as ModifierGroup[], modifierOptions: (results[5].data ?? []) as ModifierOption[],
    modifierAssignments: (results[6].data ?? []) as ModifierAssignment[], methods: (results[7].data ?? []) as Method[],
    orders, lines, lineModifiers, tenders, hotelCollections, receipts,
    shifts: (results[8].data ?? []) as Shift[], refunds, corrections,
  };
}

export function RestaurantPosPage({ outletType = "restaurant" }: { outletType?: PosOutletType }) {
  const hotel = useActiveHotel();
  const access = useAccess();
  const queryClient = useQueryClient();
  const [outletId, setOutletId] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [methodId, setMethodId] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [reference, setReference] = useState("");
  const [serviceMode, setServiceMode] = useState("dine_in");
  const [openingFloat, setOpeningFloat] = useState("0");
  const [declaredCash, setDeclaredCash] = useState("");
  const [reason, setReason] = useState("");
  const [modifierItem, setModifierItem] = useState<MenuItem | null>(null);
  const [modifierSelection, setModifierSelection] = useState<Record<string, string[]>>({});
  const [refundTender, setRefundTender] = useState<Tender | null>(null);
  const [refundMethodId, setRefundMethodId] = useState("");
  const [correctionLine, setCorrectionLine] = useState<Line | null>(null);
  const [correctionDirection, setCorrectionDirection] = useState<"increase" | "decrease">("decrease");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [voidOrderOpen, setVoidOrderOpen] = useState(false);
  const receiptRef = useRef<HTMLElement>(null);
  const departmentName = outletType === "bar" ? "Bar" : "Restaurant";
  const workspace = useQuery({ queryKey: ["restaurant-pos", outletType, hotel.data?.id], queryFn: () => loadWorkspace(hotel.data!.id, outletType), enabled: Boolean(hotel.data?.id), refetchInterval: 30_000 });
  const data = workspace.data;
  const canSell = access.roleCodes.some((role) => ["owner", "general_manager", outletType === "bar" ? "bar_staff" : "restaurant_staff"].includes(role));
  const canVerify = access.roleCodes.some((role) => ["owner", "general_manager", "accountant"].includes(role));
  const canRequestRefund = access.roleCodes.some((role) => ["owner", "general_manager", "accountant"].includes(role));
  const canRequestCorrection = canRequestRefund || canSell;
  const outlet = data?.outlets.find((record) => record.id === outletId) ?? data?.outlets[0];
  const orders = data?.orders.filter((record) => record.outlet_id === outlet?.id) ?? [];
  const selectedOrder = orders.find((record) => record.id === selectedOrderId) ?? orders.find((record) => record.status === "open") ?? orders[0];
  const lines = data?.lines.filter((line) => line.order_id === selectedOrder?.id) ?? [];
  const lineModifiers = data?.lineModifiers ?? [];
  const tenders = data?.tenders.filter((tender) => tender.order_id === selectedOrder?.id) ?? [];
  const hotelCollections = data?.hotelCollections.filter((collection) => collection.order_id === selectedOrder?.id) ?? [];
  const receipts = data?.receipts ?? [];
  const orderCorrections = data?.corrections.filter((correction) => correction.order_id === selectedOrder?.id) ?? [];
  const correctionDelta = orderCorrections.reduce((sum, correction) => sum + Number(correction.amount_delta_kobo), 0);
  const gross = lines.reduce((sum, line) => sum + Number(line.line_total_kobo), 0) + correctionDelta;
  const collected = tenders.filter((tender) => tender.status === "completed").reduce((sum, tender) => sum + Number(tender.amount_kobo), 0);
  const pending = tenders.filter((tender) => tender.status === "pending_verification").reduce((sum, tender) => sum + Number(tender.amount_kobo), 0);
  const refundsForOrder = data?.refunds.filter((refund) => refund.order_id === selectedOrder?.id) ?? [];
  const refunded = refundsForOrder.reduce((sum, refund) => sum + Number(refund.amount_kobo), 0);
  const collectedByHotel = hotelCollections.filter((collection) => collection.status === "completed").reduce((sum, collection) => sum + Number(collection.amount_kobo), 0);
  const pendingAtHotel = hotelCollections.filter((collection) => collection.status === "pending_verification").reduce((sum, collection) => sum + Number(collection.amount_kobo), 0);
  const due = Math.max(gross - (collected - refunded) - pending - collectedByHotel - pendingAtHotel, 0);
  const credit = Math.max(collected - refunded + collectedByHotel - gross, 0);
  const shift = data?.shifts.find((record) => record.outlet_id === outlet?.id);
  const currentMethod = data?.methods.find((method) => method.id === methodId);
  const activeMenu = data?.items.filter((item) => item.outlet_id === outlet?.id) ?? [];
  const activePrices = useMemo(() => {
    const result = new Map<string, number>();
    for (const price of data?.prices ?? []) if (!result.has(price.menu_item_id)) result.set(price.menu_item_id, Number(price.amount_kobo));
    return result;
  }, [data?.prices]);

  async function call(name: string, args: Record<string, unknown>, success: string) {
    if (!supabase) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const { error: rpcError } = await supabase.rpc(name, args as never);
      if (rpcError) throw rpcError;
      await queryClient.invalidateQueries({ queryKey: ["restaurant-pos", outletType, hotel.data?.id] });
      setMessage(success);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The POS action could not be completed.");
    } finally { setBusy(false); }
    return false;
  }
  function submitNewOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!outlet) return;
    const form = new FormData(event.currentTarget);
    void call("create_restaurant_pos_order", {
      target_outlet_id: outlet.id, service_mode_value: form.get("service"),
      table_reference_value: form.get("table"), guest_label_value: form.get("guest"),
    }, `${departmentName} order opened. Hotel-room revenue and folios were not changed.`).then(async (saved) => {
      if (saved) { await workspace.refetch(); }
    });
  }
  function submitVoid(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selectedOrder) return;
    const form = new FormData(event.currentTarget);
    const voidReason = String(form.get("voidReason") ?? "");
    void call("void_restaurant_pos_order", { target_order_id: selectedOrder.id, reason_value: voidReason }, "Unpaid order voided with audit reason.").then((saved) => { if (saved) setVoidOrderOpen(false); });
  }
  function addItem(item: MenuItem) {
    if (!selectedOrder || selectedOrder.status !== "open") return;
    const groups = modifierGroupsFor(item);
    if (groups.length) {
      setModifierSelection({});
      setModifierItem(item);
      return;
    }
    void addConfiguredItem(item, []);
  }
  function modifierGroupsFor(item: MenuItem) {
    if (!data) return [];
    const assigned = new Set(data.modifierAssignments.filter((assignment) => assignment.menu_item_id === item.id).map((assignment) => assignment.modifier_group_id));
    return data.modifierGroups.filter((group) => group.outlet_id === item.outlet_id && assigned.has(group.id)).sort((a, b) => a.display_order - b.display_order);
  }
  async function addConfiguredItem(item: MenuItem, selectedOptionIds: string[]) {
    if (!selectedOrder) return false;
    return call("add_restaurant_pos_order_item_with_modifiers", {
      target_order_id: selectedOrder.id, target_menu_item_id: item.id,
      item_quantity: quantity, selected_modifier_option_ids: selectedOptionIds,
    }, "Item and selected options added at their current prices.");
  }
  function toggleModifier(group: ModifierGroup, optionId: string) {
    setModifierSelection((current) => {
      const selected = current[group.id] ?? [];
      const next = selected.includes(optionId)
        ? selected.filter((id) => id !== optionId)
        : group.max_selections === 1 ? [optionId] : selected.length < group.max_selections ? [...selected, optionId] : selected;
      return { ...current, [group.id]: next };
    });
  }
  function submitConfiguredItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modifierItem) return;
    const selected = Object.values(modifierSelection).flat();
    void addConfiguredItem(modifierItem, selected).then((saved) => {
      if (saved) { setModifierItem(null); setModifierSelection({}); }
    });
  }
  function openShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!outlet) return;
    try { void call("open_pos_cashier_shift", { target_outlet_id: outlet.id, opening_float_value_kobo: nairaToKobo(openingFloat) }, `${departmentName} cash shift opened.`); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Enter a valid opening float."); }
  }
  function closeShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!shift) return;
    try { void call("close_pos_cashier_shift", { target_shift_id: shift.id, declared_cash_value_kobo: nairaToKobo(declaredCash), variance_reason_value: reason }, `${departmentName} cash shift closed and reconciled.`).then((saved) => { if (saved) { setDeclaredCash(""); setReason(""); } }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Enter a valid cash count."); }
  }
  function submitPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selectedOrder || !currentMethod) return;
    try { void call("record_restaurant_pos_payment", { target_order_id: selectedOrder.id, target_payment_method_id: currentMethod.id, payment_amount_kobo: nairaToKobo(paymentAmount), payment_reference: reference }, currentMethod.requires_verification ? "Payment recorded as pending verification; no receipt is issued yet." : `Payment recorded in the ${departmentName.toLowerCase()} outlet ledger.`).then((saved) => { if (saved) { setPaymentAmount(""); setReference(""); } }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Enter a valid payment amount."); }
  }
  function reviewPayment(tender: Tender, decision: "verify" | "reject", note: string) {
    if (note.trim().length < 3) { setError("Enter a verification note or rejection reason (at least 3 characters)."); return; }
    void call(decision === "verify" ? "verify_restaurant_pos_payment" : "reject_restaurant_pos_payment",
      decision === "verify" ? { target_payment_id: tender.id, note_value: note } : { target_payment_id: tender.id, reason_value: note },
      decision === "verify" ? `${departmentName} payment verified; internal POS record issued.` : `${departmentName} payment rejected with a reason.`);
  }
  function submitRefundRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!refundTender || !refundMethodId) return;
    const form = new FormData(event.currentTarget);
    try {
      void call("request_pos_payment_refund", {
        target_payment_id: refundTender.id,
        refund_amount_kobo: nairaToKobo(String(form.get("amount"))),
        refund_method_id: refundMethodId,
        refund_reference: String(form.get("reference") ?? ""),
        refund_reason: String(form.get("reason") ?? ""),
      }, "POS refund request sent for independent approval. No hotel payment or folio was changed.").then((saved) => {
        if (saved) { setRefundTender(null); setRefundMethodId(""); }
      });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Enter a valid refund amount."); }
  }
  function submitLineCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedOrder || !correctionLine) return;
    const form = new FormData(event.currentTarget);
    try {
      const magnitude = nairaToKobo(String(form.get("amount")));
      const delta = correctionDirection === "increase" ? magnitude : -magnitude;
      void call("request_pos_order_line_correction", {
        target_order_id: selectedOrder.id,
        target_order_line_id: correctionLine.id,
        amount_delta_value_kobo: delta,
        description_value: String(form.get("description") ?? ""),
        reason_value: String(form.get("reason") ?? ""),
      }, "Line correction submitted for independent GM approval. The original order and receipt are unchanged.").then((saved) => {
        if (saved) setCorrectionLine(null);
      });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Enter a valid correction amount."); }
  }
  function printReceipt(document: Receipt) {
    if (!receiptRef.current) return;
    printElementInIsolatedFrame({ source: receiptRef.current, title: `POS record ${document.receipt_number}`, styles: "body{font:14px Arial,sans-serif;color:#111;padding:24px}.receipt{max-width:620px;margin:auto}.muted{color:#666}.total{font-size:22px;font-weight:bold;border-top:1px solid #aaa;padding-top:12px}" });
  }

  if (hotel.isLoading || workspace.isLoading || access.isLoading) return <PageLoading />;
  if (hotel.error || workspace.error) return <PageError message={`Unable to load ${departmentName.toLowerCase()} POS. Check ${departmentName.toLowerCase()} POS access, active ${departmentName.toLowerCase()} outlets, and the latest migrations.`} />;
  if (!hotel.data || !data) return <EmptyState>{departmentName} POS is unavailable for this hotel.</EmptyState>;
  if (data.outlets.length === 0) return <EmptyState>There is no active {departmentName.toLowerCase()} outlet yet. Ask the General Manager to configure the outlet and menu first.</EmptyState>;

  const configuredGroups = modifierItem ? modifierGroupsFor(modifierItem) : [];
  const selectedModifierIds = Object.values(modifierSelection).flat();
  const modifierSelectionValid = configuredGroups.every((group) => {
    const count = modifierSelection[group.id]?.length ?? 0;
    const availableCount = data.modifierOptions.filter((option) => option.modifier_group_id === group.id).length;
    return count >= group.min_selections && count <= group.max_selections && availableCount >= group.min_selections;
  });
  const selectedModifierTotal = data.modifierOptions.filter((option) => selectedModifierIds.includes(option.id)).reduce((sum, option) => sum + Number(option.price_delta_kobo), 0);
  const modifierBasePrice = modifierItem ? activePrices.get(modifierItem.id) ?? 0 : 0;

  return <section className="max-w-7xl space-y-5">
    <header className="rounded-3xl bg-gradient-to-br from-amber-950 via-amber-900 to-orange-800 p-6 text-white shadow-sm sm:p-8">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-200">Food & beverage · {departmentName}</p>
      <div className="mt-2 flex items-start gap-3"><div className="rounded-2xl bg-white/10 p-3"><Utensils className="size-6" /></div><div><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{departmentName} POS</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-amber-50/85">Open an order, add menu items at their effective price, and record outlet tenders. Cash is tracked in a separate {departmentName.toLowerCase()} shift.</p></div></div>
    </header>
    <aside className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950"><p className="font-semibold">Separate business record</p><p className="mt-1">{departmentName} orders, collections, shifts, internal records, and reports stay in their outlet ledger. Nothing here posts to hotel-room revenue, hotel payments, or guest folios. Selecting a tender records what staff report receiving; it does not route money to, connect to, or reconcile the separate “6393” merchant/POS account. Tax is not calculated here; printed POS records are internal payment acknowledgements, not tax invoices or statutory receipts. Keep using the approved POS/tax process until the accountant confirms the account mapping and statutory rules.</p></aside>
    {message && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{message}</p>}
    {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,.8fr)]">
      <div className="space-y-5">
        <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-amber-800">Outlet · {data.date}</p><h2 className="mt-1 text-lg font-semibold">{departmentName} sales</h2></div><label className="block min-w-56 text-xs font-medium text-stone-600">{departmentName} outlet<select className={`${field} mt-1`} value={outlet?.id ?? ""} onChange={(event) => { setOutletId(event.target.value); setSelectedOrderId(""); }}>{data.outlets.map((record) => <option key={record.id} value={record.id}>{record.name} · {record.department_code}</option>)}</select></label></div>
          <p className="mt-2 text-xs text-stone-500">Department attribution is snapshotted for every new order. This workflow shows only {departmentName.toLowerCase()} outlets allowed by your account.</p>
        </section>
        {canSell && <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5"><h2 className="font-semibold">Start an order</h2><form onSubmit={submitNewOrder} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><label className="text-xs font-medium text-stone-600">Service<select name="service" value={serviceMode} onChange={(event) => setServiceMode(event.target.value)} className={`${field} mt-1`}><option value="dine_in">Dine in</option><option value="takeaway">Takeaway</option><option value="delivery">Delivery</option></select></label><label className="text-xs font-medium text-stone-600">Table (dine-in)<input name="table" required={serviceMode === "dine_in"} className={`${field} mt-1`} maxLength={30} placeholder="Table 4" /></label><label className="text-xs font-medium text-stone-600">Guest label (optional)<input name="guest" className={`${field} mt-1`} maxLength={100} placeholder="Guest or order name" /></label><FormSubmitButton className={`${primary} self-end`} disabled={busy}>New {departmentName.toLowerCase()} order</FormSubmitButton></form></section>}
        <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Menu</h2><p className="text-xs text-stone-500">Current base prices and selected options are snapshotted on each order line.</p></div><label className="text-xs text-stone-600">Quantity<input type="number" min="1" max="99" value={quantity} onChange={(event) => setQuantity(Math.max(1, Math.min(99, Number(event.target.value) || 1)))} className={`${field} mt-1 w-24`} /></label></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{activeMenu.map((item) => { const price = activePrices.get(item.id); const category = data.categories.find((record) => record.id === item.category_id); const hasModifiers = modifierGroupsFor(item).length > 0; return <article key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 p-3"><div><p className="text-xs text-stone-500">{category?.name ?? "Menu"}</p><h3 className="font-medium">{item.name}</h3><p className="text-sm font-semibold">{price ? formatNaira(price) : "No active price"}<span className="ml-1 text-xs font-normal text-stone-500">base price</span></p>{hasModifiers && <p className="mt-1 text-xs text-amber-900">Options available</p>}</div>{canSell && selectedOrder?.status === "open" && price && <button type="button" disabled={busy} onClick={() => addItem(item)} aria-label={hasModifiers ? `Choose options for ${item.name}` : `Add ${item.name}`} className="inline-flex items-center gap-1 rounded-lg bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-950 hover:bg-amber-200 disabled:opacity-50"><Plus className="size-4" />{hasModifiers ? "Choose" : "Add"}</button>}</article>; })}{activeMenu.length === 0 && <p className="text-sm text-stone-500">No active menu items are configured for this outlet.</p>}</div></section>
        <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Recent {departmentName.toLowerCase()} orders</h2><p className="text-xs text-stone-500">Order history is separated from the hotel folio and payment ledgers.</p></div><select className={`${field} max-w-sm`} value={selectedOrder?.id ?? ""} onChange={(event) => setSelectedOrderId(event.target.value)}><option value="">Select an order</option>{orders.map((record) => <option key={record.id} value={record.id}>{record.order_number} · {record.status} · {record.guest_label || record.service_mode}</option>)}</select></div></section>
        {selectedOrder && <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-amber-800">{selectedOrder.order_number} · {selectedOrder.business_date}</p><h2 className="mt-1 text-lg font-semibold">{selectedOrder.outlet_name_snapshot} <span className="text-sm font-normal text-stone-500">· {selectedOrder.department_code_snapshot}</span></h2><p className="text-sm text-stone-500">{selectedOrder.service_mode.replace("_", " ")}{selectedOrder.table_reference ? ` · ${selectedOrder.table_reference}` : ""}{selectedOrder.guest_label ? ` · ${selectedOrder.guest_label}` : ""}</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${selectedOrder.status === "settled" ? "bg-emerald-100 text-emerald-800" : selectedOrder.status === "voided" ? "bg-stone-100 text-stone-600" : "bg-amber-100 text-amber-900"}`}>{selectedOrder.status}</span></div>
          <div className="mt-4 divide-y divide-stone-100">{lines.map((line) => { const options = lineModifiers.filter((modifier) => modifier.order_line_id === line.id); const corrections = orderCorrections.filter((correction) => correction.order_line_id === line.id); const lineDelta = corrections.reduce((sum, correction) => sum + Number(correction.amount_delta_kobo), 0); return <div key={line.id} className="flex items-start justify-between gap-3 py-3 text-sm"><div><p className="font-medium">{line.quantity} × {line.item_name_snapshot}</p><p className="mt-0.5 text-xs text-stone-500">Base {formatNaira(line.base_unit_price_kobo)} per item{options.length ? ` · with ${options.length} selected ${options.length === 1 ? "option" : "options"}` : ""}</p>{options.length > 0 && <ul className="mt-1 space-y-0.5 text-xs text-stone-600">{options.map((option) => <li key={option.id}>{option.group_name_snapshot}: {option.option_name_snapshot} {option.price_delta_kobo === 0 ? "· included" : `· ${option.price_delta_kobo > 0 ? "+" : "−"}${formatNaira(Math.abs(option.price_delta_kobo))} per item`}</li>)}</ul>}{lineDelta !== 0 && <p className="mt-1 text-xs font-semibold text-amber-900">Approved corrections: {lineDelta > 0 ? "+" : "−"}{formatNaira(Math.abs(lineDelta))}</p>}{canRequestCorrection && collected > 0 && selectedOrder.status !== "voided" && <button type="button" className="mt-1 text-xs font-semibold text-amber-900 underline" onClick={() => { setCorrectionDirection("decrease"); setCorrectionLine(line); }}>Request line correction</button>}</div><b className="shrink-0">{formatNaira(line.line_total_kobo)}</b></div>; })}{lines.length === 0 && <p className="py-3 text-sm text-stone-500">Add items from the menu above.</p>}</div>
          {orderCorrections.length > 0 && <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3"><h3 className="text-xs font-semibold text-amber-950">Approved line corrections</h3><ul className="mt-2 space-y-2">{orderCorrections.map((correction) => <li key={correction.id} className="text-xs text-amber-950"><b>{correction.correction_number}</b> · {correction.line_name_snapshot} · {Number(correction.amount_delta_kobo) > 0 ? "+" : "−"}{formatNaira(Math.abs(Number(correction.amount_delta_kobo)))} · {correction.description}<span className="block text-stone-600">Reason: {correction.reason}</span></li>)}</ul></div>}
          <dl className="mt-4 grid gap-2 rounded-xl bg-stone-50 p-3 text-sm sm:grid-cols-2 lg:grid-cols-5"><div><dt className="text-stone-500">Adjusted order total</dt><dd className="font-semibold">{formatNaira(gross)}</dd></div><div><dt className="text-stone-500">Collected by outlet</dt><dd className="font-semibold">{formatNaira(collected - refunded)}</dd></div><div><dt className="text-stone-500">Collected by hotel on behalf of outlet</dt><dd className="font-semibold">{formatNaira(collectedByHotel)}</dd></div><div><dt className="text-stone-500">Still due {(pending + pendingAtHotel) > 0 && `· ${formatNaira(pending + pendingAtHotel)} pending`}</dt><dd className="font-semibold">{formatNaira(due)}</dd></div><div><dt className="text-stone-500">Customer credit</dt><dd className="font-semibold">{formatNaira(credit)}{credit > 0 && <span className="block text-xs font-normal text-stone-600">Payout needs separate refund approval</span>}</dd></div></dl>
          {hotelCollections.length > 0 && <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs"><p className="font-semibold">Exceptional hotel-side collection</p>{hotelCollections.map((collection) => <p key={collection.payment_number}>{collection.payment_number} · {formatNaira(Number(collection.amount_kobo))} · {collection.status.replaceAll("_", " ")}. This is not an outlet tender or outlet receipt.</p>)}</div>}
          {canSell && selectedOrder.status === "open" && <><form onSubmit={submitPayment} className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs font-medium text-stone-600">Payment method<select required className={`${field} mt-1`} value={methodId} onChange={(event) => setMethodId(event.target.value)}><option value="">Choose a method</option>{data.methods.map((method) => <option key={method.id} value={method.id}>{method.name}{method.requires_verification ? " · requires verification" : ""}</option>)}</select></label><label className="text-xs font-medium text-stone-600">Amount (₦)<input required className={`${field} mt-1`} type="number" min="0.01" step="0.01" max={due / 100} value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} /></label>{currentMethod?.requires_reference && <label className="text-xs font-medium text-stone-600 sm:col-span-2">Transfer/reference number<input required className={`${field} mt-1`} value={reference} onChange={(event) => setReference(event.target.value)} /></label>}<FormSubmitButton className={`${primary} sm:col-span-2`} disabled={busy || due <= 0 || !methodId}>Record {departmentName.toLowerCase()} payment</FormSubmitButton></form><p className="mt-2 text-xs leading-5 text-stone-500">Cash requires your {departmentName.toLowerCase()} cash shift to be open. Methods requiring verification remain pending and do not issue a receipt until independently reviewed.</p>{collected === 0 && pending === 0 && <button type="button" onClick={() => setVoidOrderOpen(true)} className="mt-3 rounded-xl border border-rose-300 px-3 py-2 text-sm font-semibold text-rose-800">Void unpaid order</button>}</>}
          {tenders.length > 0 && <div className="mt-4 border-t border-stone-200 pt-3"><h3 className="text-sm font-semibold">Payment and internal acknowledgement history</h3><ul className="mt-2 space-y-2">{tenders.map((tender) => { const tenderReceipt = receipts.find((record) => record.payment_id === tender.id); const tenderRefunds = (data.refunds ?? []).filter((record) => record.payment_id === tender.id); const refunded = tenderRefunds.reduce((sum, record) => sum + Number(record.amount_kobo), 0); return <li key={tender.id} className="rounded-xl bg-stone-50 p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span><b>{tender.payment_number}</b> · {tender.payment_method_name_snapshot} · {formatNaira(tender.amount_kobo)} · {tender.status.replace("_", " ")}{tender.reference && <span className="block text-xs text-stone-500">Ref: {tender.reference}</span>}{refunded > 0 && <span className="block text-xs font-semibold text-rose-800">Refunds recorded: {formatNaira(refunded)}</span>}</span><span className="flex items-center gap-2">{tenderReceipt && <button type="button" className="text-xs font-semibold text-amber-900 underline" onClick={() => setReceipt(tenderReceipt)}>View {tenderReceipt.receipt_number}</button>}{canRequestRefund && credit > 0 && tender.status === "completed" && refunded < Number(tender.amount_kobo) && <button type="button" className="text-xs font-semibold text-rose-800 underline" onClick={() => { setRefundTender(tender); setRefundMethodId(""); }}>Request refund</button>}{tender.status === "pending_verification" && canVerify && <details className="text-xs"><summary className="cursor-pointer font-semibold text-amber-900">Review</summary><div className="mt-2 space-y-2"><label className="block text-left text-xs text-stone-600">Evidence or reason<textarea name={`review-${tender.id}`} required minLength={3} maxLength={500} className={field} placeholder="Enter verification evidence or rejection reason"/></label><div className="flex gap-2"><FormSubmitButton type="button" validationScope="details" className="rounded bg-emerald-700 px-2 py-1 text-white" disabled={busy} onClick={(event) => { const note = event.currentTarget.closest("details")?.querySelector("textarea")?.value ?? ""; reviewPayment(tender, "verify", note); }}><CheckCircle2 className="inline size-3"/> Verify</FormSubmitButton><FormSubmitButton type="button" validationScope="details" className="rounded border border-rose-300 px-2 py-1 text-rose-800" disabled={busy} onClick={(event) => { const note = event.currentTarget.closest("details")?.querySelector("textarea")?.value ?? ""; reviewPayment(tender, "reject", note); }}>Reject</FormSubmitButton></div></div></details>}</span></div>{tenderRefunds.map((refund) => <p key={refund.id} className="mt-2 border-t border-stone-200 pt-2 text-xs text-stone-600"><b className="text-rose-800">{refund.refund_number}</b> · {formatNaira(refund.amount_kobo)} via {refund.payment_method_name_snapshot} · {new Date(refund.refunded_at).toLocaleString("en-NG")} · {refund.reason}{refund.reference ? ` · Ref ${refund.reference}` : ""}</p>)}</li>; })}</ul></div>}
        </section>}
      </div>
      <aside className="space-y-5">
        {canSell && <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex items-center gap-2"><WalletCards className="size-5 text-amber-900"/><h2 className="font-semibold">{departmentName} cash shift</h2></div>{shift ? <><p className="mt-2 text-sm text-stone-600"><Clock3 className="mr-1 inline size-4"/>{shift.shift_number} · opened {new Date(shift.opened_at).toLocaleTimeString("en-NG")}</p><form onSubmit={closeShift} className="mt-3 space-y-3"><label className="block text-xs font-medium text-stone-600">Declared cash count (₦)<input required type="number" min="0" step="0.01" className={`${field} mt-1`} value={declaredCash} onChange={(event) => setDeclaredCash(event.target.value)}/></label><label className="block text-xs font-medium text-stone-600">Variance reason (if needed)<textarea name="reason" className={`${field} mt-1`} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} /></label><FormSubmitButton className="rounded-xl border border-stone-300 px-4 py-2 text-sm font-semibold" disabled={busy}>Close and reconcile {departmentName.toLowerCase()} shift</FormSubmitButton></form></> : <form onSubmit={openShift} className="mt-3 space-y-3"><p className="text-sm text-stone-600">Open a separately tracked float before accepting {departmentName.toLowerCase()} cash. This shift does not join hotel front-desk cash.</p><label className="block text-xs font-medium text-stone-600">Opening float (₦)<input required type="number" min="0" step="0.01" className={`${field} mt-1`} value={openingFloat} onChange={(event) => setOpeningFloat(event.target.value)}/></label><FormSubmitButton className={primary} disabled={busy}>Open {departmentName.toLowerCase()} cash shift</FormSubmitButton></form>}</section>}
        <SalesReport hotelId={hotel.data.id} date={data.date} outletType={outletType} departmentName={departmentName}/>
      </aside>
    </div>
    {receipt && <Modal open title={`${receipt.department_code_snapshot === "bar" ? "Bar" : "Restaurant"} POS payment record`} onClose={() => setReceipt(null)}><article ref={receiptRef} className="receipt space-y-4 text-sm text-stone-900"><header className="border-b border-stone-300 pb-3"><p className="text-xl font-bold">{receipt.outlet_name_snapshot}</p><p className="muted mt-1">Department: {receipt.department_code_snapshot}</p><p className="muted">Internal POS payment acknowledgement</p></header><dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2"><dt className="muted">Record</dt><dd>{receipt.receipt_number}</dd><dt className="muted">Order</dt><dd>{receipt.order_number_snapshot}</dd><dt className="muted">Issued</dt><dd>{new Date(receipt.issued_at).toLocaleString("en-NG")}</dd><dt className="muted">Method</dt><dd>{receipt.payment_method_name_snapshot}</dd>{receipt.reference && <><dt className="muted">Reference</dt><dd>{receipt.reference}</dd></>}</dl><p className="total">Amount: {formatNaira(receipt.amount_kobo)}</p><p className="muted text-xs">Internal record only. Not a tax invoice or statutory receipt; use the approved {receipt.department_code_snapshot === "bar" ? "bar" : "restaurant"} POS document for tax reporting.</p></article><div className="mt-5 flex justify-end"><button type="button" className={primary} onClick={() => printReceipt(receipt)}><Printer className="size-4"/>Print internal record</button></div></Modal>}
    {voidOrderOpen && selectedOrder && <Modal open title={`Void unpaid ${departmentName.toLowerCase()} order`} onClose={() => { if (!busy) setVoidOrderOpen(false); }}><form onSubmit={submitVoid} className="space-y-4"><p className="text-sm text-stone-600">This order has no completed or pending payments. The order is retained as a voided record; it will not be deleted.</p><label className="block text-sm font-medium">Reason<textarea name="voidReason" required minLength={3} maxLength={500} className={`${field} mt-2`} rows={3}/></label><div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => setVoidOrderOpen(false)} className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm">Cancel</button><FormSubmitButton className="rounded-xl bg-rose-700 px-4 py-2.5 text-sm font-semibold text-white" disabled={busy}>Void order</FormSubmitButton></div></form></Modal>}
    {modifierItem && <Modal open title={`Customize ${modifierItem.name}`} onClose={() => { if (!busy) { setModifierItem(null); setModifierSelection({}); } }}><form onSubmit={submitConfiguredItem} className="space-y-4"><p className="text-sm text-stone-600">Choose the available options. Required selections are marked; prices are added per item.</p>{configuredGroups.map((group) => { const options = data.modifierOptions.filter((option) => option.modifier_group_id === group.id); const selected = modifierSelection[group.id] ?? []; return <fieldset key={group.id} className="rounded-xl border border-stone-200 p-3"><legend className="px-1 text-sm font-semibold">{group.name}<span className="ml-2 text-xs font-normal text-stone-500">{group.min_selections > 0 ? `Required · choose ${group.min_selections}${group.max_selections > group.min_selections ? `–${group.max_selections}` : ""}` : `Optional · choose up to ${group.max_selections}`}</span></legend>{options.length ? <div className="mt-1 space-y-1">{options.map((option) => <label key={option.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-stone-50"><input type="checkbox" checked={selected.includes(option.id)} disabled={!selected.includes(option.id) && selected.length >= group.max_selections} onChange={() => toggleModifier(group, option.id)} className="size-4 accent-amber-800" /><span className="flex-1">{option.name}</span><span className="text-xs text-stone-600">{option.price_delta_kobo === 0 ? "Included" : `${option.price_delta_kobo > 0 ? "+" : "−"}${formatNaira(Math.abs(option.price_delta_kobo))} / item`}</span></label>)}</div> : <p className="mt-2 text-sm text-red-700">No active options are configured for this group.</p>}</fieldset>; })}<div className="flex items-center justify-between rounded-xl bg-stone-50 p-3 text-sm"><span>Estimated line total · {quantity} item{quantity === 1 ? "" : "s"}</span><b>{formatNaira((modifierBasePrice + selectedModifierTotal) * quantity)}</b></div><div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => { setModifierItem(null); setModifierSelection({}); }} className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm">Cancel</button><FormSubmitButton type="submit" disabled={busy || !modifierSelectionValid || modifierBasePrice + selectedModifierTotal <= 0} className={primary}>{busy ? "Adding…" : "Add to order"}</FormSubmitButton></div></form></Modal>}
    {correctionLine && selectedOrder && <Modal open title={`Correct paid line · ${correctionLine.item_name_snapshot}`} onClose={() => { if (!busy) setCorrectionLine(null); }}><form onSubmit={submitLineCorrection} className="space-y-4"><p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950">The original order, line, payment, and receipt will remain unchanged. A GM must independently approve this correction. An increase becomes due; a decrease creates customer credit and does not itself issue a payout.</p><label className="block text-sm font-medium">Correction direction<select className={`${field} mt-1`} value={correctionDirection} onChange={(event) => setCorrectionDirection(event.target.value as "increase" | "decrease")}><option value="decrease">Decrease the sale amount</option><option value="increase">Increase the sale amount</option></select></label><label className="block text-sm font-medium">Amount (₦)<input name="amount" required type="number" min="0.01" step="0.01" className={`${field} mt-1`} /></label><label className="block text-sm font-medium">What line detail is being corrected?<input name="description" required minLength={3} maxLength={200} className={`${field} mt-1`} placeholder="e.g. Correct quantity from 3 to 2" /></label><label className="block text-sm font-medium">Reason<textarea name="reason" required minLength={3} maxLength={500} rows={3} className={`${field} mt-1`} placeholder="Explain why this correction is needed" /></label><div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => setCorrectionLine(null)} className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm">Cancel</button><FormSubmitButton type="submit" disabled={busy} className={primary}>{busy ? "Sending…" : "Send for GM approval"}</FormSubmitButton></div></form></Modal>}
    {refundTender && <Modal open title={`Request refund · ${refundTender.payment_number}`} onClose={() => { if (!busy) { setRefundTender(null); setRefundMethodId(""); } }}><form onSubmit={submitRefundRequest} className="space-y-4"><p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950">Refunds do not alter the original payment or receipt. The request must be approved by someone else before it can be recorded. No money is sent by this app.</p><label className="block text-sm font-medium">Amount (₦)<input name="amount" required type="number" min="0.01" step="0.01" max={Math.min(Number(refundTender.amount_kobo) - (data.refunds.filter((item) => item.payment_id === refundTender.id).reduce((sum, item) => sum + Number(item.amount_kobo), 0)), credit) / 100} className={`${field} mt-1`} /></label><p className="-mt-2 text-xs text-stone-500">Maximum based on this payment and current customer credit: {formatNaira(Math.min(Number(refundTender.amount_kobo) - (data.refunds.filter((item) => item.payment_id === refundTender.id).reduce((sum, item) => sum + Number(item.amount_kobo), 0)), credit))}.</p><label className="block text-sm font-medium">Refund method<select required value={refundMethodId} onChange={(event) => setRefundMethodId(event.target.value)} className={`${field} mt-1`}><option value="">Choose method</option>{data.methods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}</select></label><label className="block text-sm font-medium">Reference {data.methods.find((method) => method.id === refundMethodId)?.code !== "cash" && <span className="text-rose-700">· required for non-cash</span>}<input name="reference" required={Boolean(refundMethodId && data.methods.find((method) => method.id === refundMethodId)?.code !== "cash")} maxLength={120} className={`${field} mt-1`} placeholder="Bank/POS transaction reference" /></label><label className="block text-sm font-medium">Reason<textarea name="reason" required minLength={3} maxLength={500} rows={3} className={`${field} mt-1`} /></label><div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => setRefundTender(null)} className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm">Cancel</button><FormSubmitButton type="submit" disabled={busy || !refundMethodId} className={primary}>{busy ? "Sending…" : "Send for approval"}</FormSubmitButton></div></form></Modal>}
  </section>;
}

function SalesReport({ hotelId, date, outletType, departmentName }: { hotelId: string; date: string; outletType: PosOutletType; departmentName: string }) {
  const report = useQuery({ queryKey: ["restaurant-pos-daily-report", hotelId, date, outletType], queryFn: async () => {
    if (!supabase) throw new Error("Database connection is not configured.");
    const [sales, refunds] = await Promise.all([
      supabase.rpc("get_restaurant_pos_sales_report", { target_hotel_id: hotelId, from_date: date, to_date: date }),
      supabase.rpc("get_pos_refund_sales_summary", { target_hotel_id: hotelId, from_date: date, to_date: date }),
    ]);
    if (sales.error) throw sales.error;
    if (refunds.error) throw refunds.error;
    return {
      sales: (sales.data ?? []) as Array<{ outlet_id: string; outlet_name: string; department_code: string; settled_orders: number; gross_sales_kobo: number; collected_kobo: number; pending_kobo: number; open_balance_kobo: number }>,
      flows: (refunds.data ?? []) as Array<{ outlet_id: string; outlet_name: string; department_code: string; payments_received_kobo: number; refunds_kobo: number; net_collected_kobo: number }>,
    };
  }, refetchInterval: 30_000 });
  const salesRows = (report.data?.sales ?? []).filter((row) => row.department_code === outletType);
  const outletIds = new Set(salesRows.map((row) => row.outlet_id));
  const rows = [
    ...salesRows.map((row) => ({ ...row, flow: report.data?.flows.find((flow) => flow.outlet_id === row.outlet_id) })),
    ...(report.data?.flows ?? []).filter((flow) => flow.department_code === outletType && !outletIds.has(flow.outlet_id)).map((flow) => ({
      outlet_id: flow.outlet_id, outlet_name: flow.outlet_name, department_code: flow.department_code,
      settled_orders: 0, gross_sales_kobo: 0, collected_kobo: 0, pending_kobo: 0, open_balance_kobo: 0, flow,
    })),
  ];
  return <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5"><h2 className="font-semibold">{departmentName} business-day summary</h2><p className="mt-1 text-xs text-stone-500">{date} · sales by order date; payments and refunds by transaction date. Tax is not calculated.</p>{report.error ? <p role="alert" className="mt-3 text-sm text-rose-800">Unable to load {departmentName.toLowerCase()} sales summary.</p> : report.isLoading ? <p className="mt-3 text-sm text-stone-500">Loading summary…</p> : <div className="mt-3 space-y-3">{rows.map((row) => <article key={`${row.outlet_name}-${row.department_code}`} className="rounded-xl bg-stone-50 p-3"><p className="font-semibold">{row.outlet_name} <span className="text-xs font-normal text-stone-500">· {row.department_code}</span></p><dl className="mt-2 grid grid-cols-2 gap-2 text-xs"><div><dt className="text-stone-500">Gross sales</dt><dd className="font-semibold">{formatNaira(row.gross_sales_kobo)}</dd></div><div><dt className="text-stone-500">Payments received</dt><dd className="font-semibold">{formatNaira(row.flow?.payments_received_kobo ?? 0)}</dd></div><div><dt className="text-stone-500">Refunds recorded</dt><dd className="font-semibold text-rose-800">{formatNaira(row.flow?.refunds_kobo ?? 0)}</dd></div><div><dt className="text-stone-500">Net collections</dt><dd className={`font-semibold ${(row.flow?.net_collected_kobo ?? 0) < 0 ? "text-rose-800" : ""}`}>{formatNaira(row.flow?.net_collected_kobo ?? 0)}</dd></div><div><dt className="text-stone-500">Pending verification</dt><dd className="font-semibold">{formatNaira(row.pending_kobo)}</dd></div><div><dt className="text-stone-500">Open balance</dt><dd className="font-semibold">{formatNaira(row.open_balance_kobo)}</dd></div></dl></article>)}{!rows.length && <p className="text-sm text-stone-500">No {departmentName.toLowerCase()} sales or collection movements recorded for this business date.</p>}</div>}</section>;
}
