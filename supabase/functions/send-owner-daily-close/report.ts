type AmountRow = { department_code?: string; business?: string; total_amount_kobo?: number; collected_kobo?: number; refunded_kobo?: number; amount_kobo?: number };
type CloseSnapshot = {
  business_date: string; close_number: string; hotel?: { trading_name?: string };
  operations?: Record<string, number>;
  night_audit?: { status?: string; posts_created?: number };
  revenue_by_department?: AmountRow[];
  payments_by_method?: { payment_method_name: string; net_collected_kobo: number; pending_verification_kobo: number; refunded_kobo: number }[];
  cashier_shifts?: { shift_number: string; variance_kobo: number | null; status: string }[];
  corrections?: unknown[]; outstanding_folios?: { balance_kobo: number }[];
  acknowledgements?: { exception_code: string; record_count: number }[];
};
type Movements = {
  outlet_collections?: AmountRow[];
  paid_expenses?: AmountRow[];
  reconciliation_status?: string;
  self_reviews?: { action: string; record_count: number }[];
};

const money = (value: number) => new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" }).format(value / 100);
const number = (value: number | undefined) => value ?? 0;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export function buildOwnerDailyCloseEmail(snapshot: CloseSnapshot, movements: Movements) {
  const revenue = snapshot.revenue_by_department ?? [];
  const payments = snapshot.payments_by_method ?? [];
  const shifts = snapshot.cashier_shifts ?? [];
  const outstanding = snapshot.outstanding_folios ?? [];
  const ops = snapshot.operations ?? {};
  const lines = [
    `${snapshot.hotel?.trading_name ?? "Hotel"} — private business-day summary`,
    `Business date: ${snapshot.business_date}`,
    `Close record: ${snapshot.close_number}`,
    "",
    "HOTEL OPERATIONS",
    `Arrivals checked in: ${number(ops.checked_in_arrivals)}; departures checked out: ${number(ops.checked_out_departures)}; in-house at close: ${number(ops.in_house_at_close)}; no-shows: ${number(ops.no_shows)}.`,
    `Night-audit status: ${snapshot.night_audit?.status ?? "unknown"}; room posts: ${number(snapshot.night_audit?.posts_created)}.`,
    "",
    "HOTEL REVENUE POSTED (not cash received)",
    ...revenue.map((row) => `${row.department_code ?? "Unclassified"}: ${money(number(row.total_amount_kobo))}`),
    `Total posted: ${money(sum(revenue.map((row) => number(row.total_amount_kobo))))}`,
    "",
    "HOTEL PAYMENT MOVEMENT",
    ...payments.map((row) => `${row.payment_method_name}: net collected ${money(number(row.net_collected_kobo))}; refunds ${money(number(row.refunded_kobo))}; pending verification ${money(number(row.pending_verification_kobo))}`),
    "",
    "SEPARATE RESTAURANT AND BAR COLLECTIONS",
    ...(movements.outlet_collections ?? []).map((row) => `${row.business}: received ${money(number(row.collected_kobo))}; refunded ${money(number(row.refunded_kobo))}`),
    "These are separate businesses, not hotel room revenue.",
    "",
    "EXPENSES PAID ON THIS DATE (by business)",
    ...(movements.paid_expenses ?? []).map((row) => `${row.business}: ${money(number(row.amount_kobo))}`),
    `Internal reconciliation: ${movements.reconciliation_status ?? "unknown"}.`,
    "",
    "CONTROLS AND EXCEPTIONS",
    `Cashier shifts: ${shifts.length}; non-zero cash variances: ${shifts.filter((shift) => number(shift.variance_kobo ?? 0) !== 0).length}.`,
    `Folio corrections: ${(snapshot.corrections ?? []).length}; open folios with balance: ${outstanding.length}; balance outstanding: ${money(sum(outstanding.map((folio) => number(folio.balance_kobo))))}.`,
    `Management exception acknowledgements: ${(snapshot.acknowledgements ?? []).length}.`,
    ...(snapshot.acknowledgements ?? []).map((ack) => `${ack.exception_code}: ${ack.record_count} record(s)`),
    `Accountant self-reviews: ${sum((movements.self_reviews ?? []).map((item) => number(item.record_count)))}.`,
    ...(movements.self_reviews ?? []).map((item) => `${item.action}: ${item.record_count} self-reviewed record(s)`),
    "",
    "The close figures are the stored day-close snapshot. Separate-business movements and paid expenses reflect records at email send time; check the detailed registers before treating any amount as bank-settled. This message is confidential.",
  ];
  return { subject: `${snapshot.hotel?.trading_name ?? "Hotel"} private day-close summary — ${snapshot.business_date}`, text: lines.join("\n") };
}
