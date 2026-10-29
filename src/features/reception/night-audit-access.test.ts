import { describe, expect, it } from "vitest";

import type { CurrentNightAuditApproval } from "./reception-service";
import { auditStaffLabel, canRunApprovedNightAudit } from "./night-audit-access";

const pending: CurrentNightAuditApproval = {
  business_date: "2026-10-19",
  approval_id: "approval-1",
  approved_by: "gm-1",
  approved_by_name: "Amina Bello",
  approved_by_role_name: "General Manager",
  approved_at: "2026-10-19T20:25:16Z",
  executed_by: null,
  executed_by_name: null,
  executed_by_role_name: null,
  executed_at: null,
  posting_status: null,
  posts_created: null,
};

describe("night-audit run action", () => {
  it("hides the action from the person who approved", () => {
    expect(canRunApprovedNightAudit(true, "gm-1", pending)).toBe(false);
  });

  it("shows the action to a different authorized staff member", () => {
    expect(canRunApprovedNightAudit(true, "reception-1", pending)).toBe(true);
  });

  it("hides the action without run permission, a user, or an approval", () => {
    expect(canRunApprovedNightAudit(false, "reception-1", pending)).toBe(false);
    expect(canRunApprovedNightAudit(true, undefined, pending)).toBe(false);
    expect(canRunApprovedNightAudit(true, "reception-1", { ...pending, approved_by: null })).toBe(false);
    expect(canRunApprovedNightAudit(true, "reception-1", { ...pending, approval_id: null })).toBe(false);
  });

  it("hides the action after execution", () => {
    expect(canRunApprovedNightAudit(true, "reception-1", {
      ...pending,
      executed_at: "2026-10-19T21:00:00Z",
    })).toBe(false);
  });
});

it("displays the person's name and role together", () => {
  expect(auditStaffLabel("Chidi Okeke", "Receptionist")).toBe("Chidi Okeke (Receptionist)");
});
