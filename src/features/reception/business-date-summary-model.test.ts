import { describe, expect, it } from "vitest";
import { buildOutletSummary } from "./business-date-summary-model";

describe("business-date outlet summary", () => {
  it("keeps each outlet separate and does not add sales to collections", () => {
    const rows = buildOutletSummary(
      [
        { outlet_id: "restaurant", outlet_name: "6393 Restaurant", department_code: "restaurant", gross_sales_kobo: 50_000, pending_kobo: 2_000, open_balance_kobo: 8_000 },
        { outlet_id: "bar", outlet_name: "Gemini Bar", department_code: "bar", gross_sales_kobo: 20_000, pending_kobo: 0, open_balance_kobo: 0 },
      ],
      [
        { outlet_id: "restaurant", outlet_name: "6393 Restaurant", department_code: "restaurant", payments_received_kobo: 30_000, refunds_kobo: 5_000, net_collected_kobo: 25_000 },
        { outlet_id: "bar", outlet_name: "Gemini Bar", department_code: "bar", payments_received_kobo: 20_000, refunds_kobo: 0, net_collected_kobo: 20_000 },
      ],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sales: 50_000, received: 30_000, refunds: 5_000, netCollected: 25_000 });
    expect(rows[1]).toMatchObject({ sales: 20_000, netCollected: 20_000 });
  });

  it("shows collections made today for orders from another date", () => {
    expect(buildOutletSummary([], [
      { outlet_id: "restaurant", outlet_name: "6393 Restaurant", department_code: "restaurant", payments_received_kobo: 10_000, refunds_kobo: 0, net_collected_kobo: 10_000 },
    ])).toMatchObject([{ sales: 0, netCollected: 10_000 }]);
  });
});
