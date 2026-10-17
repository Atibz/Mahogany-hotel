import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { printElementInIsolatedFrame } from "../src/lib/print-document";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const printDocument = readFileSync(
  join(projectRoot, "src", "lib", "print-document.ts"),
  "utf8",
);
const paymentHistory = readFileSync(
  join(projectRoot, "src", "features", "reception", "folio-payment-history.tsx"),
  "utf8",
);

describe("receipt print fallback contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("cleans up when an isolated frame does not expose print support", () => {
    const frame = {
      title: "",
      setAttribute: vi.fn(),
      style: {},
      contentDocument: {},
      contentWindow: { print: undefined },
      remove: vi.fn(),
    } as unknown as HTMLIFrameElement;
    const createElement = vi.fn(() => frame);
    vi.stubGlobal("document", {
      createElement,
      body: { appendChild: vi.fn() },
    });

    expect(
      printElementInIsolatedFrame({
        source: {} as HTMLElement,
        title: "Receipt test",
        styles: "",
      }),
    ).toBe(false);
    expect(createElement).toHaveBeenCalledOnce();
    expect(frame.remove).toHaveBeenCalledOnce();
  });

  it("cleans up and reports unsupported browser print capability", () => {
    expect(printDocument).toContain('typeof printWindow.print !== "function"');
    expect(printDocument).toMatch(/typeof printWindow\.print !== "function"\)\s*\{\s*frame\.remove\(\);\s*return false;/);
  });

  it("shows the print limitation inside the receipt dialog", () => {
    expect(paymentHistory).toContain("This browser cannot open a print dialog.");
    expect(paymentHistory).toContain('role="status"');
  });
});
