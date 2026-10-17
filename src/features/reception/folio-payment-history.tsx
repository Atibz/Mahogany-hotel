import { useRef, useState, type FormEvent } from "react";

import { Modal } from "@/components/shared/modal";
import { useAccess } from "@/features/auth/use-access";
import { formatNaira, nairaToKobo } from "@/lib/money";
import { printElementInIsolatedFrame } from "@/lib/print-document";

import {
  refundFolioPayment,
  voidFolioPayment,
  type FolioPaymentHistory,
} from "./reception-service";
import { useActiveHotel, useFolioPaymentHistory } from "./use-reception";

type Action = {
  payment: FolioPaymentHistory;
  kind: "void" | "refund";
};

export function FolioPaymentHistory({
  folioId,
  onChanged,
}: {
  folioId: string;
  onChanged: () => Promise<void>;
}) {
  const hotel = useActiveHotel();
  const history = useFolioPaymentHistory(folioId, hotel.data?.id);
  const { roleCodes } = useAccess();
  const [action, setAction] = useState<Action | null>(null);
  const [receipt, setReceipt] = useState<FolioPaymentHistory | null>(null);
  const [receiptPrintMessage, setReceiptPrintMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const receiptDocumentRef = useRef<HTMLDivElement>(null);
  const canVoid = roleCodes.some((role) =>
    ["owner", "general_manager", "accountant", "cashier"].includes(role),
  );
  const canRefund = roleCodes.some((role) =>
    ["owner", "general_manager", "accountant"].includes(role),
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setMessage(null);
    try {
      if (action.kind === "void")
        await voidFolioPayment(
          action.payment.payment_id,
          String(form.get("reason")),
        );
      else
        await refundFolioPayment({
          paymentId: action.payment.payment_id,
          amountKobo: nairaToKobo(String(form.get("amount"))),
          reason: String(form.get("reason")),
          reference: String(form.get("reference")),
        });
      setAction(null);
      await onChanged();
      setMessage(
        "Financial correction request submitted for independent approval.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Financial correction request could not be submitted.",
      );
    } finally {
      setBusy(false);
    }
  }

  function printReceiptDocument() {
    const source = receiptDocumentRef.current;
    if (!source) return;
    const opened = printElementInIsolatedFrame({
      source,
      title: receipt?.receipt_number
        ? `Receipt ${receipt.receipt_number}`
        : "Payment receipt",
      removeSelector: "[data-receipt-print-action]",
      styles: `
        @page { margin: 14mm; }
        * { box-sizing: border-box; }
        body { margin: 0; color: #1c1917; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
        .receipt-document { max-width: 720px; margin: 0 auto; }
        .receipt-document p { margin: 0; }
        .receipt-document > div { margin-bottom: 20px; }
        .receipt-document > div:first-child { border-bottom: 1px solid #d6d3d1; padding-bottom: 16px; }
        .receipt-document .receipt-logo { display: block; width: 220px; height: auto; margin-bottom: 4px; }
        .receipt-document .receipt-hotel-name { font-size: 22px; font-weight: 700; }
        .receipt-document .receipt-caption { margin-top: 4px; color: #78716c; font-size: 11px; font-weight: 700; letter-spacing: .12em; }
        .receipt-document > div:first-child > div { display: flex; justify-content: space-between; gap: 12px; margin-top: 12px; }
        dl { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 24px; margin: 0 0 20px; }
        dt { color: #78716c; font-size: 12px; }
        dd { margin: 2px 0 0; font-weight: 600; }
      `,
    });
    setReceiptPrintMessage(
      opened
        ? null
        : "This browser cannot open a print dialog. Open the app in a full browser window and try again.",
    );
  }

  if (history.isLoading)
    return (
      <p className="mt-5 text-sm text-stone-500">Loading payment history...</p>
    );
  if (history.isError)
    return (
      <p className="mt-5 text-sm text-red-700">
        Payment history could not be loaded.
      </p>
    );
  if (!history.data?.length)
    return (
      <p className="mt-5 text-sm text-stone-500">
        No payments have been recorded for this folio.
      </p>
    );

  return (
    <div className="mt-6">
      <h3 className="font-semibold">Payment and receipt history</h3>
      {message && <p className="mt-2 text-sm text-red-700">{message}</p>}
      <div className="mt-3 overflow-x-auto rounded-lg border border-stone-200">
        <table className="w-full min-w-200 text-left text-sm">
          <thead className="bg-stone-50 text-stone-500">
            <tr>
              <th className="px-4 py-3 font-medium">Payment</th>
              <th className="px-4 py-3 font-medium">Method</th>
              <th className="px-4 py-3 font-medium">Amount</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Receipt</th>
            </tr>
          </thead>
          <tbody>
            {history.data.map((payment) => {
              const refundedAmount = payment.refunds.reduce(
                (sum, refund) => sum + refund.amount_kobo,
                0,
              );
              const refundableAmount = Math.max(
                0,
                payment.allocated_amount_kobo - refundedAmount,
              );
              return (
                <tr
                  key={payment.payment_id}
                  className="border-t border-stone-100 align-top"
                >
                  <td className="px-4 py-3">
                    <p className="font-medium">{payment.payment_number}</p>
                    <p className="mt-1 text-xs text-stone-500">
                      {new Date(payment.received_at).toLocaleString("en-NG")}
                    </p>
                    {payment.reference && (
                      <p className="mt-1 text-xs text-stone-500">
                        Ref: {payment.reference}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {payment.payment_method_name || "-"}
                  </td>
                  <td className="px-4 py-3">
                    {formatNaira(payment.allocated_amount_kobo)}
                    {payment.refunds.map((refund) => (
                      <p key={refund.id} className="mt-1 text-xs text-red-700">
                        Refund {refund.refund_number}: -
                        {formatNaira(refund.amount_kobo)}
                      </p>
                    ))}
                  </td>
                  <td className="px-4 py-3 capitalize">{payment.status}</td>
                  <td className="px-4 py-3">
                    {payment.status === "completed" &&
                      (canVoid || canRefund) && (
                        <div className="flex gap-2">
                          {canVoid && payment.refunds.length === 0 && (
                            <button
                              type="button"
                              onClick={() =>
                                setAction({
                                  payment,
                                  kind: "void",
                                })
                              }
                              className="text-xs font-semibold text-red-700"
                            >
                              Void
                            </button>
                          )}
                          {canRefund && refundableAmount > 0 && (
                            <button
                              type="button"
                              onClick={() =>
                                setAction({
                                  payment,
                                  kind: "refund",
                                })
                              }
                              className="text-xs font-semibold text-amber-900"
                            >
                              Refund
                            </button>
                          )}
                        </div>
                      )}
                  </td>
                  <td className="px-4 py-3">
                    {payment.receipt_number ? (
                      <button
                        type="button"
                        onClick={() => { setReceiptPrintMessage(null); setReceipt(payment); }}
                        className="text-xs font-semibold text-amber-900"
                      >
                        View {payment.receipt_number}
                      </button>
                    ) : payment.status === "pending_verification" ? (
                      <span className="text-xs text-stone-500">
                        After verification
                      </span>
                    ) : (
                      <span className="text-xs text-red-700">
                        No receipt issued
                      </span>
                    )}
                    {payment.receipt_voided_at && (
                      <p className="mt-1 text-xs text-red-700">Voided</p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Modal
        open={Boolean(action)}
        title={action?.kind === "void" ? "Void payment" : "Refund payment"}
        onClose={() => setAction(null)}
      >
        {action && (
          <form onSubmit={submit} className="grid gap-3">
            <div className="rounded-xl bg-stone-50 p-4 text-sm">
              <p className="font-semibold">{action.payment.payment_number}</p>
              <div className="mt-2 grid grid-cols-2 gap-3 text-stone-600">
                <p>
                  Original
                  <span className="block font-semibold text-stone-900">
                    {formatNaira(action.payment.allocated_amount_kobo)}
                  </span>
                </p>
                <p>
                  Previously refunded
                  <span className="block font-semibold text-stone-900">
                    {formatNaira(
                      action.payment.refunds.reduce(
                        (sum, refund) => sum + refund.amount_kobo,
                        0,
                      ),
                    )}
                  </span>
                </p>
              </div>
            </div>
            {action.kind === "refund" && (
              <>
                <input
                  required
                  name="amount"
                  type="number"
                  min="0.01"
                  max={
                    (action.payment.allocated_amount_kobo -
                      action.payment.refunds.reduce(
                        (sum, refund) => sum + refund.amount_kobo,
                        0,
                      )) /
                    100
                  }
                  step="0.01"
                  placeholder={`Refund amount — max ${formatNaira(
                    action.payment.allocated_amount_kobo -
                      action.payment.refunds.reduce(
                        (sum, refund) => sum + refund.amount_kobo,
                        0,
                      ),
                  )}`}
                  className="rounded-lg border border-stone-300 px-3 py-2.5"
                />
                <input
                  name="reference"
                  placeholder="Refund reference (optional)"
                  className="rounded-lg border border-stone-300 px-3 py-2.5"
                />
              </>
            )}
            <textarea
              required
              name="reason"
              rows={3}
              placeholder="Reason"
              className="rounded-lg border border-stone-300 px-3 py-2.5"
            />
            <button
              disabled={busy}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white"
            >
              Confirm
            </button>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(receipt)}
        title="Payment receipt"
        onClose={() => { setReceipt(null); setReceiptPrintMessage(null); }}
      >
        {receipt && (
          <div
            ref={receiptDocumentRef}
            className="receipt-document space-y-5 text-stone-900"
          >
            <div className="border-b border-stone-300 pb-4">
              <img src="/mahogany-logo.png" alt="" className="receipt-logo mb-1 w-55 max-w-full" />
              <p className="receipt-hotel-name text-xl font-bold">
                {hotel.data?.trading_name || "Hotel"}
              </p>
              <p className="receipt-caption mt-1 text-xs font-semibold tracking-wider text-stone-500">
                PAYMENT RECEIPT
              </p>
              <div className="mt-3 flex flex-wrap justify-between gap-2 text-sm">
                <p>
                  Receipt: <b>{receipt.receipt_number}</b>
                </p>
                <p>
                  Issued:{" "}
                  {new Date(
                    receipt.receipt_issued_at || receipt.received_at,
                  ).toLocaleString("en-NG")}
                </p>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <dt className="text-stone-500">Guest</dt>
                <dd className="font-medium">{receipt.guest_name || "Guest"}</dd>
              </div>
              <div>
                <dt className="text-stone-500">Room</dt>
                <dd className="font-medium">{receipt.room_number || "-"}</dd>
              </div>
              <div>
                <dt className="text-stone-500">Payment number</dt>
                <dd>{receipt.payment_number}</dd>
              </div>
              <div>
                <dt className="text-stone-500">Payment method</dt>
                <dd>{receipt.payment_method_name || "-"}</dd>
              </div>
              <div>
                <dt className="text-stone-500">Payment received</dt>
                <dd>{new Date(receipt.received_at).toLocaleString("en-NG")}</dd>
              </div>
              <div>
                <dt className="text-stone-500">Amount received</dt>
                <dd className="font-semibold">
                  {formatNaira(receipt.allocated_amount_kobo)}
                </dd>
              </div>
              {receipt.reference && (
                <div className="col-span-2">
                  <dt className="text-stone-500">Reference</dt>
                  <dd>{receipt.reference}</dd>
                </div>
              )}
            </dl>
            {receipt.receipt_voided_at && (
              <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                <p className="font-semibold">VOIDED</p>
                {receipt.void_reason && (
                  <p className="mt-1">Reason: {receipt.void_reason}</p>
                )}
              </div>
            )}
            {receipt.refunds.length > 0 && (
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                <p className="font-semibold">Refund record</p>
                {receipt.refunds.map((refund) => (
                  <p key={refund.id} className="mt-1">
                    {refund.refund_number}: {formatNaira(refund.amount_kobo)} -{" "}
                    {refund.reason}
                  </p>
                ))}
              </div>
            )}
            {receiptPrintMessage && (
              <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                {receiptPrintMessage}
              </p>
            )}
            <button
              type="button"
              onClick={printReceiptDocument}
              className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white"
              data-receipt-print-action
            >
              Print / Save as PDF
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}
