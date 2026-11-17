import { describe, expect, it } from "vitest";
import { buildOwnerDailyCloseEmail } from "../../../supabase/functions/send-owner-daily-close/report";

describe("private owner day-close summary", () => {
  it("keeps hotel revenue distinct from restaurant collections and expenses", () => {
    const report = buildOwnerDailyCloseEmail({
      hotel: { trading_name: "Mahogany Hotel" }, business_date: "2026-10-26", close_number: "DAC-001",
      operations: { checked_in_arrivals: 2, checked_out_departures: 1, in_house_at_close: 4, no_shows: 0 },
      night_audit: { status: "completed", posts_created: 4 },
      revenue_by_department: [{ department_code: "rooms", total_amount_kobo: 10000000 }],
      payments_by_method: [{ payment_method_name: "Cash", net_collected_kobo: 7000000, pending_verification_kobo: 0, refunded_kobo: 0 }],
      cashier_shifts: [{ shift_number: "CS-1", status: "closed", variance_kobo: 5000 }],
      corrections: [{}], outstanding_folios: [{ balance_kobo: 3000000 }], acknowledgements: [],
    }, {
      outlet_collections: [{ business: "restaurant", collected_kobo: 5000000 }],
      paid_expenses: [{ business: "hotel", amount_kobo: 2000000 }], reconciliation_status: "approved",
      self_reviews: [{ action: "expense.approved", record_count: 2 }],
    });
    expect(report.subject).toContain("2026-10-26");
    expect(report.text).toContain("HOTEL REVENUE POSTED (not cash received)");
    expect(report.text).toContain("SEPARATE RESTAURANT AND BAR COLLECTIONS");
    expect(report.text).toContain("EXPENSES PAID ON THIS DATE (by business)");
    expect(report.text).toContain("non-zero cash variances: 1");
    expect(report.text).toContain("These are separate businesses, not hotel room revenue.");
    expect(report.text).toContain("Accountant self-reviews: 2");
    expect(report.text).not.toContain("guest_name");
  });
});
