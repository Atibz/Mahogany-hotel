import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const staffPage = readFileSync(
  join(projectRoot, "src", "features", "staff", "staff-page.tsx"),
  "utf8",
);

describe("staff access confirmation contract", () => {
  it("uses the shared in-app modal instead of browser-native confirmation", () => {
    expect(staffPage).toContain('import { Modal } from \'@/components/shared/modal\'');
    expect(staffPage).not.toContain("window.confirm");
    expect(staffPage).toContain('title={activeChangeTarget?.active ? \'Deactivate staff access?\' : \'Restore staff access?\'}');
  });

  it("explains the access and history impact before confirming a deactivation", () => {
    expect(staffPage).toContain("block");
    expect(staffPage).toContain("Their financial and operational history will remain available to management.");
    expect(staffPage).toContain("Deactivate access");
  });

  it("confirms a role change and identifies its immediate access and audit impact", () => {
    expect(staffPage).toContain('title="Confirm staff role change"');
    expect(staffPage).toContain("The change takes effect immediately and is recorded in the hotel audit history.");
    expect(staffPage).toContain('onClick={() => void replaceRole(roleChangeTarget.profile, roleChangeTarget.role)}');
  });
});
