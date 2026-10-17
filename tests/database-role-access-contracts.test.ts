import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationDirectory = join(projectRoot, "supabase", "migrations");
const readMigration = (file: string) =>
  readFileSync(join(migrationDirectory, file), "utf8");

const foundation = readMigration("20260920223000_foundation.sql");
const expense = readMigration("20261012190000_operating_expense_register.sql");
const internalBalancing = readMigration(
  "20261012270000_internal_collection_expense_summary.sql",
);
const inventory = readMigration(
  "20261012280000_inventory_suppliers_stock_ledger.sql",
);
const restaurantPos = readMigration("20261012160000_restaurant_pos_sales.sql");
const outletScope = readMigration("20261012180000_bar_pos_access_scope.sql");

describe("database role access contracts", () => {
  it("requires active hotel staff and grants implicit broad access only to Owners", () => {
    expect(foundation).toMatch(/public\.is_active_staff\(\) and exists/i);
    expect(foundation).toMatch(/r\.hotel_id\s*=\s*target_hotel_id/i);
    expect(foundation).toMatch(/r\.active\s*=\s*true/i);
    expect(foundation).toMatch(/r\.code\s*=\s*'owner' or p\.code\s*=\s*required_code/i);
  });

  it("keeps expense records read-only to clients and assigns GM review, not Accountant review", () => {
    expect(expense).toMatch(/r\.code='general_manager'[\s\S]*expenses\.review/i);
    expect(expense).toMatch(/r\.code='accountant'[\s\S]*expenses\.submit/i);
    expect(expense).not.toMatch(/r\.code='accountant'[^;]*expenses\.review/i);
    expect(expense).toMatch(/revoke all on public\.operating_expenses from public,anon,authenticated/i);
    expect(expense).toMatch(/grant select on public\.operating_expenses to authenticated/i);
    expect(expense).toMatch(/alter table public\.operating_expenses enable row level security/i);
    expect(expense).toMatch(/using \(public\.has_hotel_permission\(hotel_id,'expenses\.read'\)\)/i);
    expect(expense).toMatch(/has_hotel_permission\(e\.hotel_id,'expenses\.review'\)/i);
  });

  it("limits inventory data and stock mutations to permission-checked RPCs", () => {
    expect(inventory).toMatch(/r\.code in \('general_manager', 'storekeeper'\)/i);
    expect(inventory).toMatch(/alter table public\.inventory_movements enable row level security/i);
    expect(inventory).toMatch(/using \(public\.has_hotel_permission\(hotel_id, 'inventory\.read'\)\)/i);
    expect(inventory).toMatch(/if not public\.has_hotel_permission\(target_hotel_id, 'inventory\.manage'\)/i);
    expect(inventory).toMatch(/inventory movements are append-only/i);
    expect(inventory).toMatch(/revoke all on public\.inventory_locations,[\s\S]*from public, anon, authenticated/i);
  });

  it("separates POS operator access from broad GM/Accountant reporting access", () => {
    expect(restaurantPos).toMatch(/r\.code='general_manager'[\s\S]*pos\.sales\.read[\s\S]*pos\.sales\.create/i);
    expect(restaurantPos).toMatch(/r\.code='accountant'[\s\S]*pos\.sales\.read/i);
    expect(restaurantPos).toMatch(/alter table public\.pos_orders enable row level security/i);
    expect(outletScope).toMatch(/r\.code='restaurant_staff'[\s\S]*pos\.restaurant\.create/i);
    expect(outletScope).toMatch(/r\.code='bar_staff'[\s\S]*pos\.bar\.create/i);
    expect(outletScope).toMatch(/public\.has_pos_outlet_permission\(hotel_id,outlet_id,'read'\)/i);
    expect(outletScope).toMatch(/public\.has_pos_outlet_permission\(o\.hotel_id,o\.outlet_id,''create''\)/i);
  });

  it("requires finance, expense, and POS read permissions for internal balancing", () => {
    expect(internalBalancing).toMatch(/has_hotel_permission\(target_hotel_id, 'payments\.read'\)/i);
    expect(internalBalancing).toMatch(/has_hotel_permission\(target_hotel_id, 'expenses\.read'\)/i);
    expect(internalBalancing).toMatch(/has_hotel_permission\(target_hotel_id, 'pos\.sales\.read'\)/i);
    expect(internalBalancing).toMatch(/revoke all on function public\.get_internal_collection_expense_summary\(uuid, date, date\) from public, anon/i);
  });
});
