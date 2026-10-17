import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  BadgeDollarSign,
  CircleCheckBig,
  Clock3,
  Download,
  WalletCards,
} from "lucide-react";

import { Modal } from "@/components/shared/modal";
import {
  EmptyState,
  PageError,
  PageLoading,
} from "@/components/shared/page-state";
import { useAccess } from "@/features/auth/use-access";
import { formatNaira, nairaToKobo } from "@/lib/money";

import {
  closeCashierShift,
  createPaymentMethod,
  decideFinanceApproval,
  executeFinanceApproval,
  openCashierShift,
  rejectPendingPayment,
  reviewCashierShift,
  updatePaymentMethod,
  verifyPendingPayment,
  type CashierShiftHistory,
  type DailyRevenueTaxReport,
  type DepositGuestCreditLiability,
  type FinanceApprovalRequest,
  type PaymentMethod,
  type PendingPaymentVerification,
} from "./reception-service";
import { FolioPaymentHistory } from "./folio-payment-history";
import {
  useActiveHotel,
  useAllPaymentMethods,
  useCashierShiftHistory,
  useCurrentCashierShift,
  useDailyPaymentReconciliation,
  useDailyRevenueTaxReport,
  useDepositGuestCreditLiabilities,
  useFinanceApprovalRegister,
  useFinanceApprovalRequests,
  useFolios,
  usePendingPaymentVerifications,
} from "./use-reception";

type VerificationAction = {
  kind: "verify" | "reject";
  payment: PendingPaymentVerification;
};
type PaymentMethodAction =
  | { kind: "create" }
  | { kind: "edit"; paymentMethod: PaymentMethod };
type FinanceDecisionAction = {
  request: FinanceApprovalRequest;
  approve: boolean;
};
type FinanceView =
  | "overview"
  | "reports"
  | "approvals"
  | "cashier"
  | "receipts"
  | "settings";

