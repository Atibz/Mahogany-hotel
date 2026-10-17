import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const migration = readFileSync(
  join(projectRoot, "supabase", "migrations", "20261012220000_pos_payment_refunds.sql"),
  "utf8",
);
const followUpMigration = readFileSync(
  join(projectRoot, "supabase", "migrations", "20261012230000_pos_refund_expiry_and_report_grouping.sql"),
  "utf8",
);
const orderingMigration = readFileSync(
  join(projectRoot, "supabase", "migrations", "20261012240000_pos_refund_summary_ordering_fix.sql"),
  "utf8",
);
const posPage = readFileSync(
  join(projectRoot, "src", "features", "pos", "restaurant-pos-page.tsx"),
  "utf8",
);
const approvalPage = readFileSync(
  join(projectRoot, "src", "features", "reception", "financial-history-page.tsx"),
  "utf8",
);

describe("POS refund controls", () => {
  it("preserves the sale and records an append-only outlet-scoped refund", () => {
    expect(migration).toContain("create table public.pos_order_refunds");
    expect(migration).toContain("approval_request_id uuid not null unique");
    expect(migration).toContain("public.pos_order_payments(id, hotel_id, outlet_id)");
    expect(migration).toContain("public.has_pos_outlet_permission(hotel_id, outlet_id, 'read')");
    expect(migration).toMatch(/revoke all on public\.pos_order_refunds from public, anon, authenticated/i);
    expect(migration).not.toMatch(/\b(insert into|update|delete from)\s+public\.(payments|receipts|guest_folios|payment_allocations)\b/i);
  });

  it("requires a reason, prevents over-refunding, and reserves pending/approved requests", () => {
    expect(migration).toContain("A refund reason is required");
    expect(migration).toContain("status in ('pending', 'approved')");
    expect(migration).toContain("Refund exceeds the remaining refundable POS payment amount");
    expect(migration).toContain("Only completed POS payments can be refunded");
    expect(followUpMigration).toContain("and expires_at > now()");
  });

  it("routes execution through independent approval and corrects the actual cash shift", () => {
    expect(migration).toContain("Only the independent approver may execute this POS refund");
    expect(migration).toContain("execute_approved_pos_payment_refund(r.id)");
    expect(migration).toContain("public.pos_order_refunds pr where pr.cashier_shift_id=s.id");
    expect(migration).toContain("A reference is required for non-cash POS refunds");
    expect(migration).toContain("Open your outlet cash shift before recording a cash refund");
    expect(migration).toMatch(/revoke all on function public\.execute_approved_pos_payment_refund\(uuid\) from public, anon, authenticated/i);
  });

  it("shows refunds separately in POS history and approval review", () => {
    expect(posPage).toContain("Request refund");
    expect(posPage).toContain("request_pos_payment_refund");
    expect(posPage).toContain("get_pos_refund_sales_summary");
    expect(posPage).toContain("Refunds recorded");
    expect(followUpMigration).toContain("max(f.outlet_name)");
    expect(orderingMigration).toContain("order by f.business_date desc, f.outlet_id");
    expect(approvalPage).toContain("Requested POS refund:");
  });
});
