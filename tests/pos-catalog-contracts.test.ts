import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const migration = readFileSync(
  join(projectRoot, "supabase", "migrations", "20261012120000_shared_pos_catalog.sql"),
  "utf8",
);
const maintenanceMigration = readFileSync(
  join(projectRoot, "supabase", "migrations", "20261012140000_pos_catalog_maintenance_controls.sql"),
  "utf8",
);
const assignmentMigration = readFileSync(
  join(projectRoot, "supabase", "migrations", "20261012150000_pos_modifier_assignment_soft_retirement.sql"),
  "utf8",
);

describe("shared POS catalog database contracts", () => {
  it("keeps outlet catalog data hotel- and department-scoped", () => {
    expect(migration).toMatch(/unique\s*\(hotel_id,\s*code\)/i);
    expect(migration).toMatch(/foreign key\s*\(hotel_id, department_code\)[\s\S]*?references public\.departments\(hotel_id, code\)/i);
    expect(migration).toContain("outlet_type in ('restaurant', 'bar')");
  });

  it("stores menu price changes as effective-dated versions and blocks backdating", () => {
    expect(migration).toMatch(/unique\s*\(menu_item_id, effective_from\)/i);
    expect(migration).toContain("amount_kobo bigint not null check (amount_kobo > 0)");
    expect(migration).toContain("Menu prices cannot be backdated");
    expect(migration).toContain("create or replace function public.set_pos_menu_item_price");
  });

  it("routes catalog writes through GM-authorized audited functions only", () => {
    expect(migration).toMatch(/r\.code = 'general_manager'[\s\S]*?pos\.catalog\.manage/i);
    expect(migration).toMatch(/revoke all on public\.pos_outlets[\s\S]*?from public, anon, authenticated/i);
    expect(migration).toMatch(/grant execute on function public\.create_pos_outlet[\s\S]*?to authenticated/i);
    expect(migration).toContain("public.has_hotel_permission(target_hotel_id, 'pos.catalog.manage')");
    expect(migration).toContain("public.log_activity(target_hotel_id, 'pos.outlet_created'");
  });

  it("prevents assigning modifier groups across outlets", () => {
    expect(migration).toContain("Choose an active modifier group from the same outlet");
    expect(migration).toMatch(/where id = target_modifier_group_id and outlet_id = item_record\.outlet_id and hotel_id = item_record\.hotel_id and active/i);
    expect(migration).toContain("create table public.pos_menu_item_modifier_groups");
  });

  it("requires authorization, a reason, and an audit event for catalog maintenance", () => {
    expect(maintenanceMigration).toContain("public.has_hotel_permission(outlet_record.hotel_id, 'pos.catalog.manage')");
    expect(maintenanceMigration).toContain("A reason is required for catalog changes");
    expect(maintenanceMigration).toContain("'pos.outlet_updated'");
    expect(maintenanceMigration).toContain("'pos.menu_item_updated'");
    expect(maintenanceMigration).toContain("'pos.menu_item_retired'");
    expect(maintenanceMigration).toContain("revoke all on function public.update_pos_outlet");
    expect(maintenanceMigration).toContain("grant execute on function public.update_pos_outlet");
    expect(maintenanceMigration).not.toMatch(/delete\s+from\s+public\.pos_(?:outlets|menu_categories|menu_items|menu_item_prices|modifier_groups|modifier_options)/i);
  });

  it("preserves modifier assignment history when a group is detached", () => {
    expect(assignmentMigration).toContain("active boolean not null default true");
    expect(assignmentMigration).toMatch(/update public\.pos_menu_item_modifier_groups[\s\S]*?set active = false/i);
    expect(assignmentMigration).toMatch(/on conflict \(menu_item_id, modifier_group_id\)\s+do update set active = true/i);
    expect(assignmentMigration).toContain("'pos.modifier_group_unassigned'");
    expect(assignmentMigration).not.toMatch(/delete\s+from\s+public\.pos_menu_item_modifier_groups/i);
  });
});