function downloadCsv(
  filename: string,
  rows: Array<Array<string | number | null>>,
) {
  const content = rows
    .map((row) =>
      row
        .map((value) => {
          let text = value === null ? "" : String(value);
          if (/^[=+\-@]/.test(text)) text = `'${text}`;
          return `"${text.replaceAll('"', '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
  const url = URL.createObjectURL(
    new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function DailyRevenueTaxSection({
  report,
}: {
  report: DailyRevenueTaxReport | undefined;
}) {
  const departments = report?.departments ?? [];
  const taxes = report?.taxes ?? [];
  const totals = departments.reduce(
    (sum, row) => ({
      base: sum.base + row.base_amount_kobo,
      tax: sum.tax + row.tax_amount_kobo,
      serviceCharge: sum.serviceCharge + row.service_charge_amount_kobo,
      total: sum.total + row.total_amount_kobo,
    }),
    { base: 0, tax: 0, serviceCharge: 0, total: 0 },
  );
  const snapshotTax = taxes.reduce((sum, row) => sum + row.amount_kobo, 0);
  const reportDate = departments[0]?.report_date ?? taxes[0]?.report_date;

  return (
    <section className="mt-6 rounded-xl border bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">Posted revenue and tax</h2>
          <p className="mt-1 text-sm text-stone-600">
            Charges use their service date; adjustments and reversals use the
            date they were posted. Payments are reported separately above.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {reportDate && (
            <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-600">
              Business date {reportDate}
            </span>
          )}
          <button
            type="button"
            disabled={!departments.length && !taxes.length}
            onClick={() =>
              downloadCsv(`revenue-tax-${reportDate || "current"}.csv`, [
                [
                  "Record type",
                  "Business date",
                  "Code",
                  "Name / department",
                  "Jurisdiction",
                  "Item count",
                  "Base amount (kobo)",
                  "Tax amount (kobo)",
                  "Service charge (kobo)",
                  "Total amount (kobo)",
                ],
                ...departments.map((row) => [
                  "department",
                  row.report_date,
                  row.department_code,
                  row.department_code,
                  "",
                  row.item_count,
                  row.base_amount_kobo,
                  row.tax_amount_kobo,
                  row.service_charge_amount_kobo,
                  row.total_amount_kobo,
                ]),
                ...taxes.map((row) => [
                  "tax",
                  row.report_date,
                  row.tax_code,
                  row.tax_name,
                  row.jurisdiction,
                  "",
                  "",
                  row.amount_kobo,
                  "",
                  row.amount_kobo,
                ]),
              ])
            }
            className="inline-flex items-center gap-2 rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold disabled:opacity-50"
          >
            <Download className="size-4" /> Export CSV
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["Net charges", totals.base],
          ["Tax", totals.tax],
          ["Service charge", totals.serviceCharge],
          ["Gross posted", totals.total],
        ].map(([label, amount]) => (
          <div key={label} className="rounded-lg bg-stone-50 p-3">
            <p className="text-xs text-stone-500">{label}</p>
            <p className="mt-1 font-semibold">
              {formatNaira(amount as number)}
            </p>
          </div>
        ))}
      </div>

      {departments.length ? (
        <div className="mt-5 overflow-x-auto">
          <h3 className="text-sm font-semibold">By department</h3>
          <table className="mt-2 w-full min-w-180 text-left text-sm">
            <thead className="border-b text-stone-500">
              <tr>
                <th className="pb-2">Department</th>
                <th className="pb-2">Items</th>
                <th className="pb-2">Net charges</th>
                <th className="pb-2">Tax</th>
                <th className="pb-2">Service charge</th>
                <th className="pb-2">Gross posted</th>
              </tr>
            </thead>
            <tbody>
              {departments.map((row) => (
                <tr
                  key={row.department_code}
                  className="border-b border-stone-100"
                >
                  <td className="py-3 font-medium capitalize">
                    {row.department_code.replaceAll("_", " ")}
                  </td>
                  <td>{row.item_count}</td>
                  <td>{formatNaira(row.base_amount_kobo)}</td>
                  <td>{formatNaira(row.tax_amount_kobo)}</td>
                  <td>{formatNaira(row.service_charge_amount_kobo)}</td>
                  <td className="font-semibold">
                    {formatNaira(row.total_amount_kobo)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-4 text-sm text-stone-500">
          No revenue entries have been posted for today’s business date.
        </p>
      )}

      <div className="mt-5">
        <h3 className="text-sm font-semibold">Tax snapshot breakdown</h3>
        <p className="mt-1 text-xs text-stone-500">
          Uses the tax values stored when each charge was posted, not current
          tax settings.
        </p>
        {taxes.length ? (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-120 text-left text-sm">
              <thead className="border-b text-stone-500">
                <tr>
                  <th className="pb-2">Tax</th>
                  <th className="pb-2">Jurisdiction</th>
                  <th className="pb-2">Amount</th>
                </tr>
              </thead>
              <tbody>
                {taxes.map((row) => (
                  <tr
                    key={`${row.tax_code}-${row.jurisdiction ?? ""}`}
                    className="border-b border-stone-100"
                  >
                    <td className="py-3 font-medium">
                      {row.tax_name} ({row.tax_code})
                    </td>
                    <td>{row.jurisdiction || "—"}</td>
                    <td className="font-semibold">
                      {formatNaira(row.amount_kobo)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-stone-500">
            No tax snapshots were posted for today’s business date.
          </p>
        )}
      </div>

      {totals.tax !== snapshotTax && (
        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          Tax control warning: posted tax is {formatNaira(totals.tax)}, while
          itemized tax snapshots total {formatNaira(snapshotTax)}. Review the
          underlying folio entries before closing the day.
        </p>
      )}
    </section>
  );
}

function DepositLiabilitySection({
  liabilities,
}: {
  liabilities: DepositGuestCreditLiability[];
}) {
  const totals = liabilities.reduce(
    (sum, item) => {
      if (item.liability_status === "pending_verification")
        sum.pending += item.amount_kobo;
      else if (item.liability_status === "action_required") {
        sum.actionRequired += item.amount_kobo;
        sum.total += item.amount_kobo;
      } else if (item.liability_status === "credit_balance") {
        sum.guestCredit += item.amount_kobo;
        sum.total += item.amount_kobo;
      } else {
        sum.held += item.amount_kobo;
        sum.total += item.amount_kobo;
      }
      return sum;
    },
    { total: 0, held: 0, pending: 0, actionRequired: 0, guestCredit: 0 },
  );
  const statusLabels: Record<
    DepositGuestCreditLiability["liability_status"],
    string
  > = {
    held: "Held deposit",
    pending_verification: "Pending verification",
    action_required: "Action required",
    credit_balance: "Guest credit",
  };

  return (
    <section className="mt-6 rounded-xl border bg-white p-5">
      <h2 className="font-semibold">Deposits and guest-credit liabilities</h2>
      <p className="mt-1 text-sm text-stone-600">
        Money still owed to guests is not revenue. Cancelled and no-show
        deposits remain flagged until management records an approved outcome.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          ["Confirmed liability", totals.total],
          ["Held deposits", totals.held],
          ["Pending claims", totals.pending],
          ["Action required", totals.actionRequired],
          ["Guest credits", totals.guestCredit],
        ].map(([label, amount]) => (
          <div key={label} className="rounded-lg bg-stone-50 p-3">
            <p className="text-xs text-stone-500">{label}</p>
            <p className="mt-1 font-semibold">
              {formatNaira(amount as number)}
            </p>
          </div>
        ))}
      </div>
      {liabilities.length ? (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-220 text-left text-sm">
            <thead className="border-b text-stone-500">
              <tr>
                <th className="pb-2">Document</th>
                <th className="pb-2">Guest</th>
                <th className="pb-2">Type</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Method / reference</th>
                <th className="pb-2">Amount</th>
              </tr>
            </thead>
            <tbody>
              {liabilities.map((item) => (
                <tr
                  key={`${item.liability_type}-${item.document_number}-${item.recorded_at}`}
                  className="border-b border-stone-100"
                >
                  <td className="py-3 font-medium">{item.document_number}</td>
                  <td>{item.guest_name}</td>
                  <td className="capitalize">
                    {item.liability_type.replaceAll("_", " ")}
                  </td>
                  <td>
                    <span
                      className={
                        item.liability_status === "action_required"
                          ? "rounded-full bg-red-50 px-2 py-1 text-xs font-semibold text-red-700"
                          : item.liability_status === "pending_verification"
                            ? "rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800"
                            : "rounded-full bg-stone-100 px-2 py-1 text-xs font-semibold text-stone-700"
                      }
                    >
                      {statusLabels[item.liability_status]}
                    </span>
                    <p className="mt-1 text-xs capitalize text-stone-500">
                      {item.source_status.replaceAll("_", " ")}
                    </p>
                  </td>
                  <td>
                    {item.payment_method_name || "—"}
                    {item.reference ? (
                      <p className="mt-1 text-xs text-stone-500">
                        Ref: {item.reference}
                      </p>
                    ) : null}
                  </td>
                  <td className="font-semibold">
                    {formatNaira(item.amount_kobo)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-4 text-sm text-stone-500">
          There are no outstanding deposit or guest-credit liabilities.
        </p>
      )}
    </section>
  );
}

export function FinancialHistoryPage() {
  const hotel = useActiveHotel();
  const folios = useFolios(hotel.data?.id);
  const { roleCodes, isLoading: accessLoading } = useAccess();
  const canOperateCashierShift = roleCodes.some((role) =>
    ["owner", "general_manager", "cashier"].includes(role),
  );
  const canVerifyPayments = roleCodes.some((role) =>
    ["owner", "general_manager", "accountant"].includes(role),
  );
  const canManagePaymentMethods = roleCodes.some((role) =>
    ["owner", "general_manager"].includes(role),
  );
  const canApproveFinance = roleCodes.some((role) =>
    ["owner", "general_manager"].includes(role),
  );
  const canViewFinanceRequests = roleCodes.some((role) =>
    ["owner", "general_manager", "accountant", "cashier"].includes(role),
  );
  const canReadApprovalRegister = roleCodes.some((role) =>
    ["owner", "general_manager", "accountant"].includes(role),
  );
  const canReadShiftHistory = roleCodes.some((role) =>
    ["owner", "general_manager", "accountant"].includes(role),
  );
  const canReadReconciliation = roleCodes.some((role) =>
    ["owner", "general_manager", "accountant"].includes(role),
  );
  const canReadFinanceReports = roleCodes.some((role) =>
    ["owner", "general_manager", "accountant"].includes(role),
  );
  const canReviewShifts = roleCodes.some((role) =>
    ["owner", "general_manager"].includes(role),
  );
  const [reportDate, setReportDate] = useState("");
  const [approvalFromDate, setApprovalFromDate] = useState("");
  const [approvalToDate, setApprovalToDate] = useState("");
  const shift = useCurrentCashierShift(hotel.data?.id, canOperateCashierShift);
  const shiftHistory = useCashierShiftHistory(
    hotel.data?.id,
    canReadShiftHistory,
  );
  const pendingPayments = usePendingPaymentVerifications(
    hotel.data?.id,
    canVerifyPayments,
  );
  const paymentMethods = useAllPaymentMethods(
    hotel.data?.id,
    canManagePaymentMethods,
  );
  const financeApprovals = useFinanceApprovalRequests(
    hotel.data?.id,
    canViewFinanceRequests,
  );
  const approvalRegister = useFinanceApprovalRegister(
    hotel.data?.id,
    canReadApprovalRegister,
    approvalFromDate,
    approvalToDate,
  );
  const reconciliation = useDailyPaymentReconciliation(
    hotel.data?.id,
    canReadReconciliation,
    reportDate,
  );
  const revenueTaxReport = useDailyRevenueTaxReport(
    hotel.data?.id,
    canReadFinanceReports,
    reportDate,
  );
  const depositLiabilities = useDepositGuestCreditLiabilities(
    hotel.data?.id,
    canReadFinanceReports,
  );
  const queryClient = useQueryClient();
  const [folioId, setFolioId] = useState("");
  const [shiftAction, setShiftAction] = useState<"open" | "close" | null>(null);
  const [verificationAction, setVerificationAction] =
    useState<VerificationAction | null>(null);
  const [reviewTarget, setReviewTarget] = useState<CashierShiftHistory | null>(
    null,
  );
  const [paymentMethodAction, setPaymentMethodAction] =
    useState<PaymentMethodAction | null>(null);
  const [financeDecisionAction, setFinanceDecisionAction] =
    useState<FinanceDecisionAction | null>(null);
  const [approvalSearch, setApprovalSearch] = useState("");
  const [approvalStatus, setApprovalStatus] = useState("all");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [financeView, setFinanceView] = useState<FinanceView>("overview");
  const selected = folios.data?.find((folio) => folio.id === folioId);
  const approvalRegisterRows = (approvalRegister.data ?? []).filter((item) => {
    if (approvalStatus !== "all" && item.status !== approvalStatus)
      return false;
    const search = approvalSearch.trim().toLowerCase();
    if (!search) return true;
    return [
      item.action_type,
      item.status,
      item.target_document,
      item.reference,
      item.description,
      item.reason,
      item.requested_by_name,
      item.decided_by_name,
      item.executed_by_name,
      item.decision_note,
    ].some((value) => value?.toLowerCase().includes(search));
  });
  const pendingVerificationCount = pendingPayments.data?.length ?? 0;
  const pendingApprovalCount =
    financeApprovals.data?.filter((request) => request.status === "pending")
      .length ?? 0;
  const approvedExecutionCount =
    financeApprovals.data?.filter((request) => request.status === "approved")
      .length ?? 0;

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["folios", hotel.data?.id] }),
      queryClient.invalidateQueries({
        queryKey: ["folio-payment-history", hotel.data?.id, folioId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["current-cashier-shift", hotel.data?.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["cashier-shift-history", hotel.data?.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["pending-payment-verifications", hotel.data?.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["payment-methods", hotel.data?.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["all-payment-methods", hotel.data?.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["finance-approval-requests", hotel.data?.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["finance-approval-register", hotel.data?.id],
      }),
      queryClient.invalidateQueries({ queryKey: ["business-receivables", hotel.data?.id] }),
      queryClient.invalidateQueries({ queryKey: ["business-receivable-payments", hotel.data?.id] }),
      queryClient.invalidateQueries({ queryKey: ["business-receivable-ageing", hotel.data?.id] }),
      queryClient.invalidateQueries({ queryKey: ["business-account-statement"] }),
      queryClient.invalidateQueries({ queryKey: ["business-credit-positions", hotel.data?.id] }),
      queryClient.invalidateQueries({ queryKey: ["business-credit-notes", hotel.data?.id] }),
      queryClient.invalidateQueries({
        queryKey: ["daily-payment-reconciliation", hotel.data?.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["daily-revenue-tax-report", hotel.data?.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["deposit-guest-credit-liabilities", hotel.data?.id],
      }),
    ]);
  }

  async function submitFinanceDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!financeDecisionAction) return;
    setBusy(true);
    try {
      await decideFinanceApproval(
        financeDecisionAction.request.id,
        financeDecisionAction.approve,
        String(new FormData(event.currentTarget).get("note")),
      );
      setMessage(
        `Request ${financeDecisionAction.approve ? "approved. Review it once more, then execute it." : "rejected."}`,
      );
      setFinanceDecisionAction(null);
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Finance approval decision failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function executeApprovedRequest(request: FinanceApprovalRequest) {
    setBusy(true);
    try {
      await executeFinanceApproval(request.id);
      setMessage("Approved financial correction executed and recorded.");
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Financial correction could not be executed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hotel.data || !shiftAction) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      if (shiftAction === "open") {
        await openCashierShift(
          hotel.data.id,
          nairaToKobo(String(form.get("openingFloat"))),
        );
        setMessage("Cashier shift opened.");
      } else if (shift.data) {
        await closeCashierShift(
          shift.data.id,
          nairaToKobo(String(form.get("declaredCash"))),
          String(form.get("reason")),
          String(form.get("handoverReference")),
        );
        setMessage("Cashier shift closed and reconciled.");
      }
      setShiftAction(null);
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Cashier shift action failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reviewTarget) return;
    setBusy(true);
    try {
      await reviewCashierShift(
        reviewTarget.id,
        String(new FormData(event.currentTarget).get("notes")),
      );
      setReviewTarget(null);
      setMessage(`${reviewTarget.shift_number} reviewed.`);
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Cashier-shift review failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!verificationAction) return;
    const note = String(new FormData(event.currentTarget).get("note"));
    setBusy(true);
    try {
      if (verificationAction.kind === "verify") {
        await verifyPendingPayment(verificationAction.payment.payment_id, note);
        setMessage(
          `${verificationAction.payment.payment_number} verified and its receipt issued.`,
        );
      } else {
        await rejectPendingPayment(verificationAction.payment.payment_id, note);
        setMessage(
          `${verificationAction.payment.payment_number} rejected and retained in the audit trail.`,
        );
      }
      setVerificationAction(null);
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Payment verification action failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitPaymentMethod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hotel.data || !paymentMethodAction) return;
    const form = new FormData(event.currentTarget);
    const values = {
      code: String(form.get("code")),
      name: String(form.get("name")),
      requiresReference: form.has("requiresReference"),
      requiresVerification: form.has("requiresVerification"),
      displayOrder: Number(form.get("displayOrder")),
    };
    setBusy(true);
    try {
      if (paymentMethodAction.kind === "create") {
        await createPaymentMethod(hotel.data.id, values);
        setMessage("Payment method created for future collections.");
      } else {
        await updatePaymentMethod(paymentMethodAction.paymentMethod.id, {
          ...values,
          active: form.has("active"),
        });
        setMessage(
          "Payment method updated. Changes apply only to future collections.",
        );
      }
      setPaymentMethodAction(null);
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Payment method action failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (
    hotel.isLoading ||
    folios.isLoading ||
    accessLoading ||
    (canOperateCashierShift && shift.isLoading) ||
    (canVerifyPayments && pendingPayments.isLoading) ||
    (canReadShiftHistory && shiftHistory.isLoading) ||
    (canManagePaymentMethods && paymentMethods.isLoading) ||
    (canViewFinanceRequests && financeApprovals.isLoading) ||
    (canReadReconciliation && reconciliation.isLoading) ||
    (canReadFinanceReports && revenueTaxReport.isLoading) ||
    (canReadFinanceReports && depositLiabilities.isLoading) ||
    (canReadApprovalRegister && approvalRegister.isLoading)
  )
    return <PageLoading />;
  if (
    hotel.error ||
    folios.error ||
    (canOperateCashierShift && shift.error) ||
    (canVerifyPayments && pendingPayments.error) ||
    (canReadShiftHistory && shiftHistory.error) ||
    (canManagePaymentMethods && paymentMethods.error) ||
    (canViewFinanceRequests && financeApprovals.error) ||
    (canReadReconciliation && reconciliation.error) ||
    (canReadFinanceReports && revenueTaxReport.error) ||
    (canReadFinanceReports && depositLiabilities.error) ||
    (canReadApprovalRegister && approvalRegister.error)
  )
    return <PageError message="Unable to load financial history." />;
  if (!hotel.data)
    return <EmptyState>No hotel is assigned to your staff account.</EmptyState>;

  return (
    <section className="max-w-5xl">
      <p className="text-sm font-medium text-amber-800">Finance</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">
        Payments and receipts
      </h1>
      <p className="mt-2 text-sm text-stone-600">
        Confirmed payments receive receipts. Transfers awaiting verification do
        not change a folio balance or support checkout.
      </p>
      {message && (
        <p className="mt-4 rounded-xl bg-stone-100 p-3 text-sm" role="status">
          {message}
        </p>
      )}

      {financeView === "overview" && (
        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {canVerifyPayments && (
            <button
              type="button"
              onClick={() => setFinanceView("approvals")}
              className="rounded-2xl border border-stone-200 bg-white p-4 text-left shadow-sm transition hover:border-amber-400"
            >
              <Clock3 className="size-5 text-amber-800" />
              <p className="mt-3 text-xs text-stone-500">
                Awaiting verification
              </p>
              <p className="mt-1 text-2xl font-semibold text-amber-900">
                {pendingVerificationCount}
              </p>
            </button>
          )}
          {canViewFinanceRequests && (
            <button
              type="button"
              onClick={() => setFinanceView("approvals")}
              className="rounded-2xl border border-stone-200 bg-white p-4 text-left shadow-sm transition hover:border-amber-400"
            >
              <CircleCheckBig className="size-5 text-sky-700" />
              <p className="mt-3 text-xs text-stone-500">Approval decisions</p>
              <p className="mt-1 text-2xl font-semibold text-sky-800">
                {pendingApprovalCount}
              </p>
            </button>
          )}
          {canApproveFinance && (
            <button
              type="button"
              onClick={() => setFinanceView("approvals")}
              className="rounded-2xl border border-stone-200 bg-white p-4 text-left shadow-sm transition hover:border-emerald-400"
            >
              <BadgeDollarSign className="size-5 text-emerald-700" />
              <p className="mt-3 text-xs text-stone-500">Ready to execute</p>
              <p className="mt-1 text-2xl font-semibold text-emerald-700">
                {approvedExecutionCount}
              </p>
            </button>
          )}
          {canOperateCashierShift && (
            <button
              type="button"
              onClick={() => setFinanceView("cashier")}
              className={`rounded-2xl border p-4 text-left shadow-sm transition hover:border-amber-400 ${shift.data ? "border-emerald-200 bg-emerald-50" : "border-stone-200 bg-white"}`}
            >
              <WalletCards
                className={`size-5 ${shift.data ? "text-emerald-700" : "text-stone-600"}`}
              />
              <p className="mt-3 text-xs text-stone-500">My cashier shift</p>
              <p
                className={`mt-1 text-lg font-semibold ${shift.data ? "text-emerald-700" : "text-stone-800"}`}
              >
                {shift.data ? "Open" : "Not opened"}
              </p>
            </button>
          )}
        </div>
      )}

      <nav
        aria-label="Finance workspace sections"
        className="mt-4 flex gap-2 overflow-x-auto rounded-2xl border border-stone-200 bg-white p-2 text-sm shadow-sm"
      >
        <button
          type="button"
          onClick={() => setFinanceView("overview")}
          className={`shrink-0 rounded-xl px-3 py-2 font-medium ${financeView === "overview" ? "bg-stone-900 text-white" : "hover:bg-stone-100"}`}
        >
          Overview
        </button>
        {(canReadReconciliation || canReadFinanceReports) && (
          <button
            type="button"
            onClick={() => setFinanceView("reports")}
            className={`shrink-0 rounded-xl px-3 py-2 font-medium ${financeView === "reports" ? "bg-stone-900 text-white" : "hover:bg-stone-100"}`}
          >
            Reports
          </button>
        )}
        {(canVerifyPayments ||
          canViewFinanceRequests ||
          canReadApprovalRegister) && (
          <button
            type="button"
            onClick={() => setFinanceView("approvals")}
            className={`shrink-0 rounded-xl px-3 py-2 font-medium ${financeView === "approvals" ? "bg-stone-900 text-white" : "hover:bg-stone-100"}`}
          >
            Approvals
          </button>
        )}
        {(canOperateCashierShift || canReadShiftHistory) && (
          <button
            type="button"
            onClick={() => setFinanceView("cashier")}
            className={`shrink-0 rounded-xl px-3 py-2 font-medium ${financeView === "cashier" ? "bg-stone-900 text-white" : "hover:bg-stone-100"}`}
          >
            Cashier controls
          </button>
        )}
        <button
          type="button"
          onClick={() => setFinanceView("receipts")}
          className={`shrink-0 rounded-xl px-3 py-2 font-medium ${financeView === "receipts" ? "bg-stone-900 text-white" : "hover:bg-stone-100"}`}
        >
          Receipts
        </button>
        {canManagePaymentMethods && (
          <button
            type="button"
            onClick={() => setFinanceView("settings")}
            className={`shrink-0 rounded-xl px-3 py-2 font-medium ${financeView === "settings" ? "bg-stone-900 text-white" : "hover:bg-stone-100"}`}
          >
            Payment settings
          </button>
        )}
      </nav>

      {financeView === "overview" && (
        <section className="mt-6 rounded-2xl border border-stone-200 bg-stone-50 p-5">
          <h2 className="text-lg font-semibold">What do you need to do?</h2>
          <p className="mt-1 text-sm text-stone-600">
            Choose one workspace. Only the information for that task will be
            shown.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {(canReadReconciliation || canReadFinanceReports) && (
              <button
                type="button"
                onClick={() => setFinanceView("reports")}
                className="rounded-2xl border border-stone-200 bg-white p-5 text-left shadow-sm transition hover:border-amber-400 hover:shadow"
              >
                <p className="font-semibold">Review financial reports</p>
                <p className="mt-1 text-sm text-stone-500">
                  Reconciliation, revenue, tax, deposits, and guest credits.
                </p>
              </button>
            )}
            {(canVerifyPayments ||
              canViewFinanceRequests ||
              canReadApprovalRegister) && (
              <button
                type="button"
                onClick={() => setFinanceView("approvals")}
                className="rounded-2xl border border-stone-200 bg-white p-5 text-left shadow-sm transition hover:border-amber-400 hover:shadow"
              >
                <p className="font-semibold">Handle approvals</p>
                <p className="mt-1 text-sm text-stone-500">
                  Verify transfers and review controlled financial corrections.
                </p>
              </button>
            )}
            {(canOperateCashierShift || canReadShiftHistory) && (
              <button
                type="button"
                onClick={() => setFinanceView("cashier")}
                className="rounded-2xl border border-stone-200 bg-white p-5 text-left shadow-sm transition hover:border-amber-400 hover:shadow"
              >
                <p className="font-semibold">Manage cashier controls</p>
                <p className="mt-1 text-sm text-stone-500">
                  Open or close a shift and review cash variances.
                </p>
              </button>
            )}
            <button
              type="button"
              onClick={() => setFinanceView("receipts")}
              className="rounded-2xl border border-stone-200 bg-white p-5 text-left shadow-sm transition hover:border-amber-400 hover:shadow"
            >
              <p className="font-semibold">Find a receipt</p>
              <p className="mt-1 text-sm text-stone-500">
                Choose a folio and review its payment and receipt history.
              </p>
            </button>
            {canManagePaymentMethods && (
              <button
                type="button"
                onClick={() => setFinanceView("settings")}
                className="rounded-2xl border border-stone-200 bg-white p-5 text-left shadow-sm transition hover:border-amber-400 hover:shadow sm:col-span-2"
              >
                <p className="font-semibold">Configure payment methods</p>
                <p className="mt-1 text-sm text-stone-500">
                  Manage which collection methods require references or finance
                  verification.
                </p>
              </button>
            )}
          </div>
        </section>
      )}

      {financeView === "reports" &&
        (canReadReconciliation || canReadFinanceReports) && (
          <div className="mt-4 flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-stone-200 bg-stone-50 p-4">
            <div>
              <label
                htmlFor="finance-report-date"
                className="text-xs font-semibold uppercase tracking-wide text-stone-500"
              >
                Reporting business date
              </label>
              <input
                id="finance-report-date"
                type="date"
                value={reportDate}
                onChange={(event) => setReportDate(event.target.value)}
                className="mt-1 block rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
              />
            </div>
            <div className="flex items-center gap-3">
              <p className="max-w-sm text-xs text-stone-500">
                Leave blank for the hotel’s current business date. This date
                applies to reconciliation, revenue, and tax; liability balances
                remain live as of now.
              </p>
              {reportDate && (
                <button
                  type="button"
                  onClick={() => setReportDate("")}
                  className="shrink-0 rounded-lg border border-stone-300 bg-white px-3 py-2 text-xs font-semibold"
                >
                  Use current date
                </button>
              )}
            </div>
          </div>
        )}

      {financeView === "reports" && canReadReconciliation && (
        <section
          id="reconciliation"
          className="mt-6 scroll-mt-6 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">
                {reportDate
                  ? `Payment reconciliation · ${reportDate}`
                  : "Today’s payment reconciliation"}
              </h2>
              <p className="mt-1 text-sm text-stone-600">
                Amounts use the hotel business date and separate pending claims
                from settled money.
              </p>
            </div>
            <button
              type="button"
              disabled={!reconciliation.data?.length}
              onClick={() =>
                downloadCsv(
                  `payment-reconciliation-${reportDate || "current"}.csv`,
                  [
                    [
                      "Payment method",
                      "Settled (kobo)",
                      "Pending verification (kobo)",
                      "Refunded (kobo)",
                      "Voided (kobo)",
                      "Net collected (kobo)",
                    ],
                    ...(reconciliation.data ?? []).map((item) => [
                      item.payment_method_name,
                      item.settled_kobo,
                      item.pending_verification_kobo,
                      item.refunded_kobo,
                      item.voided_kobo,
                      item.net_collected_kobo,
                    ]),
                  ],
                )
              }
              className="inline-flex items-center gap-2 rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold disabled:opacity-50"
            >
              <Download className="size-4" /> Export CSV
            </button>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-180 text-left text-sm">
              <thead className="border-b text-stone-500">
                <tr>
                  <th className="pb-2">Method</th>
                  <th className="pb-2">Settled</th>
                  <th className="pb-2">Pending</th>
                  <th className="pb-2">Refunded</th>
                  <th className="pb-2">Voided</th>
                  <th className="pb-2">Net collected</th>
                </tr>
              </thead>
              <tbody>
                {reconciliation.data?.map((item) => (
                  <tr
                    key={item.payment_method_name}
                    className="border-b border-stone-100"
                  >
                    <td className="py-3 font-medium">
                      {item.payment_method_name}
                    </td>
                    <td>{formatNaira(item.settled_kobo)}</td>
                    <td>{formatNaira(item.pending_verification_kobo)}</td>
                    <td>{formatNaira(item.refunded_kobo)}</td>
                    <td>{formatNaira(item.voided_kobo)}</td>
                    <td className="font-semibold">
                      {formatNaira(item.net_collected_kobo)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {financeView === "reports" && canReadFinanceReports && (
        <div id="finance-reports" className="scroll-mt-6">
          <DailyRevenueTaxSection report={revenueTaxReport.data} />
          <DepositLiabilitySection
            liabilities={depositLiabilities.data ?? []}
          />
        </div>
      )}

      {financeView === "approvals" && canVerifyPayments && (
        <section
          id="payment-verification"
          className="mt-6 scroll-mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5"
        >
          <h2 className="font-semibold text-amber-950">
            Pending payment verification
          </h2>
          <p className="mt-1 text-sm text-amber-900">
            Confirm the money in the bank or payment-provider record before
            issuing a receipt.
          </p>
          {pendingPayments.data?.length ? (
            <div className="mt-4 space-y-3">
              {pendingPayments.data.map((payment) => (
                <div
                  key={payment.payment_id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white p-4 text-sm"
                >
                  <div>
                    <p className="font-semibold">
                      {payment.payment_number} ·{" "}
                      {formatNaira(payment.amount_kobo)}
                    </p>
                    <p className="mt-1 text-stone-600">
                      {payment.payment_method_name} · {payment.source} ·{" "}
                      {payment.guest_name || "Guest"}
                    </p>
                    <p className="mt-1 text-xs text-stone-500">
                      {payment.folio_number ||
                        payment.reservation_number ||
                        "Payment record"}
                      {payment.reference ? ` · Ref: ${payment.reference}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setVerificationAction({ kind: "verify", payment })
                      }
                      className="rounded-lg bg-amber-900 px-3 py-2 text-xs font-semibold text-white"
                    >
                      Verify
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setVerificationAction({ kind: "reject", payment })
                      }
                      className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-amber-900">
              There are no payments awaiting verification.
            </p>
          )}
        </section>
      )}

      {financeView === "approvals" && canViewFinanceRequests && (
        <section
          id="finance-approvals"
          className="mt-6 scroll-mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5"
        >
          <h2 className="font-semibold text-amber-950">
            Financial correction approvals
          </h2>
          <p className="mt-1 text-sm text-amber-900">
            {canApproveFinance
              ? "Approve only requests created by someone else. Approval and execution are separately recorded."
              : "Your financial correction requests remain here until an independent Owner or GM decides them."}
          </p>
          {financeApprovals.data?.length ? (
            <div className="mt-4 space-y-3">
              {financeApprovals.data.map((request) => (
                <div
                  key={request.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white p-4 text-sm"
                >
                  <div>
                    <p className="font-semibold">
                      {request.action_type.replaceAll("_", " ")}
                    </p>
                    <p className="mt-1 text-stone-600">
                      Requested by{" "}
                      {request.profiles?.full_name || "Staff member"} ·{" "}
                      {new Date(request.requested_at).toLocaleString("en-NG")}
                    </p>
                    <p className="mt-1 text-xs text-stone-500">
                      Reason: {request.reason}
                    </p>
                    {request.action_type === "pos_payment_refund" && (
                      <p className="mt-1 text-xs font-semibold text-rose-800">
                        Requested POS refund: {formatNaira(Number(request.payload.amount_kobo ?? 0))}
                        {request.payload.refund_method_name
                          ? ` · ${request.payload.refund_method_name}`
                          : ""}
                        {request.payload.reference ? ` · Ref ${request.payload.reference}` : ""}
                      </p>
                    )}
                    {request.action_type === "pos_order_line_correction" && (
                      <p className="mt-1 text-xs font-semibold text-amber-900">
                        POS line correction · {String(request.payload.line_name ?? "Order line")} · {Number(request.payload.amount_delta_kobo ?? 0) >= 0 ? "+" : "−"}{formatNaira(Math.abs(Number(request.payload.amount_delta_kobo ?? 0)))}
                        {request.payload.description ? ` · ${request.payload.description}` : ""}
                      </p>
                    )}
                    {request.status === "approved" && (
                      <p className="mt-1 text-xs text-emerald-700">
                        Approved: {request.decision_note}
                      </p>
                    )}
                  </div>
                  {canApproveFinance && (
                    <div className="flex gap-2">
                      {request.status === "pending" && (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              setFinanceDecisionAction({
                                request,
                                approve: true,
                              })
                            }
                            className="rounded-lg bg-amber-900 px-3 py-2 text-xs font-semibold text-white"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setFinanceDecisionAction({
                                request,
                                approve: false,
                              })
                            }
                            className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700"
                          >
                            Reject
                          </button>
                        </>
                      )}
                      {request.status === "approved" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => executeApprovedRequest(request)}
                          className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                        >
                          Execute
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-amber-900">
              There are no pending financial correction requests.
            </p>
          )}
        </section>
      )}

      {financeView === "approvals" && canReadApprovalRegister && (
        <section
          id="approval-register"
          className="mt-6 scroll-mt-6 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm"
        >
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-semibold">Finance approval register</h2>
              <p className="mt-1 text-sm text-stone-600">
                {approvalFromDate || approvalToDate
                  ? "Hotel-wide correction requests for the selected date range."
                  : "Hotel-wide correction requests from the last 90 business days."}{" "}
                This report does not grant approval authority.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="text-xs text-stone-500">
                From
                <input
                  type="date"
                  value={approvalFromDate}
                  max={approvalToDate || undefined}
                  onChange={(event) => setApprovalFromDate(event.target.value)}
                  className="mt-1 block rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-900"
                />
              </label>
              <label className="text-xs text-stone-500">
                To
                <input
                  type="date"
                  value={approvalToDate}
                  min={approvalFromDate || undefined}
                  onChange={(event) => setApprovalToDate(event.target.value)}
                  className="mt-1 block rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-900"
                />
              </label>
              <input
                value={approvalSearch}
                onChange={(event) => setApprovalSearch(event.target.value)}
                placeholder="Search document, staff, reason"
                className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
              />
              <select
                value={approvalStatus}
                onChange={(event) => setApprovalStatus(event.target.value)}
                className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
              >
                <option value="all">All statuses</option>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="executed">Executed</option>
                <option value="expired">Expired</option>
                <option value="withdrawn">Withdrawn</option>
              </select>
              <button
                type="button"
                disabled={!approvalRegisterRows.length}
                onClick={() =>
                  downloadCsv(
                    `finance-approval-register-${approvalFromDate || "default"}-${approvalToDate || "current"}.csv`,
                    [
                      [
                        "Requested at",
                        "Action",
                        "Status",
                        "Document",
                        "Reference",
                        "Amount (kobo)",
                        "Description",
                        "Reason",
                        "Requested by",
                        "Decided by",
                        "Decision note",
                        "Executed by",
                        "Executed at",
                      ],
                      ...approvalRegisterRows.map((item) => [
                        item.requested_at,
                        item.action_type,
                        item.status,
                        item.target_document,
                        item.reference,
                        item.amount_kobo,
                        item.description,
                        item.reason,
                        item.requested_by_name,
                        item.decided_by_name,
                        item.decision_note,
                        item.executed_by_name,
                        item.executed_at,
                      ]),
                    ],
                  )
                }
                className="inline-flex items-center gap-2 self-end rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold disabled:opacity-50"
              >
                <Download className="size-4" /> Export CSV
              </button>
            </div>
          </div>
          {approvalRegisterRows.length ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-240 text-left text-sm">
                <thead className="border-b text-stone-500">
                  <tr>
                    <th className="pb-2 pr-4">Requested</th>
                    <th className="pb-2 pr-4">Correction</th>
                    <th className="pb-2 pr-4">Document</th>
                    <th className="pb-2 pr-4">Amount</th>
                    <th className="pb-2 pr-4">People and decision</th>
                    <th className="pb-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {approvalRegisterRows.map((item) => (
                    <tr
                      key={item.request_id}
                      className="border-b border-stone-100 align-top"
                    >
                      <td className="py-3 pr-4 whitespace-nowrap">
                        {new Date(item.requested_at).toLocaleString("en-NG")}
                      </td>
                      <td className="py-3 pr-4">
                        <p className="font-medium capitalize">
                          {item.action_type.replaceAll("_", " ")}
                        </p>
                        <p className="mt-1 text-xs text-stone-500">
                          Reason: {item.reason}
                        </p>
                        {item.description && (
                          <p className="mt-1 text-xs text-stone-500">
                            {item.description}
                          </p>
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        <p>{item.target_document || "Record unavailable"}</p>
                        {item.reference && (
                          <p className="mt-1 text-xs text-stone-500">
                            Ref: {item.reference}
                          </p>
                        )}
                      </td>
                      <td className="py-3 pr-4 font-medium">
                        {item.amount_kobo === null
                          ? "-"
                          : formatNaira(item.amount_kobo)}
                      </td>
                      <td className="py-3 pr-4">
                        <p>
                          Requested by{" "}
                          {item.requested_by_name || "Staff member"}
                        </p>
                        {item.decided_at && (
                          <p className="mt-1 text-xs text-stone-500">
                            Decided by {item.decided_by_name || "Manager"}:{" "}
                            {item.decision_note || "No note"}
                          </p>
                        )}
                        {item.executed_at && (
                          <p className="mt-1 text-xs text-emerald-700">
                            Executed by {item.executed_by_name || "Manager"} at{" "}
                            {new Date(item.executed_at).toLocaleString("en-NG")}
                          </p>
                        )}
                      </td>
                      <td className="py-3 capitalize">{item.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-4 text-sm text-stone-500">
              No approval records match this view.
            </p>
          )}
        </section>
      )}

      {financeView === "settings" && canManagePaymentMethods && (
        <section
          id="payment-methods"
          className="mt-6 scroll-mt-6 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold">Payment methods</h2>
              <p className="mt-1 text-sm text-stone-600">
                Control future collections only. Used method names and codes
                remain fixed for the audit trail.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPaymentMethodAction({ kind: "create" })}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white"
            >
              Add method
            </button>
          </div>
          <div className="mt-4 space-y-3">
            {paymentMethods.data?.map((paymentMethod) => (
              <div
                key={paymentMethod.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 p-4 text-sm"
              >
                <div>
                  <p className="font-semibold">
                    {paymentMethod.name}{" "}
                    {!paymentMethod.active && (
                      <span className="ml-2 text-xs font-medium text-stone-500">
                        Inactive
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-stone-500">
                    Code: {paymentMethod.code} ·{" "}
                    {paymentMethod.requires_reference
                      ? "Reference required"
                      : "Reference optional"}{" "}
                    ·{" "}
                    {paymentMethod.requires_verification
                      ? "Independent verification required"
                      : "No independent verification"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setPaymentMethodAction({ kind: "edit", paymentMethod })
                  }
                  className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-800"
                >
                  Edit
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {financeView === "cashier" && canOperateCashierShift && (
        <section
          id="cashier-shift"
          className="mt-6 scroll-mt-6 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold">My cashier shift</h2>
              {shift.data ? (
                <p className="mt-1 text-sm text-stone-600">
                  {shift.data.shift_number} · Opened{" "}
                  {new Date(shift.data.opened_at).toLocaleTimeString("en-NG")}
                  <br />
                  Expected cash: {formatNaira(shift.data.expected_cash_kobo)}
                </p>
              ) : (
                <p className="mt-1 text-sm text-stone-600">
                  Open a shift before you receive cash payments.
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShiftAction(shift.data ? "close" : "open")}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white"
            >
              {shift.data ? "Close shift" : "Open shift"}
            </button>
          </div>
        </section>
      )}

      {financeView === "cashier" && canReadShiftHistory && (
        <section
          id="shift-history"
          className="mt-6 scroll-mt-6 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm"
        >
          <h2 className="font-semibold">Cashier shift control log</h2>
          <p className="mt-1 text-sm text-stone-600">
            A closed shift needs a cash handover reference. Variances need an
            independent manager review.
          </p>
          {shiftHistory.data?.length ? (
            <div className="mt-4 space-y-3">
              {shiftHistory.data.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 p-4 text-sm"
                >
                  <div>
                    <p className="font-semibold">
                      {item.shift_number} · {item.opened_by_name}
                    </p>
                    <p className="mt-1 text-stone-600">
                      Expected {formatNaira(item.expected_cash_kobo ?? 0)} ·
                      Declared{" "}
                      {item.declared_cash_kobo === null
                        ? "Open"
                        : formatNaira(item.declared_cash_kobo)}{" "}
                      · Variance{" "}
                      {item.variance_kobo === null
                        ? "—"
                        : formatNaira(item.variance_kobo)}
                    </p>
                    {item.handover_reference && (
                      <p className="mt-1 text-xs text-stone-500">
                        Handover: {item.handover_reference}
                      </p>
                    )}
                    {item.reviewed_at ? (
                      <p className="mt-1 text-xs text-emerald-700">
                        Reviewed by {item.reviewed_by_name || "Manager"}
                      </p>
                    ) : item.status === "closed" ? (
                      <p className="mt-1 text-xs text-amber-800">
                        Awaiting independent manager review
                      </p>
                    ) : null}
                  </div>
                  {canReviewShifts &&
                    item.status === "closed" &&
                    !item.reviewed_at && (
                      <button
                        type="button"
                        onClick={() => setReviewTarget(item)}
                        className="rounded-lg border border-amber-300 px-3 py-2 text-xs font-semibold text-amber-900"
                      >
                        Review shift
                      </button>
                    )}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-stone-500">
              No cashier shifts have been recorded.
            </p>
          )}
        </section>
      )}

      {financeView === "receipts" && (
        <section
          id="receipt-history"
          className="mt-6 scroll-mt-6 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm"
        >
          <h2 className="font-semibold">Folio payment and receipt lookup</h2>
          <p className="mt-1 text-sm text-stone-600">
            Select a guest folio to review its payments, receipts, refunds, and
            void history.
          </p>
          <select
            value={folioId}
            onChange={(event) => setFolioId(event.target.value)}
            className="mt-4 w-full max-w-xl rounded-xl border border-stone-300 bg-white px-3 py-2.5"
          >
            <option value="">Choose a folio</option>
            {folios.data?.map((folio) => (
              <option key={folio.id} value={folio.id}>
                {folio.folio_number} —{" "}
                {folio.stays?.guests?.full_name || "Guest"} —{" "}
                {formatNaira(folio.balance_kobo)}
              </option>
            ))}
          </select>
          {selected && (
            <FolioPaymentHistory folioId={selected.id} onChanged={refresh} />
          )}
        </section>
      )}

      <Modal
        open={Boolean(shiftAction)}
        title={
          shiftAction === "open" ? "Open cashier shift" : "Close cashier shift"
        }
        onClose={() => setShiftAction(null)}
      >
        {shiftAction && (
          <form onSubmit={submitShift} className="grid gap-4">
            {shiftAction === "open" ? (
              <label className="text-sm font-medium">
                Opening float (₦)
                <input
                  required
                  name="openingFloat"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue="0"
                  className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2.5"
                />
              </label>
            ) : (
              <>
                <p className="text-sm text-stone-600">
                  Expected cash:{" "}
                  {formatNaira(shift.data?.expected_cash_kobo ?? 0)}. Count the
                  physical cash before entering it.
                </p>
                <label className="text-sm font-medium">
                  Declared cash (₦)
                  <input
                    required
                    name="declaredCash"
                    type="number"
                    min="0"
                    step="0.01"
                    className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2.5"
                  />
                </label>
                <label className="text-sm font-medium">
                  Cash handover or bank-deposit reference
                  <input
                    required
                    name="handoverReference"
                    placeholder="Safe-bag or bank-deposit reference"
                    className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2.5"
                  />
                </label>
                <label className="text-sm font-medium">
                  Reason if there is a variance
                  <textarea
                    name="reason"
                    rows={3}
                    className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2.5"
                  />
                </label>
              </>
            )}
            <button
              disabled={busy}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white"
            >
              {busy ? "Saving…" : "Confirm"}
            </button>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(reviewTarget)}
        title="Review cashier shift"
        onClose={() => setReviewTarget(null)}
      >
        {reviewTarget && (
          <form onSubmit={submitReview} className="grid gap-4">
            <p className="text-sm text-stone-600">
              Review {reviewTarget.shift_number}, including its handover
              reference and any variance. You cannot review a shift you opened
              or closed.
            </p>
            <textarea
              name="notes"
              rows={4}
              placeholder={
                reviewTarget.variance_kobo
                  ? "Review note is required for a variance"
                  : "Review note (optional)"
              }
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <button
              disabled={busy}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white"
            >
              {busy ? "Saving…" : "Confirm review"}
            </button>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(verificationAction)}
        title={
          verificationAction?.kind === "verify"
            ? "Verify payment"
            : "Reject pending payment"
        }
        onClose={() => setVerificationAction(null)}
      >
        {verificationAction && (
          <form onSubmit={submitVerification} className="grid gap-4">
            <p className="text-sm text-stone-600">
              {verificationAction.kind === "verify"
                ? "Confirm that this payment appears in the bank or payment-provider record. A receipt will be issued only after confirmation."
                : "Rejecting the claim will void the pending payment and retain the reason in the audit trail."}
            </p>
            <textarea
              required
              name="note"
              rows={4}
              placeholder={
                verificationAction.kind === "verify"
                  ? "Verification note, e.g. bank statement reference"
                  : "Reason for rejection"
              }
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <button
              disabled={busy}
              className={
                verificationAction.kind === "verify"
                  ? "rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
                  : "rounded-lg bg-red-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
              }
            >
              {busy
                ? "Saving…"
                : verificationAction.kind === "verify"
                  ? "Verify and issue receipt"
                  : "Reject payment"}
            </button>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(paymentMethodAction)}
        title={
          paymentMethodAction?.kind === "create"
            ? "Add payment method"
            : "Edit payment method"
        }
        onClose={() => setPaymentMethodAction(null)}
      >
        {paymentMethodAction && (
          <form onSubmit={submitPaymentMethod} className="grid gap-4">
            <p className="text-sm text-stone-600">
              Changes affect new payment and deposit records only. Cash can
              never require independent verification.
            </p>
            <label className="text-sm font-medium">
              Name
              <input
                required
                name="name"
                maxLength={100}
                defaultValue={
                  paymentMethodAction.kind === "edit"
                    ? paymentMethodAction.paymentMethod.name
                    : ""
                }
                className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2.5"
              />
            </label>
            <label className="text-sm font-medium">
              Code
              <input
                required
                name="code"
                pattern="[a-z][a-z0-9_]{1,48}"
                title="Use lowercase letters, numbers, and underscores."
                defaultValue={
                  paymentMethodAction.kind === "edit"
                    ? paymentMethodAction.paymentMethod.code
                    : ""
                }
                className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2.5"
              />
            </label>
            <label className="text-sm font-medium">
              Display order
              <input
                required
                name="displayOrder"
                type="number"
                min="0"
                max="32767"
                defaultValue={
                  paymentMethodAction.kind === "edit"
                    ? paymentMethodAction.paymentMethod.display_order
                    : (paymentMethods.data?.length ?? 0) * 10 + 10
                }
                className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2.5"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                name="requiresReference"
                type="checkbox"
                defaultChecked={
                  paymentMethodAction.kind === "edit"
                    ? paymentMethodAction.paymentMethod.requires_reference
                    : false
                }
              />{" "}
              Require payment reference
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                name="requiresVerification"
                type="checkbox"
                defaultChecked={
                  paymentMethodAction.kind === "edit"
                    ? paymentMethodAction.paymentMethod.requires_verification
                    : false
                }
              />{" "}
              Require independent verification before receipt
            </label>
            {paymentMethodAction.kind === "edit" && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  name="active"
                  type="checkbox"
                  defaultChecked={paymentMethodAction.paymentMethod.active}
                />{" "}
                Available for new collections
              </label>
            )}
            <button
              disabled={busy}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {busy
                ? "Saving…"
                : paymentMethodAction.kind === "create"
                  ? "Add payment method"
                  : "Save payment method"}
            </button>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(financeDecisionAction)}
        title={
          financeDecisionAction?.approve
            ? "Approve financial correction"
            : "Reject financial correction"
        }
        onClose={() => setFinanceDecisionAction(null)}
      >
        {financeDecisionAction && (
          <form onSubmit={submitFinanceDecision} className="grid gap-4">
            <p className="text-sm text-stone-600">
              {financeDecisionAction.approve
                ? "Confirm the reason and evidence. You will execute the correction separately after approving it."
                : "Reject this request with a clear reason. Rejected requests remain in the audit trail."}
            </p>
            <textarea
              required
              name="note"
              rows={4}
              placeholder={
                financeDecisionAction.approve
                  ? "Approval note and evidence checked"
                  : "Reason for rejection"
              }
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <button
              disabled={busy}
              className={
                financeDecisionAction.approve
                  ? "rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
                  : "rounded-lg bg-red-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
              }
            >
              {busy
                ? "Saving…"
                : financeDecisionAction.approve
                  ? "Approve request"
                  : "Reject request"}
            </button>
          </form>
        )}
      </Modal>
    </section>
  );
}
