import { describe, expect, it } from "vitest";
import { DEFAULT_PUBLIC_APP_URL, getStaffInviteRedirectUrl } from "./invite-redirect";

describe("staff invite redirect", () => {
  it("uses the configured public site even when an invite is sent from localhost", () => {
    expect(getStaffInviteRedirectUrl(DEFAULT_PUBLIC_APP_URL))
      .toBe("https://mahogany-hotel-2x6l.vercel.app/set-password?flow=invite");
    expect(getStaffInviteRedirectUrl("https://mahogany.example.com/some/path"))
      .toBe("https://mahogany.example.com/set-password?flow=invite");
  });

  it("never creates a localhost or insecure invitation link", () => {
    expect(getStaffInviteRedirectUrl(undefined)).toBeNull();
    expect(getStaffInviteRedirectUrl("http://localhost:5175")).toBeNull();
    expect(getStaffInviteRedirectUrl("http://example.com")).toBeNull();
  });
});
