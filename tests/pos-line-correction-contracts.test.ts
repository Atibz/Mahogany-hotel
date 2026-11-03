import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const migration = readFileSync(
  join(root, "supabase", "migrations", "20261012250000_pos_paid_order_line_corrections.sql"),
  "utf8",
);
const posPage = readFileSync(join(root, "src", "features", "pos", "restaurant-pos-page.tsx"), "utf8");
const approvals = readFileSync(join(root, "src", "features", "reception", "financial-history-page.tsx"), "utf8");

describe("approved POS paid-line corrections", () => {
  it("stores corrections as separate immutable outlet-scoped records", () => {
    expect(migration).toContain("create table public.pos_order_line_corrections");
    expect(migration).toContain("approval_request_id uuid not null unique");
    expect(migration).toContain("public.has_pos_outlet_permission(hotel_id, outlet_id, 'read')");
    expect(migration).not.toMatch(/\b(insert into|update|delete from)\s+public\.(pos_order_lines|pos_order_payments|pos_order_receipts)\b/i);
    expect(migration).toContain("update public.pos_orders set status");
  });

  it("requires a paid order, a reason, an independent approval, and valid nonnegative totals", () => {
    expect(migration).toContain("A paid order is required before requesting a line correction");
    expect(migration).toContain("Only the independent approver may execute this POS line correction");
    expect(migration).toContain("A line correction cannot reduce that line below zero");
    expect(migration).toContain("Correction would reduce the sale below refunds already recorded");
    expect(migration).toContain("status in ('pending', 'approved') and expires_at > now()");
    expect(migration).toContain("when ''pos_order_line_correction'' then perform public.execute_approved_pos_order_line_correction(r.id)");
  });

  it("uses approved adjustments for payment balance and business-day gross sales", () => {
    expect(migration).toContain("public.pos_order_line_corrections c where c.order_id = target_order_id");
    expect(migration).toContain("public.pos_order_totals(o.id) t");
    expect(migration).toContain("create policy pos_order_line_corrections_read");
  });

  it("exposes an operator request flow and an approver-readable summary", () => {
    expect(posPage).toContain("request_pos_order_line_correction");
    expect(posPage).toContain("Request line correction");
    expect(posPage).toContain('name="explanation" required');
    expect(posPage).not.toContain('name="description" required');
    expect(posPage).toContain('reason_value: String(form.get("explanation") ?? "").trim()');
    expect(posPage).toContain('description_value: description');
    expect(posPage).toContain("Customer credit");
    expect(posPage).toContain("Payout needs separate refund approval");
    expect(approvals).toContain("pos_order_line_correction");
    expect(approvals).toContain("POS line correction");
  });
});
