export type Department = "hotel" | "restaurant" | "bar";
export const departmentNames: Record<Department, string> = { hotel: "Hotel", restaurant: "Restaurant", bar: "Bar" };

export type FundingAccount = {
  id: string; department: Department; payment_method_id: string; name: string; method_name: string; method_code: string;
  collections_kobo: number; refunds_kobo: number; expenses_kobo: number; movements_kobo: number; previous_closing_kobo: number | null;
};
export type CollectionEvent = {
  id: string; kind: "payment" | "refund"; department: Department; payment_method_id: string;
  reference: string; evidence: string | null; amount_kobo: number; status: string; occurred_at: string;
};
export type FundedExpense = {
  id: string; expense_number: string; department: Department; amount_kobo: number; status: string;
  description: string; payee: string; incurred_on: string; paid_via: string; evidence_reference: string | null;
  review_note: string | null; account_id: string | null; paid_on: string | null; funding_reference: string | null;
};
export type FundMovement = {
  id: string; account_id: string; amount_kobo: number; evidence_reference: string; reason: string; recorded_by: string; recorded_at: string;
};
export type ShiftEvidence = {
  id: string; department: Department; shift_number: string; business_date: string; status: string;
  opening_float_kobo: number; expected_cash_kobo: number | null; declared_cash_kobo: number | null;
  variance_kobo: number | null; variance_reason: string | null; handover_reference: string | null; reviewed_at: string | null;
};
export type ReconciliationSource = {
  business_date: string; accounts: FundingAccount[]; events: CollectionEvent[]; expenses: FundedExpense[];
  movements: FundMovement[]; shifts: ShiftEvidence[]; blockers: Record<string, number>;
  hotel_collected_for_outlets_kobo?: number;
};
export type AccountDeclaration = {
  account_id: string; opening_kobo: number; closing_kobo: number; evidence_reference: string; variance_note: string;
  expected_kobo?: number; variance_kobo?: number;
};
export type ReconciliationRecord = {
  id: string; business_date: string; status: "submitted" | "approved" | "rejected";
  source_snapshot: ReconciliationSource; declarations: AccountDeclaration[]; exception_note: string;
  submitted_by: string; submitted_at: string; reviewed_by: string | null; reviewed_at: string | null; review_note: string | null;
};
export type DailyReconciliation = {
  current_business_date: string; source: ReconciliationSource; history: ReconciliationRecord[];
  payment_methods: { id: string; name: string }[];
};

// Parse decimal input exactly; silently rounding a third decimal can hide a variance.
export function parseReconciliationAmount(value: string): number {
  const normalized = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) throw new Error("Enter a non-negative amount with at most two decimal places.");
  const [whole, fractional = ""] = normalized.split(".");
  const kobo = BigInt(whole) * 100n + BigInt(fractional.padEnd(2, "0"));
  if (kobo > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount exceeds supported precision.");
  return Number(kobo);
}

export function reconciliationAmountInput(kobo: number): string {
  if (!Number.isSafeInteger(kobo)) throw new Error("Amount exceeds supported precision.");
  const value = BigInt(kobo); const magnitude = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}

export function expectedClosing(account: FundingAccount, openingKobo: number): number {
  const amounts = [openingKobo, account.collections_kobo, account.refunds_kobo, account.expenses_kobo, account.movements_kobo];
  if (!amounts.every(Number.isSafeInteger)) throw new Error("Amount exceeds supported precision.");
  const result = BigInt(openingKobo) + BigInt(account.collections_kobo) - BigInt(account.refunds_kobo)
    - BigInt(account.expenses_kobo) + BigInt(account.movements_kobo);
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("Amount exceeds supported precision.");
  return Number(result);
}

export function sameReconciliationSource(a: ReconciliationSource, b: ReconciliationSource): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => [k, canonical(v)]));
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@\t\r\n]/.test(text.trimStart())) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildReconciliationCsv(source: ReconciliationSource, record?: ReconciliationRecord) {
  const rows: unknown[][] = [
    ["Business date", source.business_date], ["Status", record?.status ?? "Live preview"],
    ["Submission ID", record?.id], ["Submitted by", record?.submitted_by], ["Submitted at", record?.submitted_at],
    ["Reviewed by", record?.reviewed_by], ["Reviewed at", record?.reviewed_at], ["Review note", record?.review_note],
    ["Exception note", record?.exception_note], [],
    ["Department", "Account", "Method", "Opening NGN", "Collections NGN", "Refunds NGN", "Paid expenses NGN", "Other movements NGN", "Expected NGN", "Actual closing NGN", "Variance NGN", "Evidence", "Variance note"],
  ];
  const money = (value: number | null | undefined) => value == null ? "" : reconciliationAmountInput(value);
  for (const a of source.accounts) {
    const d = record?.declarations.find((item) => item.account_id === a.id);
    rows.push([departmentNames[a.department], a.name, a.method_name, money(d?.opening_kobo), money(a.collections_kobo), money(a.refunds_kobo),
      money(a.expenses_kobo), money(a.movements_kobo), money(d?.expected_kobo), money(d?.closing_kobo), money(d?.variance_kobo), d?.evidence_reference, d?.variance_note]);
  }
  rows.push([], ["Source type", "ID", "Department / Account", "Reference", "Evidence", "Amount NGN", "Status / Reason", "Date"]);
  for (const e of source.events) rows.push([e.kind, e.id, departmentNames[e.department], e.reference, e.evidence, money(e.amount_kobo), e.status, e.occurred_at]);
  for (const e of source.expenses) rows.push(["expense", e.id, departmentNames[e.department], e.expense_number, e.funding_reference ?? e.evidence_reference, money(e.amount_kobo), e.status, e.paid_on ?? "Payment date unassigned"]);
  for (const m of source.movements) rows.push(["movement", m.id, m.account_id, m.evidence_reference, m.reason, money(m.amount_kobo), "", source.business_date]);
  rows.push([], ["Shift ID", "Department", "Shift", "Date", "Status", "Opening float NGN", "Expected NGN", "Counted NGN", "Variance NGN", "Variance reason", "Handover", "Reviewed at"]);
  for (const s of source.shifts) rows.push([s.id, departmentNames[s.department], s.shift_number, s.business_date, s.status, money(s.opening_float_kobo), money(s.expected_cash_kobo), money(s.declared_cash_kobo), money(s.variance_kobo), s.variance_reason, s.handover_reference, s.reviewed_at]);
  rows.push([], ["Blocker", "Count"], ...Object.entries(source.blockers));
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
