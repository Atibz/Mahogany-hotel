import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const migration = readFileSync(
  join(
    projectRoot,
    "supabase",
    "migrations",
    "20261012130000_approval_gated_night_audit.sql",
  ),
  "utf8",
);

describe("approval-gated night audit contracts", () => {
  it("requires independent approval before a staff-run audit", () => {
    expect(migration).toContain("create table public.night_audit_approvals");
    expect(migration).toContain("check (executed_by is null or executed_by <> approved_by)");
    expect(migration).toContain("public.has_hotel_permission(target_hotel_id, 'night_audit.approve')");
    expect(migration).toContain("public.has_hotel_permission(target_hotel_id, 'night_audit.run')");
    expect(migration).toContain("The person who approved night audit cannot execute it");
    expect(migration).toContain("for update;");
  });

  it("grants accountant/manager approval and receptionist execution, not cashier execution", () => {
    expect(migration).toContain("p.code = 'night_audit.approve' and r.code in ('general_manager', 'accountant')");
    expect(migration).toContain("p.code = 'night_audit.run' and r.code in ('general_manager', 'receptionist')");
    expect(migration).toContain("and p.code = 'night_audit.run';");
  });

  it("removes unattended posting and makes accidental dispatcher calls fail visibly", () => {
    expect(migration).toContain("cron.unschedule(scheduled_job_id)");
    expect(migration).toContain("Automatic night-audit posting is disabled");
    expect(migration).toContain("public.run_nightly_room_posting(target_hotel_id, current_business_date)");
  });
});
