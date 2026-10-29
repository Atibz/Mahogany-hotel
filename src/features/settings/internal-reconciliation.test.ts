import { describe, expect, it } from "vitest";
import { buildReconciliationCsv, expectedClosing, parseReconciliationAmount, reconciliationAmountInput, sameReconciliationSource, type FundingAccount, type ReconciliationSource } from "./internal-reconciliation";

const account: FundingAccount = { id: "drawer", department: "hotel", payment_method_id: "cash", name: "Hotel drawer", method_name: "Cash", method_code: "cash", collections_kobo: 100000, refunds_kobo: 3000, expenses_kobo: 12000, movements_kobo: -5000, previous_closing_kobo: null };
const source: ReconciliationSource = { business_date: "2026-10-20", accounts: [account], events: [], expenses: [], movements: [], shifts: [], blockers: { pending_payments: 0 } };

describe("internal reconciliation amounts and evidence", () => {
  it("calculates expected closing without adding shift floats or treating it as profit", () => {
    expect(expectedClosing(account, 10000)).toBe(90000);
    expect(expectedClosing({ ...account, movements_kobo: 5000 }, 10000)).toBe(100000);
  });

  it.each([["0", 0], ["0.01", 1], ["12.3", 1230], [" 100.25 ", 10025], ["90071992547409.91", Number.MAX_SAFE_INTEGER]])("parses %s as exact kobo", (input, expected) => {
    expect(parseReconciliationAmount(input)).toBe(expected);
  });

  it.each(["", "-1", "1.234", "1e3", "NaN", "Infinity", "1,000", "0x10", "90071992547409.92"])("rejects ambiguous, rounded, or unsafe amount %s", (input) => {
    expect(() => parseReconciliationAmount(input)).toThrow();
  });

  it("detects changed evidence despite unchanged totals and ignores JSON object key order", () => {
    const reordered = Object.fromEntries(Object.entries(source).reverse()) as ReconciliationSource;
    expect(sameReconciliationSource(source, reordered)).toBe(true);
    expect(sameReconciliationSource(source, { ...source, accounts: [{ ...account, name: "Changed evidence" }] })).toBe(false);
  });

  it("exports source records, signed figures, reviewer evidence, and escaped spreadsheet formulas", () => {
    const csv = buildReconciliationCsv({ ...source, accounts: [{ ...account, name: '=HYPERLINK("unsafe")' }], events: [{ id: "payment", kind: "payment", department: "hotel", payment_method_id: "cash", reference: "PAY-1", evidence: 'Line 1\n"Quoted"', amount_kobo: 100000, status: "completed", occurred_at: "2026-10-20T12:00:00Z" }] }, {
      id: "signed", business_date: source.business_date, status: "approved", source_snapshot: source,
      declarations: [{ account_id: "drawer", opening_kobo: 10000, closing_kobo: 89900, expected_kobo: 90000, variance_kobo: -100, variance_note: "Explained", evidence_reference: "COUNT-1" }],
      submitted_by: "accountant", submitted_at: "2026-10-20T17:00:00Z", reviewed_by: "manager", reviewed_at: "2026-10-20T18:00:00Z", review_note: "Checked", exception_note: "Investigated",
    });
    expect(csv).toContain('"Reviewed by","manager"');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('"100.00","1000.00","30.00","120.00","\'-50.00","900.00","899.00","\'-1.00"');
    expect(csv).toContain('Line 1\n""Quoted""');
    expect(csv).toContain('"COUNT-1","Explained"');
  });

  it("rejects calculations outside integer precision", () => {
    expect(() => expectedClosing(account, Number.MAX_SAFE_INTEGER)).toThrow(/precision/);
    expect(() => expectedClosing({ ...account, collections_kobo: 0.5 }, 0)).toThrow(/precision/);
  });

  it("preserves cents when carrying forward and exporting the largest supported balance", () => {
    expect(reconciliationAmountInput(Number.MAX_SAFE_INTEGER)).toBe("90071992547409.91");
    expect(parseReconciliationAmount(reconciliationAmountInput(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(reconciliationAmountInput(-1)).toBe("-0.01");
  });
});
