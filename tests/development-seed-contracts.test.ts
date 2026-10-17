import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const seedPath = fileURLToPath(
  new URL("../supabase/seed.sql", import.meta.url),
);
const seed = readFileSync(seedPath, "utf8");

describe("development seed safety", () => {
  it("uses an explicit development identity and never creates Auth users", () => {
    expect(seed).toContain("Development-only baseline configuration");
    expect(seed).toContain("example.test");
    expect(seed).not.toMatch(/insert\s+into\s+auth\.users/i);
    expect(seed).not.toMatch(/service_role/i);
  });

  it("provides stable operational fixtures relative to the hotel business date", () => {
    expect(seed).toContain("public.hotel_business_date");
    expect(seed).toContain("DEMO-RES-001");
    expect(seed).toContain("DEMO-RES-005");
    expect(seed).toContain("DEMO-MNT-001");
    expect(seed).toMatch(/discount below the 20 percent approval threshold/i);
  });
});
