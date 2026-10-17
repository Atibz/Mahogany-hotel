import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const migration = readFileSync(join(root, "supabase", "migrations", "20261012160000_restaurant_pos_sales.sql"), "utf8");
const receiptReferenceMigration = readFileSync(join(root, "supabase", "migrations", "20261012170000_restaurant_pos_receipt_reference_clarity.sql"), "utf8");
const barScopeMigration = readFileSync(join(root, "supabase", "migrations", "20261012180000_bar_pos_access_scope.sql"), "utf8");
const page = readFileSync(join(root, "src", "features", "pos", "restaurant-pos-page.tsx"), "utf8");

describe("restaurant POS separation and controls", () => {
  it("uses an outlet-specific order, payment, and receipt ledger instead of hotel folios", () => {
    expect(migration).toContain("create table public.pos_orders");
    expect(migration).toContain("create table public.pos_order_payments");
    expect(migration).toContain("create table public.pos_order_receipts");
    expect(migration).not.toMatch(/\bpublic\.(?:payments|payment_allocations|guest_folios|receipts)\b/i);
    expect(migration).toContain("'pos.restaurant_payment_recorded'");
    expect(migration).toContain("'pos.restaurant_order_opened'");
  });

  it("snapshots department, outlet, menu item, and effective price on records", () => {
    expect(migration).toContain("department_code_snapshot text not null");
    expect(migration).toContain("outlet_name_snapshot text not null");
    expect(migration).toContain("item_name_snapshot text not null");
    expect(migration).toContain("effective_from<=o.business_date");
  });

  it("requires a separate restaurant cash shift and independent verification for non-cash methods", () => {
    expect(migration).toContain("create table public.pos_cashier_shifts");
    expect(migration).toContain("Open your restaurant cash shift before receiving cash");
    expect(migration).toContain("pending_verification");
    expect(migration).toContain("create or replace function public.verify_restaurant_pos_payment");
    expect(migration).toContain("create or replace function public.reject_restaurant_pos_payment");
  });

  it("keeps statutory tax handling explicitly out of the new POS workflow", () => {
    expect(migration).not.toMatch(/\bpublic\.tax_rules\b/i);
    expect(page).toContain("Tax is not calculated here");
    expect(page.toLowerCase()).toContain("not a tax invoice or statutory receipt");
    expect(page.toLowerCase()).toContain("nothing here posts to hotel-room revenue");
    expect(page).not.toContain("FBR documents");
    expect(receiptReferenceMigration).toContain("'''POSR'''");
    expect(receiptReferenceMigration).toContain("public.record_restaurant_pos_payment(uuid,uuid,bigint,text)");
    expect(receiptReferenceMigration).toContain("public.verify_restaurant_pos_payment(uuid,text)");
  });

  it("gives restaurant staff sales operations, accountant review, and no bar catalog access", () => {
    expect(migration).toContain("r.code='restaurant_staff' and p.code in ('pos.sales.read','pos.sales.create')");
    expect(migration).toContain("r.code='accountant' and p.code in ('pos.sales.read','pos.payments.verify')");
    expect(migration).toContain("outlet_type='restaurant'");
    expect(migration).toContain("public.has_hotel_permission(hotel_id,'pos.sales.read')");
  });

  it("keeps restaurant and bar staff inside their own outlet type", () => {
    expect(barScopeMigration).toContain("('pos.restaurant.read'");
    expect(barScopeMigration).toContain("('pos.bar.read'");
    expect(barScopeMigration).toContain("r.code='restaurant_staff' and p.code in ('pos.restaurant.read','pos.restaurant.create')");
    expect(barScopeMigration).toContain("r.code='bar_staff' and p.code in ('pos.bar.read','pos.bar.create')");
    expect(barScopeMigration).toContain("public.has_pos_outlet_permission(hotel_id,outlet_id,'read')");
    expect(barScopeMigration).toContain("outlet_type in (''restaurant'',''bar'')");
    expect(barScopeMigration).toContain("public.has_pos_outlet_permission(o.hotel_id,o.outlet_id,''read'')");
    expect(page).toContain('eq("outlet_type", outletType)');
    expect(page).toContain('outletType === "bar" ? "bar_staff" : "restaurant_staff"');
  });

  it("keeps shared POS labels and daily summaries scoped to the active outlet type", () => {
    expect(page).toContain("Record {departmentName.toLowerCase()} payment");
    expect(page).toContain("your {departmentName.toLowerCase()} cash shift");
    expect(page).toContain("row.department_code === outletType");
    expect(page).toContain("flow.department_code === outletType");
    expect(page).toContain('title={`${receipt.department_code_snapshot === "bar" ? "Bar" : "Restaurant"} POS payment record`}');
    expect(page).not.toContain("Record restaurant payment");
    expect(page).not.toContain("your restaurant cash shift to be open");
  });
});
