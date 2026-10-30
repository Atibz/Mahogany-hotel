import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const router = readFileSync(join(projectRoot, "src", "app", "router.tsx"), "utf8");
const accessControl = readFileSync(
  join(projectRoot, "src", "features", "auth", "access-control.tsx"),
  "utf8",
);

const protectedRoutes = [
  ["rooms", "rooms"],
  ["maintenance", "maintenance"],
  ["guests", "guests"],
  ["reservations", "reservations"],
  ["stays", "stays"],
  ["departures", "departures"],
  ["folios", "folios"],
  ["payments", "payments"],
  ["staff", "staff"],
  ["audit", "audit"],
  ["business-accounts", "businessAccounts"],
  ["expenses", "expenses"],
  ["internal-balancing", "internalBalancing"],
  ["inventory", "inventory"],
  ["pos-catalog", "posCatalog"],
  ["restaurant-pos", "posSales"],
  ["bar-pos", "barSales"],
] as const;

describe("role-protected route contracts", () => {
  it.each(protectedRoutes)("guards /%s with the %s feature permission", (path, feature) => {
    const routePattern = new RegExp(
      `path: "${path}",\\s*element: \\(\\s*<RequireFeature feature="${feature}">`,
    );
    expect(router).toMatch(routePattern);
  });

  it("routes the home page through role-aware access while guarding forbidden direct URLs", () => {
    expect(router).toMatch(/index: true,\s*element: <RoleHomePage \/>/);
    expect(accessControl).toContain("return canAccess(feature) ? <>{children}</> : <AccessDeniedPage />");
  });
});
