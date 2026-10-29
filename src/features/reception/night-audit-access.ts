import type { CurrentNightAuditApproval } from "./reception-service";

export function canRunApprovedNightAudit(
  canRunNightAudit: boolean,
  userId: string | undefined,
  approval: CurrentNightAuditApproval | null | undefined,
) {
  return Boolean(
    canRunNightAudit &&
      userId &&
      approval?.approval_id &&
      approval.approved_by &&
      approval.approved_by !== userId &&
      !approval.executed_at,
  );
}

export function auditStaffLabel(name: string | null, roleName: string | null) {
  return `${name || "Unknown staff member"} (${roleName || "role unavailable"})`;
}
