import { describe, expect, it } from "vitest";
import { inviteFailureMessage } from "./invite-error";

describe("staff invitation errors", () => {
  it("gives useful next steps without technical Edge Function wording", () => {
    expect(inviteFailureMessage(401)).toContain("Sign in again");
    expect(inviteFailureMessage(403)).toContain("cannot invite staff");
    expect(inviteFailureMessage(404)).toContain("deployment");
    expect(inviteFailureMessage(400, "Invalid role")).toContain("choose a role again");
  });

  it("does not expose unknown server details to staff", () => {
    const message = inviteFailureMessage(500, "internal database details");
    expect(message).not.toContain("database");
    expect(message).toContain("Check the staff list");
  });
});
