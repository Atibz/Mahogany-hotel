import { describe, expect, it } from "vitest";

import { buildAuditCsv } from "./audit-csv";

describe("audit CSV export", () => {
  it("contains exactly the supplied visible rows and safely quotes evidence", () => {
    const csv = buildAuditCsv([
      {
        log_id: "log-1",
        occurred_at: "2026-09-28T13:00:00Z",
        actor_id: "actor-1",
        actor_name: "Owner, Mahogany",
        action: "payment.created",
        entity_type: "payment",
        entity_id: "payment-1",
        metadata: { receipt_number: 'RCP-001 "copy"' },
        display_amount_kobo: 4_500_000,
        total_count: 1,
      },
    ]);

    expect(csv.split("\n")).toHaveLength(2);
    expect(csv).toContain('"Owner, Mahogany"');
    expect(csv).toContain('"45000.00"');
    expect(csv).toContain('""receipt_number""');
    expect(csv).toContain('\\""copy\\""');
    expect(csv).not.toContain("staff.invited");
  });

  it("neutralizes spreadsheet formulas in exported audit values", () => {
    const csv = buildAuditCsv([
      {
        log_id: "log-formula",
        occurred_at: "2026-09-28T13:00:00Z",
        actor_id: "actor-1",
        actor_name: "=HYPERLINK(\"https://example.invalid\")",
        action: "payment.created",
        entity_type: "payment",
        entity_id: "payment-1",
        metadata: { note: "safe" },
        display_amount_kobo: null,
        total_count: 1,
      },
    ]);

    expect(csv).toContain("'=HYPERLINK(");
  });
});
