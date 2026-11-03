import { useRef, useState } from "react";
import { useActionMessage } from "@/components/shared/action-feedback";
import { useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { Modal } from "@/components/shared/modal";
import {
  EmptyState,
  PageError,
  PageLoading,
} from "@/components/shared/page-state";
import { formatNaira } from "@/lib/money";
import { printElementInIsolatedFrame } from "@/lib/print-document";

import {
  completeDepartureCheckout,
  getCheckoutInvoice,
  getDepartureQueue,
  prepareDepartureFolio,
  type CheckoutInvoice,
  type DepartureQueueItem,
} from "./reception-service";
import {
  useActiveHotel,
  useDepartureQueue,
  useFolioPaymentHistory,
  useFolios,
} from "./use-reception";

const emptyChecklist = {
  roomCharges: false,
  incidentals: false,
  keyReturned: false,
  guestDetails: false,
};

export function DeparturesPage() {
  const hotel = useActiveHotel();
  const departures = useDepartureQueue(hotel.data?.id);
  const folios = useFolios(hotel.data?.id);
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<DepartureQueueItem | null>(null);
  const payments = useFolioPaymentHistory(selected?.folio_id, hotel.data?.id);
  const [checklist, setChecklist] = useState(emptyChecklist);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useActionMessage<string | null>(null);
  const [modalMessage, setModalMessage] = useActionMessage<string | null>(null);
  const [preparedStayId, setPreparedStayId] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<CheckoutInvoice | null>(null);
  const invoiceDocumentRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [departureFilter, setDepartureFilter] = useState<
    "all" | "overdue" | "due_today" | "ready"
  >("all");

  const selectedFolio = folios.data?.find(
    (folio) => folio.id === selected?.folio_id,
  );
  const checklistComplete = Object.values(checklist).every(Boolean);

  function openDeparture(departure: DepartureQueueItem) {
    setSelected(departure);
    setChecklist(emptyChecklist);
    setNotes("");
    setMessage(null);
    setModalMessage(null);
    setPreparedStayId(null);
    void prepareFolio(departure);
  }

  async function prepareFolio(departure: DepartureQueueItem) {
    setBusy(true);
    setModalMessage(null);
    try {
      const balance = await prepareDepartureFolio(departure.stay_id);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["departure-queue", hotel.data?.id],
        }),
        queryClient.invalidateQueries({ queryKey: ["folios", hotel.data?.id] }),
        queryClient.invalidateQueries({
          queryKey: ["in-house-room-occupants", hotel.data?.id],
        }),
      ]);
      const refreshed = await queryClient.fetchQuery({
        queryKey: ["departure-queue", hotel.data?.id],
        queryFn: () => getDepartureQueue(hotel.data!.id),
      });
      const refreshedDeparture = refreshed.find(
        (item) => item.stay_id === departure.stay_id,
      );
      if (refreshedDeparture) setSelected(refreshedDeparture);
      setPreparedStayId(departure.stay_id);
      setModalMessage(
        balance === 0
          ? "Final room charges are prepared and the folio is settled. Complete the checklist to check out."
          : `Final room charges are prepared. Resolve the ${formatNaira(Math.abs(balance))} ${balance > 0 ? "balance due" : "guest credit"} before checkout.`,
      );
    } catch (error) {
      setModalMessage(
        error instanceof Error
          ? error.message
          : "The final folio could not be prepared.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function completeCheckout() {
    if (!selected || !checklistComplete || !selected.ready_to_checkout) return;
    setBusy(true);
    setMessage(null);
    setModalMessage(null);
    try {
      const invoiceId = await completeDepartureCheckout({
        stayId: selected.stay_id,
        roomChargesConfirmed: checklist.roomCharges,
        incidentalChargesConfirmed: checklist.incidentals,
        keyReturnConfirmed: checklist.keyReturned,
        guestDetailsConfirmed: checklist.guestDetails,
        notes,
      });
      const issuedInvoice = await getCheckoutInvoice(invoiceId);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["departure-queue", hotel.data?.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["in-house-room-occupants", hotel.data?.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["folios", hotel.data?.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["room-board", hotel.data?.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["dashboard", hotel.data?.id],
        }),
      ]);
      setSelected(null);
      setInvoice(issuedInvoice);
      setMessage("Checkout completed and final invoice issued.");
    } catch (error) {
      setModalMessage(
        error instanceof Error ? error.message : "Checkout failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  function printInvoice() {
    const source = invoiceDocumentRef.current;
    if (!source) return;
    const opened = printElementInIsolatedFrame({
      source,
      title: invoice?.invoice_number
        ? `Invoice ${invoice.invoice_number}`
        : "Hotel invoice",
      removeSelector: "[data-invoice-print-action]",
      styles: `
        @page { margin: 14mm; }
        * { box-sizing: border-box; }
        body { margin: 0; color: #1c1917; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
        .invoice-document { max-width: 720px; margin: 0 auto; }
        .invoice-document > div { margin-bottom: 16px; }
        .invoice-document > div:first-child { border-bottom: 1px solid #d6d3d1; padding-bottom: 16px; text-align: center; }
        .invoice-document .invoice-logo { display: block; width: 220px; height: auto; margin: 0 auto 4px; }
        .invoice-document h2 { margin: 0; font-size: 22px; }
        .invoice-document p { margin: 5px 0; }
        .invoice-document > div:nth-of-type(2) { border: 1px solid #d6d3d1; border-radius: 6px; }
        .invoice-document > div:nth-of-type(2) > div { display: flex; justify-content: space-between; gap: 16px; padding: 10px; border-bottom: 1px solid #e7e5e4; }
        .invoice-document > div:nth-of-type(2) > div:last-child { border-bottom: 0; }
        .invoice-document > div:nth-of-type(3) { display: flex; justify-content: space-between; gap: 16px; padding: 12px; background: #f5f5f4; font-weight: 700; }
      `,
    });
    if (!opened) setMessage("The invoice print view could not be opened.");
  }

  if (hotel.isLoading || departures.isLoading || folios.isLoading)
    return <PageLoading />;
  if (hotel.error || departures.error || folios.error)
    return <PageError message="Unable to load the departure queue." />;
  if (!hotel.data)
    return <EmptyState>No hotel is assigned to your staff account.</EmptyState>;

  const overdue = departures.data?.filter(
    (item) => item.departure_state === "overdue",
  ).length;
  const dueToday = departures.data?.filter(
    (item) => item.departure_state === "due_today",
  ).length;
  const ready = departures.data?.filter(
    (item) => item.ready_to_checkout,
  ).length;
  const visibleDepartures = departures.data?.filter((item) => {
    const query = search.trim().toLowerCase();
    const matchesSearch =
      !query ||
      `${item.guest_name} ${item.room_number} ${item.room_type_name} ${item.folio_number}`
        .toLowerCase()
        .includes(query);
    const matchesFilter =
      departureFilter === "all" ||
      (departureFilter === "ready" && item.ready_to_checkout) ||
      item.departure_state === departureFilter;
    return matchesSearch && matchesFilter;
  });

  return (
    <section className="max-w-6xl">
      <p className="text-sm font-medium text-amber-800">Front desk</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">
        Departures and checkout
      </h1>
      <p className="mt-2 text-sm text-stone-600">
        Review the final account, resolve every blocker, and complete the
        departure checklist before releasing a room.
      </p>
      {message && (
        <p className="mt-4 rounded-lg bg-stone-100 p-3 text-sm" role="status">
          {message}
        </p>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => setDepartureFilter("overdue")}
          className={`rounded-2xl border p-4 text-left shadow-sm ${departureFilter === "overdue" ? "border-red-300 bg-red-50" : "border-stone-200 bg-white"}`}
        >
          <p className="text-xs text-stone-500">Overdue</p>
          <p className="mt-1 text-2xl font-semibold text-red-700">{overdue}</p>
        </button>
        <button
          type="button"
          onClick={() => setDepartureFilter("due_today")}
          className={`rounded-2xl border p-4 text-left shadow-sm ${departureFilter === "due_today" ? "border-amber-300 bg-amber-50" : "border-stone-200 bg-white"}`}
        >
          <p className="text-xs text-stone-500">Due today</p>
          <p className="mt-1 text-2xl font-semibold text-amber-800">
            {dueToday}
          </p>
        </button>
        <button
          type="button"
          onClick={() => setDepartureFilter("ready")}
          className={`col-span-2 rounded-2xl border p-4 text-left shadow-sm sm:col-span-1 ${departureFilter === "ready" ? "border-emerald-300 bg-emerald-50" : "border-stone-200 bg-white"}`}
        >
          <p className="text-xs text-stone-500">Ready now</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-700">
            {ready}
          </p>
        </button>
      </div>

      <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-stone-200 bg-white p-3 shadow-sm sm:flex-row sm:items-center">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search departures</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search guest, room or folio"
            className="w-full rounded-xl border border-stone-200 bg-stone-50 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-amber-500 focus:bg-white"
          />
        </label>
        <button
          type="button"
          onClick={() => setDepartureFilter("all")}
          className={`rounded-xl px-4 py-2.5 text-sm font-semibold ${departureFilter === "all" ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100"}`}
        >
          All departures ({departures.data?.length ?? 0})
        </button>
      </div>

      <div className="mt-4 space-y-3">
        {!departures.data?.length ? (
          <EmptyState>No guests are currently checked in.</EmptyState>
        ) : !visibleDepartures?.length ? (
          <EmptyState>No departures match this view.</EmptyState>
        ) : (
          visibleDepartures.map((item) => (
            <button
              key={item.stay_id}
              type="button"
              onClick={() => openDeparture(item)}
              className={`grid w-full gap-3 rounded-2xl border p-4 text-left shadow-sm transition hover:border-amber-500 md:grid-cols-[1.4fr_1fr_1fr_auto] md:items-center ${item.departure_state === "overdue" ? "border-red-200 bg-red-50" : "border-stone-200 bg-white"}`}
            >
              <div>
                <p className="font-semibold">
                  Room {item.room_number} · {item.guest_name}
                </p>
                <p className="mt-1 text-xs text-stone-600">
                  {item.room_type_name} · {item.folio_number}
                </p>
              </div>
              <div className="text-sm">
                <p className="text-stone-500">Expected checkout</p>
                <p className="font-medium">{item.expected_check_out_date}</p>
              </div>
              <div className="text-sm">
                <p className="text-stone-500">Folio position</p>
                <p
                  className={
                    item.balance_kobo
                      ? "font-semibold text-red-700"
                      : "font-semibold text-emerald-700"
                  }
                >
                  {item.balance_kobo > 0
                    ? `${formatNaira(item.balance_kobo)} due`
                    : item.balance_kobo < 0
                      ? `${formatNaira(Math.abs(item.balance_kobo))} credit`
                      : "Settled"}
                </p>
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${item.ready_to_checkout ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}
              >
                {item.ready_to_checkout ? "Ready" : item.blocking_reason}
              </span>
            </button>
          ))
        )}
      </div>

      <Modal
        open={Boolean(selected)}
        title={
          selected ? `Checkout · Room ${selected.room_number}` : "Checkout"
        }
        onClose={() => !busy && setSelected(null)}
      >
        {selected && (
          <div className="space-y-5">
            <section className="rounded-lg bg-stone-50 p-4">
              <p className="font-semibold">{selected.guest_name}</p>
              <p className="mt-1 text-sm text-stone-600">
                Checked in {selected.actual_check_in_date} · Scheduled checkout{" "}
                {selected.expected_check_out_date}
              </p>
              <p className="mt-1 text-sm text-stone-600">
                {selected.guest_phone || "No phone"} ·{" "}
                {selected.guest_email || "No email"}
              </p>
            </section>

            <section>
              <h3 className="font-semibold">Final folio review</h3>
              <div className="mt-2 max-h-48 overflow-auto rounded-lg border">
                {selectedFolio?.items.length ? (
                  <table className="w-full text-sm">
                    <tbody>
                      {selectedFolio.items.map((item) => (
                        <tr key={item.id} className="border-b last:border-0">
                          <td className="p-2">{item.description}</td>
                          <td className="p-2 text-stone-500">
                            {item.service_date || "—"}
                          </td>
                          <td className="p-2 text-right font-medium">
                            {formatNaira(item.total_amount_kobo)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="p-3 text-sm text-stone-600">
                    No posted charges.
                  </p>
                )}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-stone-500">Posted charges</dt>
                  <dd className="font-semibold">
                    {formatNaira(selected.posted_charge_total_kobo)}
                  </dd>
                </div>
                <div>
                  <dt className="text-stone-500">Completed payments</dt>
                  <dd className="font-semibold">
                    {formatNaira(selected.completed_payment_total_kobo)}
                  </dd>
                </div>
                <div>
                  <dt className="text-stone-500">Pending payments</dt>
                  <dd className="font-semibold">
                    {formatNaira(selected.pending_payment_total_kobo)}
                  </dd>
                </div>
                <div>
                  <dt className="text-stone-500">Final balance</dt>
                  <dd className="font-semibold">
                    {formatNaira(selected.balance_kobo)}
                  </dd>
                </div>
              </dl>
              {payments.isLoading && (
                <p className="mt-2 text-xs text-stone-500">
                  Checking payment history…
                </p>
              )}
            </section>

            {modalMessage && (
              <p
                className="rounded-lg bg-amber-50 p-3 text-sm font-medium text-amber-900"
                role="status"
              >
                {modalMessage}
              </p>
            )}

            {preparedStayId !== selected.stay_id && busy && (
              <p className="rounded-lg bg-stone-100 p-3 text-sm font-medium text-stone-700">
                Preparing final room charges for checkout…
              </p>
            )}

            {!selected.ready_to_checkout && (
              <p className="rounded-lg bg-red-50 p-3 text-sm font-semibold text-red-800">
                Checkout blocked: {selected.blocking_reason}. Resolve this from
                Folios or Payments first.
              </p>
            )}

            <fieldset
              className="space-y-2"
              disabled={
                preparedStayId !== selected.stay_id ||
                !selected.ready_to_checkout ||
                busy
              }
            >
              <legend className="font-semibold">Departure checklist</legend>
              {[
                [
                  "roomCharges",
                  "All room-night charges are present and correct",
                ],
                [
                  "incidentals",
                  "Minibar, restaurant, laundry, damages, and other incidentals are confirmed",
                ],
                ["keyReturned", "Room key or access card has been returned"],
                [
                  "guestDetails",
                  "Guest and invoice details have been confirmed",
                ],
              ].map(([key, label]) => (
                <label
                  key={key}
                  className="flex gap-3 rounded-lg border p-3 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={checklist[key as keyof typeof checklist]}
                    onChange={(event) =>
                      setChecklist((current) => ({
                        ...current,
                        [key]: event.target.checked,
                      }))
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              placeholder="Checkout notes (optional)"
              className="w-full rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <button
              type="button"
              disabled={
                busy ||
                preparedStayId !== selected.stay_id ||
                !selected.ready_to_checkout ||
                !checklistComplete
              }
              onClick={completeCheckout}
              className="w-full rounded-lg bg-amber-900 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy
                ? "Completing checkout…"
                : "Confirm checkout and issue invoice"}
            </button>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(invoice)}
        title="Final invoice"
        onClose={() => setInvoice(null)}
      >
        {invoice && (
          <div ref={invoiceDocumentRef} className="invoice-document space-y-4">
            <div className="border-b pb-4 text-center">
              <img src="/mahogany-logo.png" alt="" className="invoice-logo mx-auto mb-1 w-55 max-w-full" />
              <h2 className="text-xl font-semibold">{invoice.hotel_name}</h2>
              <p className="mt-1 font-semibold">{invoice.invoice_number}</p>
              <p className="text-xs text-stone-500">
                Issued {new Date(invoice.issued_at).toLocaleString()}
              </p>
            </div>
            <p className="text-sm">
              Folio: <b>{invoice.snapshot.folio_number}</b>
            </p>
            <p className="text-sm">
              Checkout date: <b>{invoice.snapshot.checkout_date}</b>
            </p>
            <div className="rounded-lg border">
              {invoice.snapshot.charges.map((charge) => (
                <div
                  key={charge.id}
                  className="flex justify-between gap-3 border-b p-3 text-sm last:border-0"
                >
                  <span>{charge.description}</span>
                  <b>{formatNaira(charge.total_amount_kobo)}</b>
                </div>
              ))}
            </div>
            <div className="flex justify-between rounded-lg bg-stone-100 p-4 font-semibold">
              <span>Final balance</span>
              <span>{formatNaira(invoice.snapshot.final_balance_kobo)}</span>
            </div>
            <button
              type="button"
              onClick={printInvoice}
              data-invoice-print-action
              className="w-full rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white"
            >
              Print invoice
            </button>
          </div>
        )}
      </Modal>
    </section>
  );
}
