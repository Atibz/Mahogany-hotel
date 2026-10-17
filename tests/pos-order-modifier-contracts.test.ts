import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const migration = readFileSync(
  join(projectRoot, "supabase", "migrations", "20261012210000_pos_order_modifiers.sql"),
  "utf8",
);
const posPage = readFileSync(
  join(projectRoot, "src", "features", "pos", "restaurant-pos-page.tsx"),
  "utf8",
);

describe("POS order modifier controls", () => {
  it("snapshots option names and price deltas without changing old line values", () => {
    expect(migration).toContain("base_unit_price_kobo");
    expect(migration).toContain("update public.pos_order_lines");
    expect(migration).toContain("group_name_snapshot");
    expect(migration).toContain("option_name_snapshot");
    expect(migration).toContain("price_delta_kobo");
    expect(migration).toContain("unit_price_kobo");
  });

  it("enforces outlet scope and assigned active groups, options, and selection counts in the database", () => {
    expect(migration).toContain("public.has_pos_outlet_permission(order_record.hotel_id, order_record.outlet_id, 'create')");
    expect(migration).toContain("assignment.active");
    expect(migration).toContain("mo.active and mg.active");
    expect(migration).toContain("group_record.selected_count < group_record.min_selections");
    expect(migration).toContain("group_record.selected_count > group_record.max_selections");
    expect(migration).toContain("One or more selected options are unavailable for this menu item");
  });

  it("includes modifier deltas in the POS line amount while leaving hotel ledgers untouched", () => {
    expect(migration).toContain("final_unit_price := base_price + modifier_total");
    expect(migration).toContain("base_unit_price_kobo, unit_price_kobo, quantity");
    expect(migration).not.toMatch(/\b(insert into|update|delete from)\s+public\.(payments|receipts|guest_folios|payment_allocations|tax_rules)\b/i);
  });

  it("keeps old add-item calls behind the same new validation and exposes options in the POS UI", () => {
    expect(migration).toContain("public.add_restaurant_pos_order_item_with_modifiers(");
    expect(migration).toContain("target_order_id, target_menu_item_id, item_quantity, '{}'::uuid[]");
    expect(posPage).toContain("Choose options");
    expect(posPage).toContain("group.min_selections");
    expect(posPage).toContain("pos_order_line_modifiers");
    expect(posPage).toContain("group_name_snapshot");
  });
});
