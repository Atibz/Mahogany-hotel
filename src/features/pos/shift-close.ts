type ShiftCashEntry = { cashier_shift_id: string; amount_kobo: number; payment_method_id: string };
type ShiftCashRefund = { cashier_shift_id: string; amount_kobo: number };

export function expectedPosShiftCash(
  shift: { id: string; opening_float_kobo: number },
  cashMethodIds: readonly string[],
  payments: readonly ShiftCashEntry[],
  refunds: readonly ShiftCashRefund[],
) {
  const cashMethods = new Set(cashMethodIds);
  const received = payments
    .filter((payment) => payment.cashier_shift_id === shift.id && cashMethods.has(payment.payment_method_id))
    .reduce((sum, payment) => sum + Number(payment.amount_kobo), 0);
  const returned = refunds
    .filter((refund) => refund.cashier_shift_id === shift.id)
    .reduce((sum, refund) => sum + Number(refund.amount_kobo), 0);
  return {
    opening: Number(shift.opening_float_kobo),
    received,
    returned,
    expected: Number(shift.opening_float_kobo) + received - returned,
  };
}

export function posActionErrorMessage(caught: unknown) {
  if (caught instanceof Error && caught.message.trim()) return caught.message;
  if (caught && typeof caught === "object" && "message" in caught) {
    const message = caught.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "The POS action could not be completed. Check your connection and try again.";
}
