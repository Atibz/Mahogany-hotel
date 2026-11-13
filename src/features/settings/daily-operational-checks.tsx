import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { FormSubmitButton } from "@/components/shared/form-submit-button";
import { useActionMessage } from "@/components/shared/action-feedback";
import { useAuth } from "@/features/auth/auth-provider";
import { useAccess } from "@/features/auth/use-access";
import { supabase } from "@/lib/supabase/client";

type Room = { id: string; name: string; expected_occupied: boolean };
type Stock = { item_id: string; item_name: string; unit: string; location_id: string; location_name: string; expected_quantity: number };
type Check = {
  id: string; kind: "room" | "stock"; room_id: string | null; item_id: string | null; location_id: string | null;
  expected_occupied: boolean | null; observed_occupied: boolean | null;
  expected_quantity: number | null; observed_quantity: number | null;
  evidence_note: string; submitted_by: string; submitted_at: string;
  review_status: "pending" | "confirmed" | "disputed"; review_note: string | null;
};
type Report = { business_date: string; current_business_date: string; rooms: Room[]; stock: Stock[]; checks: Check[] };
const field = "mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

export function DailyOperationalChecks({ hotelId, mode = "all" }: { hotelId: string; mode?: "all" | "stock" }) {
  const access = useAccess();
  const { session } = useAuth();
  const cache = useQueryClient();
  const [kind, setKind] = useState<"room" | "stock">(mode === "stock" ? "stock" : "room");
  const [selectedDate, setSelectedDate] = useState("");
  const [target, setTarget] = useState("");
  const [observed, setObserved] = useState("");
  const [note, setNote] = useState("");
  const [reviewNote, setReviewNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useActionMessage<{ message: string; error: boolean } | null>(null);
  const report = useQuery({
    queryKey: ["daily-operational-checks", hotelId, selectedDate], refetchInterval: 30_000,
    queryFn: async () => {
      if (!supabase) throw new Error("Supabase is not configured.");
      const { data, error } = await supabase.rpc("get_daily_operational_spot_checks", { target_hotel_id: hotelId, date_value: selectedDate || null });
      if (error) throw error;
      return data as Report;
    },
  });
  const roomTargets = report.data?.rooms ?? [];
  const stockTargets = report.data?.stock ?? [];
  const checks = (report.data?.checks ?? []).filter((check) => mode === "all" || check.kind === "stock");
  const pending = checks.filter((check) => check.review_status === "pending");
  const differences = checks.filter((check) => check.kind === "room"
    ? check.expected_occupied !== check.observed_occupied
    : Number(check.expected_quantity) !== Number(check.observed_quantity));
  const checkedRoomIds = new Set(checks.filter((check) => check.kind === "room").map((check) => check.room_id));
  const canSubmitRoom = access.roleCodes.some((role) => ["accountant", "general_manager", "owner"].includes(role));
  const canSubmitStock = access.roleCodes.some((role) => ["storekeeper", "general_manager", "owner"].includes(role));
  const canReview = access.roleCodes.some((role) => ["general_manager", "owner"].includes(role));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !target || !observed || note.trim().length < 5 || busy) return;
    const stockTarget = kind === "stock" ? stockTargets.find((row) => `${row.item_id}:${row.location_id}` === target) : undefined;
    setBusy(true); setNotice(null);
    const { error } = await supabase.rpc("submit_daily_operational_spot_check", {
      target_hotel_id: hotelId, kind_value: kind,
      target_room_id: kind === "room" ? target : null,
      target_item_id: stockTarget?.item_id ?? null, target_location_id: stockTarget?.location_id ?? null,
      observed_occupied_value: kind === "room" ? observed === "occupied" : null,
      observed_quantity_value: kind === "stock" ? Number(observed) : null,
      evidence_note_value: note.trim(),
    });
    setBusy(false);
    if (error) { setNotice({ message: error.message, error: true }); return; }
    setTarget(""); setObserved(""); setNote("");
    setNotice({ message: "Physical check recorded. A different authorized person must review it.", error: false });
    await cache.invalidateQueries({ queryKey: ["daily-operational-checks", hotelId] });
  }

  async function review(id: string, decision: "confirmed" | "disputed") {
    if (!supabase || busy) return;
    setBusy(true); setNotice(null);
    const { error } = await supabase.rpc("review_daily_operational_spot_check", {
      target_check_id: id, decision_value: decision, note_value: (reviewNote[id] ?? "").trim(),
    });
    setBusy(false);
    if (error) { setNotice({ message: error.message, error: true }); return; }
    setReviewNote((current) => ({ ...current, [id]: "" }));
    setNotice({ message: `Check ${decision}. The original observation remains in history.`, error: false });
    await cache.invalidateQueries({ queryKey: ["daily-operational-checks", hotelId] });
  }

  const targetLabel = (check: Check) => check.kind === "room"
    ? `Room ${roomTargets.find((room) => room.id === check.room_id)?.name ?? check.room_id}`
    : `${stockTargets.find((stock) => stock.item_id === check.item_id && stock.location_id === check.location_id)?.item_name ?? "Stock item"} · ${stockTargets.find((stock) => stock.item_id === check.item_id && stock.location_id === check.location_id)?.location_name ?? "Location"}`;
  const differenceText = (check: Check) => check.kind === "room"
    ? `System ${check.expected_occupied ? "occupied" : "vacant"} · observed ${check.observed_occupied ? "occupied" : "vacant"}`
    : `Ledger ${check.expected_quantity} · counted ${check.observed_quantity}`;

  return <section className="space-y-4 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5" aria-label="Physical operational checks">
    <div><h2 className="text-xl font-semibold">Physical checks</h2><p className="mt-1 text-sm text-stone-600">Compare what staff physically saw with recorded room occupancy or stock quantities. These are spot checks, not a claim that every room or item was inspected. No ledger is changed automatically.</p></div>
    <label className="block max-w-xs text-sm">Business date<input className={field} type="date" value={selectedDate || report.data?.current_business_date || ""} max={report.data?.current_business_date} onChange={(event) => setSelectedDate(event.target.value)} /></label>
    {notice && <p role={notice.error ? "alert" : "status"} className={`rounded-lg p-3 text-sm ${notice.error ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-800"}`}>{notice.message}</p>}
    {report.isLoading && <p className="text-sm text-stone-500">Loading checks…</p>}
    {report.error && <p role="alert" className="text-sm text-red-800">Unable to load physical checks. Confirm that the latest migration is applied.</p>}
    {report.data && <>
      <p className={`rounded-lg p-3 text-sm ${differences.length ? "bg-red-50 text-red-900" : "bg-stone-50 text-stone-700"}`}>Business date {report.data.business_date} · {pending.length} awaiting review · {differences.length} difference{differences.length === 1 ? "" : "s"}{mode === "all" ? ` · ${checkedRoomIds.size}/${roomTargets.length} active rooms checked` : ""}</p>
      {mode === "all" && <label className="block max-w-xs text-sm">Check type<select className={field} value={kind} onChange={(event) => { setKind(event.target.value as "room" | "stock"); setTarget(""); setObserved(""); }}><option value="room">Room occupancy</option><option value="stock">Physical stock</option></select></label>}
      {report.data.business_date === report.data.current_business_date && ((kind === "room" && canSubmitRoom) || (kind === "stock" && canSubmitStock)) && <form onSubmit={(event) => void submit(event)} className="grid gap-3 rounded-xl bg-stone-50 p-4 md:grid-cols-2">
        <label className="text-sm">{kind === "room" ? "Room inspected" : "Item and location counted"}<select className={field} required value={target} onChange={(event) => setTarget(event.target.value)}><option value="">Select</option>{kind === "room" ? roomTargets.map((room) => <option key={room.id} value={room.id}>Room {room.name} · system {room.expected_occupied ? "occupied" : "vacant"}</option>) : stockTargets.map((stock) => <option key={`${stock.item_id}:${stock.location_id}`} value={`${stock.item_id}:${stock.location_id}`}>{stock.item_name} · {stock.location_name} · ledger {stock.expected_quantity} {stock.unit}</option>)}</select></label>
        <label className="text-sm">{kind === "room" ? "Physically observed" : "Physical count"}{kind === "room" ? <select className={field} required value={observed} onChange={(event) => setObserved(event.target.value)}><option value="">Select</option><option value="occupied">Occupied</option><option value="vacant">Vacant</option></select> : <input className={field} type="number" min="0" max="99999999999.999" step="0.001" required value={observed} onChange={(event) => setObserved(event.target.value)} />}</label>
        <label className="text-sm md:col-span-2">Evidence / how you checked<input className={field} minLength={5} maxLength={500} required value={note} onChange={(event) => setNote(event.target.value)} placeholder="For example: inspected with supervisor at 18:00" /></label>
        <FormSubmitButton disabled={busy || !target || !observed || note.trim().length < 5} className="rounded-lg bg-amber-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : "Record physical check"}</FormSubmitButton>
      </form>}
      {!checks.length && <p className="rounded-xl bg-stone-50 p-3 text-sm text-stone-600">No physical checks recorded for this business date.</p>}
      {checks.map((check) => { const different = check.kind === "room" ? check.expected_occupied !== check.observed_occupied : Number(check.expected_quantity) !== Number(check.observed_quantity); return <article key={check.id} className={`rounded-xl border p-3 text-sm ${different ? "border-red-200 bg-red-50" : "border-stone-200"}`}><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-semibold">{targetLabel(check)} {different && <span className="text-red-800">· discrepancy</span>}</p><p className="mt-1">{differenceText(check)}</p><p className="mt-1 text-stone-600">{check.evidence_note} · {new Date(check.submitted_at).toLocaleString("en-NG")} · submitted by staff {check.submitted_by.slice(0, 8)}</p></div><span className="rounded-full bg-white px-2 py-1 font-semibold capitalize">{check.review_status}</span></div>{check.review_note && <p className="mt-2 text-stone-700">Review: {check.review_note}</p>}{check.review_status === "pending" && canReview && check.submitted_by !== session?.user.id && <div className="mt-3 flex flex-wrap items-end gap-2"><label className="min-w-56 flex-1">Review reason<input className={field} minLength={5} maxLength={500} value={reviewNote[check.id] ?? ""} onChange={(event) => setReviewNote((current) => ({ ...current, [check.id]: event.target.value }))} /></label><button type="button" disabled={busy || (reviewNote[check.id] ?? "").trim().length < 5} onClick={() => void review(check.id, "confirmed")} className="rounded-lg border border-emerald-300 px-3 py-2 font-semibold text-emerald-900 disabled:opacity-50">Confirm</button><button type="button" disabled={busy || (reviewNote[check.id] ?? "").trim().length < 5} onClick={() => void review(check.id, "disputed")} className="rounded-lg border border-red-300 px-3 py-2 font-semibold text-red-900 disabled:opacity-50">Dispute</button></div>}</article>; })}
    </>}
  </section>;
}
