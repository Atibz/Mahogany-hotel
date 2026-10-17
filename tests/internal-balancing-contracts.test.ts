import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const migration = readFileSync(join(root, "supabase", "migrations", "20261012270000_internal_collection_expense_summary.sql"), "utf8");
const page = readFileSync(join(root, "src", "features", "settings", "internal-balancing-page.tsx"), "utf8");

describe("internal collections and expense balancing contracts", () => {
  it("keeps Hotel, Restaurant, and Bar in separate source-ledger rows", () => {
    expect(migration).toContain("values ('hotel'::text), ('restaurant'::text), ('bar'::text)");
    expect(migration).toContain("from public.payments p");
    expect(migration).toContain("from public.pos_order_payments p");
    expect(migration).toContain("from public.payment_refunds pr");
    expect(migration).toContain("from public.pos_order_refunds r");
    expect(migration).toContain("public.operating_expenses e");
  });

  it("limits the summary to finance readers and does not create journal, payment, or tax entries", () => {
    expect(migration).toContain("'payments.read'");
    expect(migration).toContain("'expenses.read'");
    expect(migration).toContain("'pos.sales.read'");
    expect(migration).toContain("revoke all on function public.get_internal_collection_expense_summary");
    expect(migration).not.toMatch(/\b(insert into|update|delete from)\s+public\.(payments|receipts|guest_folios|payment_allocations|tax_rules)\b/i);
  });

  it("shows refunds and expense review states separately without calculating a post-expense net", () => {
    expect(migration).toContain("approved_expenses_kobo");
    expect(migration).toContain("pending_review_expenses_kobo");
    expect(migration).toContain("rejected_expenses_kobo");
    expect(page).toContain("Separate ledgers; no automatic netting");
    expect(page).toContain("A difference here is not profit");
    expect(page).not.toContain("totalNetCollections - totalExpenses");
  });
});
