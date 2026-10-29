import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyReconciliation as DailyData, ReconciliationRecord } from "./internal-reconciliation";

const harness = vi.hoisted(() => ({ data: undefined as DailyData | undefined, roles: ["accountant"], user: "accountant", error: null as Error | null }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: harness.data, error: harness.error, isLoading: false, isFetching: false, refetch: vi.fn() }), useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@/features/auth/use-access", () => ({ useAccess: () => ({ roleCodes: harness.roles, isLoading: false, error: null }) }));
vi.mock("@/features/auth/auth-provider", () => ({ useAuth: () => ({ session: { user: { id: harness.user } } }) }));
vi.mock("@/lib/supabase/client", () => ({ supabase: { rpc: vi.fn() } }));
import { DailyReconciliation } from "./daily-reconciliation";

const base = (): DailyData => ({ current_business_date: "2026-10-20", source: {
  business_date: "2026-10-19", accounts: [{ id: "drawer", department: "hotel", payment_method_id: "cash", name: "Hotel drawer", method_name: "Cash", method_code: "cash", collections_kobo: 100000, refunds_kobo: 0, expenses_kobo: 0, movements_kobo: 0, previous_closing_kobo: null }],
  events: [], expenses: [], movements: [], shifts: [], blockers: { pending_payments: 0, unmapped_payments: 0, unfunded_expenses: 0, pending_expenses: 0, open_shifts: 0, unreviewed_hotel_shifts: 0 },
}, history: [], payment_methods: [{ id: "cash", name: "Cash" }] });
function signed(status: ReconciliationRecord["status"] = "submitted"): ReconciliationRecord {
  return { id: "record", business_date: "2026-10-19", status, source_snapshot: structuredClone(harness.data!.source),
    declarations: [{ account_id: "drawer", opening_kobo: 10000, closing_kobo: 110000, expected_kobo: 110000, variance_kobo: 0, variance_note: "", evidence_reference: "Count sheet" }], exception_note: "", submitted_by: "accountant", submitted_at: "2026-10-19T18:00:00Z", reviewed_by: null, reviewed_at: null, review_note: null };
}
function render() { return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DailyReconciliation, { hotelId: "hotel" }))); }
beforeEach(() => { harness.data = base(); harness.roles = ["accountant"]; harness.user = "accountant"; harness.error = null; });

describe("daily reconciliation interface", () => {
  it("renders account evidence, date controls, and working source route destinations", () => {
    const html = render();
    expect(html).toContain('value="2026-10-19"');
    expect(html).toContain('href="/payments"');
    expect(html).toContain('href="/expenses"');
    expect(html).toContain("Submit for independent review");
    expect(html).toContain("Hotel drawer");
    expect(html).toContain("Create funding account");
    expect(html).not.toContain("Approve snapshot");
  });

  it("shows frozen submission balances and disables self-review", () => {
    harness.data!.history = [signed()]; harness.roles = ["general_manager"];
    const html = render();
    expect(html).toContain('value="1100.00"');
    expect(html).toContain("Count sheet");
    expect(html).toContain('<fieldset disabled=""');
    expect(html).toContain("Approve snapshot");
    expect(html).not.toContain("Submit for independent review");
    expect(html).not.toContain("Create funding account");
  });

  it("flags source changes while preserving the signed figures", () => {
    harness.data!.history = [signed("approved")];
    harness.data!.source.accounts[0].collections_kobo = 200000;
    const html = render();
    expect(html).toContain("Source records have changed since this snapshot");
    expect(html).toContain("signed snapshot remains preserved");
    expect(html).toContain('value="1100.00"');
  });

  it("retains date and refresh controls when loading fails", () => {
    harness.data = undefined; harness.error = new Error("Report unavailable");
    const html = render();
    expect(html).toContain("Report unavailable");
    expect(html).toContain('aria-label="Daily reconciliation business date"');
    expect(html).toContain('aria-label="Refresh daily reconciliation"');
  });

  it("renders a clear setup state without accounts", () => {
    harness.data!.source.accounts = [];
    expect(render()).toContain("Set up the funding accounts below to begin");
  });
});
