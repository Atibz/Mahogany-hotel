import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const migration = readFileSync(
  join(projectRoot, "supabase", "migrations", "20261012190000_operating_expense_register.sql"),
  "utf8",
);
const reportMigration = readFileSync(
  join(projectRoot, "supabase", "migrations", "20261012200000_expense_summary_by_incurred_date.sql"),
  "utf8",
);

describe("operating expense register database contracts", () => {
  it("keeps expense records append-only and separated from payments, receipts, taxes, and folios", () => {
    expect(migration).toContain("create table public.operating_expenses");
    expect(migration).toContain("on delete restrict");
    expect(migration).toContain("revoke all on public.operating_expenses from public,anon,authenticated");
    expect(migration).toContain("grant select on public.operating_expenses to authenticated");
    expect(migration).not.toMatch(/\b(insert into|update|delete from)\s+public\.(payments|receipts|guest_folios|payment_allocations|tax_rules)\b/i);
    expect(migration).toMatch(/Record operating expenses for internal review without creating journal entries,[\s\S]*?paying funds, calculating tax/i);
  });

  it("requires separate GM review with a reason and prevents self-approval", () => {
    expect(migration).toContain("expenses.review");
    expect(migration).toContain("e.submitted_by=auth.uid()");
    expect(migration).toContain("A review note is required");
    expect(migration).toContain("reviewed_by is distinct from submitted_by");
  });

  it("keeps permissions limited to accountants for submission and GMs for review", () => {
    expect(migration).toMatch(/r\.code='general_manager' and p\.code in \('expenses.read','expenses.submit','expenses.review'\)/);
    expect(migration).toMatch(/r\.code='accountant' and p\.code in \('expenses.read','expenses.submit'\)/);
  });

  it("previously summarized expenses by their incurred date", () => {
    expect(reportMigration).toContain("e.incurred_on between from_date and to_date");
  });

});
