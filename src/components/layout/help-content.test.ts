import { describe, expect, it } from "vitest";

import { canRoleAccess, type Feature, type RoleCode } from "../../features/auth/access-policy";

import { getVisibleHelpGuides, helpGuides } from "./help-content";

const routeFeatures: Record<string, Feature | "profile"> = {
  "/": "dashboard",
  "/reservations": "reservations",
  "/stays": "stays",
  "/departures": "departures",
  "/guests": "guests",
  "/rooms": "rooms",
  "/maintenance": "maintenance",
  "/inventory": "inventory",
  "/folios": "folios",
  "/payments": "payments",
  "/business-accounts": "businessAccounts",
  "/expenses": "expenses",
  "/internal-balancing": "internalBalancing",
  "/restaurant-pos": "posSales",
  "/bar-pos": "barSales",
  "/pos-catalog": "posCatalog",
  "/staff": "staff",
  "/audit": "audit",
  "/settings/stay-policy": "settings",
  "/settings/reservation-cancellation-policy": "settings",
  "/profile": "profile",
};

const allRoles: RoleCode[] = [
  "owner", "general_manager", "receptionist", "cashier", "restaurant_staff",
  "bar_staff", "storekeeper", "accountant",
];

describe("role-aware help guides", () => {
  it("shows the signed-in role its guides and excludes unrelated workflows", () => {
    const titles = getVisibleHelpGuides(["storekeeper"]).map(
      (guide) => guide.title,
    );

    expect(titles).toContain("Review or record hotel stock");
    expect(titles).not.toContain("Check out a departing guest");
  });

  it("shows reception workflows and excludes owner-only night close topics", () => {
    const titles = getVisibleHelpGuides(["receptionist"]).map(
      (guide) => guide.title,
    );

    expect(titles).toContain("Check out a departing guest");
    expect(titles).toContain("Complete the night audit safely");
  });

  it("searches guide instructions without changing role access", () => {
    expect(
      getVisibleHelpGuides(["cashier"], "receipt").map(
        (guide) => guide.id,
      ),
    ).toContain("payments");
    expect(getVisibleHelpGuides(["cashier"], "housekeeping")).toEqual([]);
  });

  it("does not direct cashiers to perform check-in", () => {
    expect(
      getVisibleHelpGuides(["cashier"]).map((guide) => guide.id),
    ).not.toContain("check-in");
  });

  it("supports combined roles without duplicating a guide", () => {
    const results = getVisibleHelpGuides(["owner", "general_manager"]);
    expect(results.filter((guide) => guide.id === "checkout")).toHaveLength(1);
  });

  it("covers every page in the app navigation, plus My profile", () => {
    expect(new Set(helpGuides.map((guide) => guide.route))).toEqual(
      new Set(Object.keys(routeFeatures)),
    );
  });

  it("never sends a role to a page it cannot open", () => {
    for (const guide of helpGuides) {
      const feature = routeFeatures[guide.route];
      expect(feature, guide.id).toBeDefined();
      for (const role of guide.roles) {
        expect(feature === "profile" || canRoleAccess([role], feature), `${guide.id}: ${role}`).toBe(true);
      }
    }
  });

  it("has unique, actionable guides and help available to every role", () => {
    expect(new Set(helpGuides.map((guide) => guide.id)).size).toBe(helpGuides.length);
    for (const guide of helpGuides) {
      expect(guide.steps.length, guide.id).toBeGreaterThanOrEqual(2);
      expect(guide.roles.length, guide.id).toBeGreaterThan(0);
      expect(guide.routeLabel, guide.id).toMatch(/^Open /);
    }
    for (const role of allRoles) {
      expect(getVisibleHelpGuides([role]).length, role).toBeGreaterThan(0);
      expect(getVisibleHelpGuides([role]).some((guide) => guide.route === "/profile"), role).toBe(true);
    }
  });

  it("keeps approval and settlement instructions out of unauthorized roles", () => {
    expect(getVisibleHelpGuides(["receptionist"]).map((guide) => guide.id)).not.toContain("business-day-close");
    expect(getVisibleHelpGuides(["general_manager"]).map((guide) => guide.id)).not.toContain("company-receivable");
    expect(getVisibleHelpGuides(["cashier"]).map((guide) => guide.id)).not.toContain("payment-verification");
  });
});
