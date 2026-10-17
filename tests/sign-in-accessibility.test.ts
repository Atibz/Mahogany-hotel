import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(
    new URL("../src/features/auth/sign-in-page.tsx", import.meta.url),
  ),
  "utf8",
);

describe("sign-in accessibility contracts", () => {
  it("associates form controls with visible labels and browser autofill", () => {
    expect(source).toContain("htmlFor={emailId}");
    expect(source).toContain("id={emailId}");
    expect(source).toContain('autoComplete="username"');
    expect(source).toContain("htmlFor={passwordId}");
    expect(source).toContain("id={passwordId}");
    expect(source).toContain('autoComplete="current-password"');
  });

  it("provides keyboard-visible focus and an accessible password toggle", () => {
    expect(source).toContain(
      'aria-label={showPassword ? "Hide password" : "Show password"}',
    );
    expect(source).toContain("aria-pressed={showPassword}");
    expect(source).toContain("focus-visible:ring-2");
  });

  it("announces errors, success, and busy state to assistive technology", () => {
    expect(source).toContain(
      'role={feedback?.tone === "error" ? "alert" : "status"}',
    );
    expect(source).toContain(
      'aria-live={feedback?.tone === "error" ? "assertive" : "polite"}',
    );
    expect(source).toContain("aria-busy={isBusy}");
    expect(source).toContain(
      'aria-invalid={feedback?.tone === "error" ? true : undefined}',
    );
  });
});
