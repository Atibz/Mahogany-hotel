import { useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, CircleDollarSign, Moon, Search } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { Modal } from "@/components/shared/modal";
import {
  EmptyState,
  PageError,
  PageLoading,
} from "@/components/shared/page-state";
import { useAccess } from "@/features/auth/use-access";
import { formatNaira, nairaToKobo } from "@/lib/money";
import { FolioPaymentHistory } from "./folio-payment-history";
import {
  createFolioAdjustment,
  approveCurrentNightAudit,
  acknowledgeNightAuditException,
  closeCurrentBusinessDay,
  getBusinessDayCloseReport,
  recordFolioPayment,
  reverseFolioItem,
  runNightAudit,
  type Folio,
  type DailyCloseReport,
} from "./reception-service";
import {
  useActiveHotel,
  useBusinessDayCloseStatus,
  useCurrentNightAuditApproval,
  useFolios,
  useNightAuditExceptions,
  usePaymentMethods,
} from "./use-reception";

type Action =
  | { kind: "adjustment" }
  | { kind: "reversal"; item: Folio["items"][number] };
type AcknowledgementCode = "overdue_departures" | "unsettled_open_folios";

export function FoliosPage() {
  const hotel = useActiveHotel();
  const folios = useFolios(hotel.data?.id);
  const methods = usePaymentMethods(hotel.data?.id);
  const { roleCodes, isLoading: accessLoading } = useAccess();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("folio");
  const [amount, setAmount] = useState("");
  const [methodId, setMethodId] = useState("");
  const [reference, setReference] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [folioFilter, setFolioFilter] = useState<
    "all" | "open" | "balance" | "settled"
  >("all");
  const [acknowledgementCode, setAcknowledgementCode] =
    useState<AcknowledgementCode | null>(null);
  const [dailyCloseReport, setDailyCloseReport] = useState<{
    report: DailyCloseReport;
    is_closed: boolean;
  } | null>(null);
  const reportRef = useRef<HTMLDivElement>(null);
  const canReadNightAudit = roleCodes.some((role) =>
    ["owner", "general_manager", "accountant", "receptionist"].includes(role),
  );
  const canApproveNightAudit = roleCodes.some((role) =>
    ["owner", "general_manager", "accountant"].includes(role),
  );
  const canRunNightAudit = roleCodes.some((role) =>
    ["owner", "general_manager", "receptionist"].includes(role),
  );
  const canManageAuditExceptions = roleCodes.some((role) =>
    ["owner", "general_manager"].includes(role),
  );
  const canCloseBusinessDay = canManageAuditExceptions;
  const nightAuditExceptions = useNightAuditExceptions(
    hotel.data?.id,
    canReadNightAudit,
  );
  const closeStatus = useBusinessDayCloseStatus(
    hotel.data?.id,
    canReadNightAudit,
  );
  const auditApproval = useCurrentNightAuditApproval(
    hotel.data?.id,
    canReadNightAudit,
  );
  const canCorrectFolio = roleCodes.some((role) =>
    ["owner", "general_manager", "accountant"].includes(role),
  );
  const canRecordPayment = roleCodes.some((role) =>
    ["owner", "general_manager", "receptionist", "cashier"].includes(role),
  );
  const selected = folios.data?.find((folio) => folio.id === selectedId);
  const selectedMethod = methods.data?.find((method) => method.id === methodId);
  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["folios", hotel.data?.id] }),
      queryClient.invalidateQueries({
        queryKey: ["in-house-room-occupants", hotel.data?.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["dashboard", hotel.data?.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["night-audit-exceptions", hotel.data?.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["business-day-close-status", hotel.data?.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["night-audit-approval", hotel.data?.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["folio-payment-history", hotel.data?.id, selectedId],
      }),
    ]);
  }
  async function audit() {
    if (!hotel.data) return;
    setBusy(true);
    try {
      const count = await runNightAudit(hotel.data.id);
      await refresh();
      setMessage(
        `${count} missing room charge${count === 1 ? "" : "s"} posted through the current hotel business date.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Night audit failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function approveNightAudit() {
    if (!hotel.data) return;
    setBusy(true);
    try {
      await approveCurrentNightAudit(hotel.data.id);
      await refresh();
      setMessage("Night audit approved. A different authorized staff member must run it.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Night audit approval failed.");
    } finally {
      setBusy(false);
    }
  }
  async function acknowledgeException(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hotel.data || !acknowledgementCode) return;
    setBusy(true);
    try {
      await acknowledgeNightAuditException(
        hotel.data.id,
        acknowledgementCode,
        String(new FormData(event.currentTarget).get("reason")),
      );
      setAcknowledgementCode(null);
      await refresh();
      setMessage("Night-audit exception acknowledged and recorded.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The exception could not be acknowledged.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function closeBusinessDay() {
    if (!hotel.data || !closeStatus.data) return;
    const closingBusinessDate = closeStatus.data.business_date;
    setBusy(true);
    try {
      await closeCurrentBusinessDay(hotel.data.id);
      await refresh();
      const closedReport = await getBusinessDayCloseReport(
        hotel.data.id,
        closingBusinessDate,
      );
      if (!closedReport?.is_closed) {
        throw new Error("The immutable daily-close report is unavailable.");
      }
      setDailyCloseReport(closedReport);
      setMessage(
        `Business day ${closingBusinessDate} closed. The operating date has advanced and the immutable report is ready.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Business-day close failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function openDailyCloseReport() {
    if (!hotel.data) return;
    setBusy(true);
    try {
      const result = await getBusinessDayCloseReport(hotel.data.id);
      if (!result) throw new Error("The daily-close report is unavailable.");
      setDailyCloseReport(result);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to load the report.",
      );
    } finally {
      setBusy(false);
    }
  }
  function printDailyCloseReport() {
    const source = reportRef.current;
    if (!source) return;
    const frame = document.createElement("iframe");
    frame.style.position = "fixed";
    frame.style.width = "1px";
    frame.style.height = "1px";
    frame.style.border = "0";
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) return frame.remove();
    doc.open();
    doc.write(
      "<!doctype html><html><head><title>Daily close report</title><style>@page{margin:12mm}body{font:12px/1.4 Arial;color:#1c1917}h2{margin-top:22px;border-bottom:1px solid #d6d3d1;padding-bottom:5px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.card{border:1px solid #d6d3d1;padding:8px}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #e7e5e4;padding:6px}button{display:none}</style></head><body></body></html>",
    );
    doc.close();
    doc.body.appendChild(source.cloneNode(true));
    win.onafterprint = () => frame.remove();
    window.setTimeout(() => {
      win.focus();
      win.print();
    }, 50);
    window.setTimeout(() => frame.remove(), 60_000);
  }
  async function pay() {
    if (!selected || !methodId) return;
    setBusy(true);
    try {
      const method = methods.data?.find(
        (candidate) => candidate.id === methodId,
      );
      await recordFolioPayment({
        folioId: selected.id,
        paymentMethodId: methodId,
        amountKobo: nairaToKobo(amount),
        reference,
      });
      setAmount("");
      setReference("");
      await refresh();
      setMessage(
        method?.requires_verification
          ? "Payment recorded as pending verification. It will not reduce the folio balance or issue a receipt until finance verifies it."
          : "Payment recorded and receipt issued.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Payment failed.");
    } finally {
      setBusy(false);
    }
  }
  async function correct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !action) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      if (action.kind === "adjustment")
        await createFolioAdjustment({
          folioId: selected.id,
          amountKobo: nairaToKobo(String(form.get("amount"))),
          description: String(form.get("description")),
          reason: String(form.get("reason")),
        });
      else await reverseFolioItem(action.item.id, String(form.get("reason")));
      setAction(null);
      await refresh();
      setMessage("Correction request submitted for independent approval.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Correction request failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (
    hotel.isLoading ||
    folios.isLoading ||
    methods.isLoading ||
    accessLoading ||
    (canReadNightAudit && nightAuditExceptions.isLoading) ||
    (canReadNightAudit && closeStatus.isLoading) ||
    (canReadNightAudit && auditApproval.isLoading)
  )
    return <PageLoading />;
  if (
    hotel.error ||
    folios.error ||
    methods.error ||
    (canReadNightAudit && nightAuditExceptions.error) ||
    (canReadNightAudit && closeStatus.error) ||
    (canReadNightAudit && auditApproval.error)
  )
    return <PageError message="Unable to load folios." />;
  if (!hotel.data)
    return <EmptyState>No hotel is assigned to your staff account.</EmptyState>;

  const openFolios =
    folios.data?.filter((folio) => folio.status === "open") ?? [];
  const balanceFolios = openFolios.filter((folio) => folio.balance_kobo !== 0);
  const settledFolios =
    folios.data?.filter((folio) => folio.balance_kobo === 0) ?? [];
  const totalOutstanding = balanceFolios.reduce(
    (sum, folio) => sum + Math.max(0, folio.balance_kobo),
    0,
  );
  const visibleFolios = folios.data?.filter((folio) => {
    const query = search.trim().toLowerCase();
    const matchesSearch =
      !query ||
      `${folio.folio_number} ${folio.stays?.guests?.full_name ?? ""} ${folio.stays?.rooms?.room_number ?? ""}`
        .toLowerCase()
        .includes(query);
    const matchesFilter =
      folioFilter === "all" ||
      (folioFilter === "open" && folio.status === "open") ||
      (folioFilter === "balance" &&
        folio.status === "open" &&
        folio.balance_kobo !== 0) ||
      (folioFilter === "settled" && folio.balance_kobo === 0);
    return matchesSearch && matchesFilter;
  });

  return (
    <section className="max-w-6xl">
      <p className="text-sm font-medium text-amber-800">Reception</p>
      <h1 className="mt-1 text-3xl font-semibold">
        Guest folios{canReadNightAudit ? " and night audit" : ""}
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-stone-600">
        Review guest balances, record verified payments, and open the full
        transaction history from one workspace.
      </p>
      {message && (
        <p className="mt-4 rounded-xl bg-stone-100 p-3 text-sm" role="status">
          {message}
        </p>
      )}
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <button
          type="button"
          onClick={() => setFolioFilter("open")}
          className={`rounded-2xl border p-4 text-left shadow-sm ${folioFilter === "open" ? "border-amber-300 bg-amber-50" : "border-stone-200 bg-white"}`}
        >
          <BookOpen className="size-5 text-amber-800" />
          <p className="mt-3 text-xs text-stone-500">Open folios</p>
          <p className="mt-1 text-2xl font-semibold">{openFolios.length}</p>
        </button>
        <button
          type="button"
          onClick={() => setFolioFilter("balance")}
          className={`rounded-2xl border p-4 text-left shadow-sm ${folioFilter === "balance" ? "border-red-300 bg-red-50" : "border-stone-200 bg-white"}`}
        >
          <CircleDollarSign className="size-5 text-red-700" />
          <p className="mt-3 text-xs text-stone-500">With a balance</p>
          <p className="mt-1 text-2xl font-semibold text-red-700">
            {balanceFolios.length}
          </p>
        </button>
        <button
          type="button"
          onClick={() => setFolioFilter("settled")}
          className={`rounded-2xl border p-4 text-left shadow-sm ${folioFilter === "settled" ? "border-emerald-300 bg-emerald-50" : "border-stone-200 bg-white"}`}
        >
          <span className="text-lg font-semibold text-emerald-700">✓</span>
          <p className="mt-3 text-xs text-stone-500">Settled</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-700">
            {settledFolios.length}
          </p>
        </button>
        <article className="col-span-2 rounded-2xl border border-stone-200 bg-stone-900 p-4 text-white shadow-sm lg:col-span-1">
          <p className="text-xs text-stone-300">Outstanding charges</p>
          <p className="mt-2 text-2xl font-semibold">
            {formatNaira(totalOutstanding)}
          </p>
          <p className="mt-2 text-xs text-stone-400">Across open folios</p>
        </article>
      </div>
      {canReadNightAudit && (
        <>
          <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5">
            <div className="flex items-center gap-2">
              <Moon className="size-5 text-amber-900" />
              <h2 className="font-semibold text-amber-950">
                Night-audit review
              </h2>
            </div>
            <p className="mt-1 text-sm text-amber-950/80">
              The accountant reviews the day and approves posting; an authorized staff member then runs the audit.
              Cashier shifts, payment verification, and posting failures must be
              resolved. Overdue departures and unsettled folios require a
              reasoned Owner or GM acknowledgement.
            </p>
            <dl className="mt-4 grid gap-2 sm:grid-cols-2">
              {nightAuditExceptions.data?.map((exception) => (
                <div
                  key={exception.exception_code}
                  className="flex items-center justify-between rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm"
                >
                  <dt>{exception.exception_label}</dt>
                  <dd
                    className={
                      exception.record_count > 0
                        ? "font-semibold text-amber-900"
                        : "font-medium text-stone-500"
                    }
                  >
                    {exception.record_count}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
            <div className="max-w-xl text-sm text-stone-600">
              <p className="font-medium text-stone-900">
                Business date {auditApproval.data?.business_date}: {auditApproval.data?.posting_status ?? "posting not run"}
              </p>
              {auditApproval.data?.approval_id ? (
                <p className="mt-1">
                  Approved by {auditApproval.data.approved_by_name ?? "authorized staff"}
                  {auditApproval.data.approved_at ? ` at ${new Date(auditApproval.data.approved_at).toLocaleString()}` : ""}.
                  {auditApproval.data.executed_at
                    ? ` Run by ${auditApproval.data.executed_by_name ?? "staff"}.`
                    : " A different authorized staff member must run it."}
                </p>
              ) : auditApproval.data?.posting_status === "completed" ? (
                <p className="mt-1">Posting was already completed before the approval workflow was enabled. Review the posting report; no duplicate run is needed.</p>
              ) : (
                <p className="mt-1">Posting is held until an accountant or manager approves this business date.</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {canApproveNightAudit && !auditApproval.data?.approval_id && auditApproval.data?.posting_status !== "completed" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={approveNightAudit}
                  className="rounded-xl border border-amber-800 px-4 py-2.5 text-sm font-semibold text-amber-900 hover:bg-amber-50 disabled:opacity-60"
                >
                  Approve night audit
                </button>
              )}
              {canRunNightAudit && auditApproval.data?.approval_id && !auditApproval.data.executed_at && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={audit}
                  className="rounded-xl bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-950 disabled:opacity-60"
                >
                  Run approved night audit
                </button>
              )}
            </div>
          </div>
          {closeStatus.data && (
            <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold">Business-day close</h2>
                  <p className="mt-1 text-sm text-stone-600">
                    Business date {closeStatus.data.business_date} · Posting{" "}
                    {closeStatus.data.posting_status || "not run"}
                  </p>
                </div>
                {closeStatus.data.close_number && (
                  <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
                    Closed · {closeStatus.data.close_number}
                  </span>
                )}
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {[
                  ["Open cashier shifts", closeStatus.data.open_cashier_shifts],
                  [
                    "Payments awaiting verification",
                    closeStatus.data.pending_payment_verification,
                  ],
                ].map(([label, count]) => (
                  <div
                    key={String(label)}
                    className={`rounded-xl border p-3 text-sm ${Number(count) > 0 ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}
                  >
                    <p className="font-medium">{label}</p>
                    <p className="mt-1 text-xs">
                      {Number(count) > 0
                        ? `${count} must be resolved`
                        : "Clear"}
                    </p>
                  </div>
                ))}
                <div className="rounded-xl border border-stone-200 p-3 text-sm">
                  <p className="font-medium">
                    Overdue departures · {closeStatus.data.overdue_departures}
                  </p>
                  {canManageAuditExceptions && closeStatus.data.overdue_departures > 0 &&
                    !closeStatus.data.overdue_acknowledged && (
                      <button
                        type="button"
                        onClick={() =>
                          setAcknowledgementCode("overdue_departures")
                        }
                        className="mt-2 text-xs font-semibold text-amber-900"
                      >
                        Acknowledge with reason
                      </button>
                    )}
                  {closeStatus.data.overdue_acknowledged && (
                    <p className="mt-1 text-xs text-emerald-700">Reviewed</p>
                  )}
                </div>
                <div className="rounded-xl border border-stone-200 p-3 text-sm">
                  <p className="font-medium">
                    Unsettled folios · {closeStatus.data.unsettled_open_folios}
                  </p>
                  {canManageAuditExceptions && closeStatus.data.unsettled_open_folios > 0 &&
                    !closeStatus.data.folios_acknowledged && (
                      <button
                        type="button"
                        onClick={() =>
                          setAcknowledgementCode("unsettled_open_folios")
                        }
                        className="mt-2 text-xs font-semibold text-amber-900"
                      >
                        Acknowledge with reason
                      </button>
                    )}
                  {closeStatus.data.folios_acknowledged && (
                    <p className="mt-1 text-xs text-emerald-700">Reviewed</p>
                  )}
                </div>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={openDailyCloseReport}
                className="mt-4 rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold hover:bg-stone-50 disabled:opacity-50"
              >
                {closeStatus.data.close_number
                  ? "View daily-close report"
                  : "Preview daily-close report"}
              </button>
              {canCloseBusinessDay && !closeStatus.data.close_number && (
                <button
                  type="button"
                  disabled={busy || !closeStatus.data.can_close}
                  onClick={closeBusinessDay}
                  className="mt-4 w-full rounded-xl bg-stone-900 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {closeStatus.data.can_close
                    ? "Close business day"
                    : "Resolve or acknowledge every item before close"}
                </button>
              )}
            </div>
          )}
        </>
      )}
      <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-stone-200 bg-white p-3 shadow-sm sm:flex-row sm:items-center">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search folios</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search folio, guest or room"
            className="w-full rounded-xl border border-stone-200 bg-stone-50 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-amber-500 focus:bg-white"
          />
        </label>
        <button
          type="button"
          onClick={() => setFolioFilter("all")}
          className={`rounded-xl px-4 py-2.5 text-sm font-semibold ${folioFilter === "all" ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100"}`}
        >
          All folios ({folios.data?.length ?? 0})
        </button>
      </div>
      <div className="mt-4 overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
        {!folios.data?.length ? (
          <EmptyState>No folios have been created yet.</EmptyState>
        ) : !visibleFolios?.length ? (
          <EmptyState>No folios match this view.</EmptyState>
        ) : (
          visibleFolios.map((folio) => (
            <button
              type="button"
              key={folio.id}
              onClick={() =>
                setSearchParams({ folio: folio.id }, { replace: true })
              }
              className={`flex w-full items-center justify-between gap-4 border-b border-stone-100 px-5 py-4 text-left transition last:border-b-0 hover:bg-amber-50/50 ${selectedId === folio.id ? "bg-amber-50 ring-1 ring-inset ring-amber-200" : "bg-white"}`}
            >
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <b>{folio.folio_number}</b>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${folio.status === "open" ? "bg-amber-100 text-amber-900" : "bg-stone-100 text-stone-600"}`}
                  >
                    {folio.status}
                  </span>
                </span>
                <span className="mt-1 block truncate text-sm text-stone-500">
                  {folio.stays?.guests?.full_name || "Guest"} · Room{" "}
                  {folio.stays?.rooms?.room_number || "—"}
                </span>
              </span>
              <span
                className={`shrink-0 font-semibold ${folio.balance_kobo > 0 ? "text-red-700" : folio.balance_kobo < 0 ? "text-sky-700" : "text-emerald-700"}`}
              >
                {formatNaira(folio.balance_kobo)}
              </span>
            </button>
          ))
        )}
      </div>
      {selected && (
        <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">{selected.folio_number}</h2>
              <p
                className={`mt-1 text-sm font-medium ${selected.balance_kobo > 0 ? "text-red-700" : selected.balance_kobo < 0 ? "text-sky-700" : "text-emerald-700"}`}
              >
                {selected.balance_kobo > 0
                  ? `Balance due: ${formatNaira(selected.balance_kobo)}`
                  : selected.balance_kobo < 0
                    ? `Guest credit: ${formatNaira(Math.abs(selected.balance_kobo))}`
                    : "Folio settled"}
              </p>
            </div>
            {selected.status === "open" && canCorrectFolio && (
              <button
                type="button"
                onClick={() => setAction({ kind: "adjustment" })}
                className="rounded-xl border border-stone-300 px-3 py-2 text-xs font-semibold hover:bg-stone-50"
              >
                Add adjustment
              </button>
            )}
          </div>
          <h3 className="mt-6 font-semibold">Charges</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b text-stone-500">
                  <th className="py-2">Description</th>
                  <th>Date</th>
                  <th>Total</th>
                  {canCorrectFolio && <th>Action</th>}
                </tr>
              </thead>
              <tbody>
                {selected.items.map((item) => (
                  <tr key={item.id} className="border-b">
                    <td className="py-2">{item.description}</td>
                    <td>{item.service_date || "—"}</td>
                    <td>{formatNaira(item.total_amount_kobo)}</td>
                    {canCorrectFolio && (
                      <td>
                        {selected.status === "open" &&
                          item.status === "posted" && (
                            <button
                              type="button"
                              onClick={() =>
                                setAction({ kind: "reversal", item })
                              }
                              className="text-xs font-semibold text-red-700"
                            >
                              Reverse
                            </button>
                          )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selected.status === "open" && canRecordPayment && (
            <div className="mt-6 rounded-2xl border border-stone-200 bg-stone-50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold">Record payment</h3>
                  <p className="mt-1 text-xs text-stone-500">
                    A receipt is issued only after the payment is completed or
                    verified.
                  </p>
                </div>
                {selected.balance_kobo > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setAmount((selected.balance_kobo / 100).toFixed(2))
                    }
                    className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold hover:border-amber-500"
                  >
                    Use full balance
                  </button>
                )}
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {canRecordPayment && (
                  <>
                    <input
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      type="number"
                      step="0.01"
                      min="0.01"
                      placeholder="Amount (₦)"
                      className="rounded-xl border border-stone-300 bg-white px-3 py-2.5"
                    />
                    <select
                      value={methodId}
                      onChange={(event) => setMethodId(event.target.value)}
                      className="rounded-xl border border-stone-300 bg-white px-3 py-2.5"
                    >
                      <option value="">Payment method</option>
                      {methods.data?.map((method) => (
                        <option key={method.id} value={method.id}>
                          {method.name}
                          {method.requires_verification
                            ? " — verification required"
                            : ""}
                        </option>
                      ))}
                    </select>
                    <input
                      value={reference}
                      onChange={(event) => setReference(event.target.value)}
                      placeholder={
                        selectedMethod?.requires_reference
                          ? "Reference (required)"
                          : "Reference (optional)"
                      }
                      className="rounded-xl border border-stone-300 bg-white px-3 py-2.5"
                    />
                    <button
                      type="button"
                      disabled={
                        busy ||
                        !amount ||
                        !methodId ||
                        (selectedMethod?.requires_reference &&
                          !reference.trim())
                      }
                      onClick={pay}
                      className="rounded-xl bg-amber-900 px-3 py-2.5 text-sm font-semibold text-white hover:bg-amber-950 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Record payment
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          <FolioPaymentHistory folioId={selected.id} onChanged={refresh} />
        </div>
      )}
      <Modal
        open={Boolean(dailyCloseReport)}
        title={
          dailyCloseReport?.is_closed
            ? "Daily-close report"
            : "Daily-close report preview"
        }
        onClose={() => setDailyCloseReport(null)}
        size="wide"
      >
        {dailyCloseReport && (
          <div ref={reportRef} className="space-y-5 text-sm">
            <header className="border-b border-stone-300 pb-4">
              <h1 className="text-xl font-bold">
                {dailyCloseReport.report.hotel.trading_name}
              </h1>
              <p className="mt-1 font-semibold">DAILY BUSINESS-DAY CLOSE</p>
              <p className="mt-2 text-stone-600">
                Business date: {dailyCloseReport.report.business_date}
                {dailyCloseReport.report.close_number
                  ? ` · ${dailyCloseReport.report.close_number}`
                  : " · PREVIEW — NOT CLOSED"}
              </p>
              {dailyCloseReport.report.closed_at && (
                <p className="mt-1 text-xs text-stone-500">
                  Closed by{" "}
                  {dailyCloseReport.report.closed_by_name || "Manager"} at{" "}
                  {new Date(dailyCloseReport.report.closed_at).toLocaleString(
                    "en-NG",
                  )}
                </p>
              )}
            </header>
            <section>
              <h2 className="font-semibold">Operations</h2>
              <div className="grid mt-2 grid-cols-2 gap-2 sm:grid-cols-3">
                {Object.entries(dailyCloseReport.report.operations).map(
                  ([label, value]) => (
                    <div
                      key={label}
                      className="card rounded-lg bg-stone-50 p-3"
                    >
                      <p className="text-xs capitalize text-stone-500">
                        {label.replaceAll("_", " ")}
                      </p>
                      <p className="mt-1 text-lg font-semibold">{value}</p>
                    </div>
                  ),
                )}
              </div>
            </section>
            <section>
              <h2 className="font-semibold">Revenue by department</h2>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left">
                  <thead>
                    <tr>
                      <th>Department</th>
                      <th>Items</th>
                      <th>Net</th>
                      <th>Tax</th>
                      <th>Service</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailyCloseReport.report.revenue_by_department.map(
                      (row) => (
                        <tr key={row.department_code}>
                          <td>{row.department_code}</td>
                          <td>{row.item_count}</td>
                          <td>{formatNaira(row.base_amount_kobo)}</td>
                          <td>{formatNaira(row.tax_amount_kobo)}</td>
                          <td>{formatNaira(row.service_charge_amount_kobo)}</td>
                          <td>{formatNaira(row.total_amount_kobo)}</td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            </section>
            <section>
              <h2 className="font-semibold">Tax breakdown</h2>
              {dailyCloseReport.report.tax_breakdown.length ? (
                <table className="mt-2 w-full text-left">
                  <thead>
                    <tr>
                      <th>Tax</th>
                      <th>Jurisdiction</th>
                      <th>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailyCloseReport.report.tax_breakdown.map((row) => (
                      <tr key={`${row.tax_code}-${row.jurisdiction}`}>
                        <td>
                          {row.tax_name} ({row.tax_code})
                        </td>
                        <td>{row.jurisdiction || "—"}</td>
                        <td>{formatNaira(row.amount_kobo)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="mt-2 text-stone-500">No tax posted.</p>
              )}
            </section>
            <section>
              <h2 className="font-semibold">Payments by method</h2>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[500px] text-left">
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Settled</th>
                      <th>Refunded</th>
                      <th>Voided</th>
                      <th>Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailyCloseReport.report.payments_by_method.map((row) => (
                      <tr key={row.payment_method_name}>
                        <td>{row.payment_method_name}</td>
                        <td>{formatNaira(row.settled_kobo)}</td>
                        <td>{formatNaira(row.refunded_kobo)}</td>
                        <td>{formatNaira(row.voided_kobo)}</td>
                        <td>{formatNaira(row.net_collected_kobo)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section>
              <h2 className="font-semibold">Cashier shifts</h2>
              {dailyCloseReport.report.cashier_shifts.length ? (
                dailyCloseReport.report.cashier_shifts.map((row) => (
                  <p
                    key={row.shift_number}
                    className="mt-2 rounded-lg bg-stone-50 p-3"
                  >
                    {row.shift_number} · Expected{" "}
                    {formatNaira(row.expected_cash_kobo ?? 0)} · Declared{" "}
                    {formatNaira(row.declared_cash_kobo ?? 0)} · Variance{" "}
                    {formatNaira(row.variance_kobo ?? 0)}
                  </p>
                ))
              ) : (
                <p className="mt-2 text-stone-500">No cashier shifts.</p>
              )}
            </section>
            <section>
              <h2 className="font-semibold">
                Outstanding folios and liabilities
              </h2>
              {dailyCloseReport.report.outstanding_folios.map((row) => (
                <p
                  key={row.folio_number}
                  className="mt-2 flex justify-between border-b border-stone-100 py-1"
                >
                  <span>{row.folio_number}</span>
                  <b>{formatNaira(row.balance_kobo)}</b>
                </p>
              ))}
              {dailyCloseReport.report.liabilities.map((row) => (
                <p
                  key={`${row.liability_type}-${row.document_number}`}
                  className="mt-2 flex justify-between gap-4 border-b border-stone-100 py-1"
                >
                  <span>
                    {row.document_number} · {row.guest_name} ·{" "}
                    {row.liability_status}
                  </span>
                  <b>{formatNaira(row.amount_kobo)}</b>
                </p>
              ))}
              {!dailyCloseReport.report.outstanding_folios.length &&
                !dailyCloseReport.report.liabilities.length && (
                  <p className="mt-2 text-stone-500">
                    No outstanding balances or liabilities.
                  </p>
                )}
            </section>
            <section>
              <h2 className="font-semibold">
                Corrections and acknowledged exceptions
              </h2>
              {dailyCloseReport.report.corrections.map((row, index) => (
                <p
                  key={`${row.item_type}-${index}`}
                  className="mt-2 rounded-lg bg-stone-50 p-3"
                >
                  <span className="font-medium capitalize">
                    {row.item_type}
                  </span>{" "}
                  · {row.description} · {formatNaira(row.amount_kobo)}
                  {row.reason ? ` · ${row.reason}` : ""}
                </p>
              ))}
              {!dailyCloseReport.report.corrections.length && (
                <p className="mt-2 text-stone-500">
                  No adjustments or reversals.
                </p>
              )}
              {dailyCloseReport.report.acknowledgements.map((row) => (
                <div
                  key={row.exception_code}
                  className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3"
                >
                  <p className="font-medium capitalize">
                    {row.exception_code.replaceAll("_", " ")} ·{" "}
                    {row.record_count}
                  </p>
                  <p className="mt-1">{row.reason}</p>
                  <p className="mt-1 text-xs text-stone-500">
                    {row.acknowledged_by_name || "Manager"} ·{" "}
                    {new Date(row.acknowledged_at).toLocaleString("en-NG")}
                  </p>
                </div>
              ))}
            </section>
            <button
              type="button"
              onClick={printDailyCloseReport}
              className="rounded-xl bg-amber-900 px-4 py-2.5 font-semibold text-white"
            >
              Print / Save as PDF
            </button>
          </div>
        )}
      </Modal>
      <Modal
        open={Boolean(acknowledgementCode)}
        title="Acknowledge night-audit exception"
        onClose={() => !busy && setAcknowledgementCode(null)}
      >
        {acknowledgementCode && (
          <form onSubmit={acknowledgeException} className="grid gap-4">
            <p className="text-sm text-stone-600">
              This does not remove or resolve the exception. Your name, the
              current record count, reason, and time will remain in the daily
              close audit trail.
            </p>
            <textarea
              required
              name="reason"
              rows={4}
              placeholder="Explain why the hotel may close with this exception"
              className="rounded-xl border border-stone-300 px-3 py-2.5"
            />
            <button
              disabled={busy}
              className="rounded-xl bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              Confirm acknowledgement
            </button>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(action)}
        title={
          action?.kind === "adjustment"
            ? "Add folio adjustment"
            : "Reverse charge"
        }
        onClose={() => setAction(null)}
      >
        {action && (
          <form onSubmit={correct} className="grid gap-3">
            {action.kind === "adjustment" && (
              <>
                <input
                  required
                  name="amount"
                  type="number"
                  step="0.01"
                  placeholder="Amount: positive charge, negative credit (₦)"
                  className="rounded border px-3 py-2.5"
                />
                <input
                  required
                  name="description"
                  placeholder="Adjustment description"
                  className="rounded border px-3 py-2.5"
                />
              </>
            )}
            <textarea
              required
              name="reason"
              rows={3}
              placeholder="Reason"
              className="rounded border px-3 py-2.5"
            />
            <button
              disabled={busy}
              className="rounded bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white"
            >
              Confirm
            </button>
          </form>
        )}
      </Modal>
    </section>
  );
}
