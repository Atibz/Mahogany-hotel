import { describe, expect, it } from "vitest";

import { canRoleAccess, getHomeDestination, type Feature, type RoleCode } from "./access-policy";

const features: Feature[] = [
  "dashboard",
  "rooms",
  "maintenance",
  "guests",
  "reservations",
  "stays",
  "departures",
  "folios",
  "payments",
  "staff",
  "audit",
  "settings",
  "businessAccounts",
  "posCatalog",
  "posSales",
  "barSales",
  "expenses",
  "internalBalancing",
  "inventory",
];

function visible(role: RoleCode) {
  return features.filter((feature) => canRoleAccess([role], feature));
}

describe("role navigation policy", () => {
  it("sends outlet-only staff home to their own POS instead of the restricted dashboard", () => {
    expect(getHomeDestination(["restaurant_staff"])).toBe("/restaurant-pos");
    expect(getHomeDestination(["bar_staff"])).toBe("/bar-pos");
    expect(getHomeDestination(["restaurant_staff", "bar_staff"])).toBe("/restaurant-pos");
    expect(getHomeDestination(["general_manager"])).toBeNull();
    expect(getHomeDestination([])).toBeNull();
  });

  it("gives the owner access to every registered feature", () => {
    expect(visible("owner")).toEqual(features);
  });

  it("gives the GM broad operational and control access", () => {
    expect(visible("general_manager")).toEqual(features);
  });

  it("keeps receptionist access focused on front-desk operations", () => {
    expect(visible("receptionist")).toEqual([
      "dashboard",
      "rooms",
      "maintenance",
      "guests",
      "reservations",
      "stays",
      "departures",
      "folios",
    ]);
  });

  it("does not expose hotel-wide payments, staff, or audit pages to reception", () => {
    expect(canRoleAccess(["receptionist"], "payments")).toBe(false);
    expect(canRoleAccess(["receptionist"], "staff")).toBe(false);
    expect(canRoleAccess(["receptionist"], "audit")).toBe(false);
    expect(canRoleAccess(["receptionist"], "settings")).toBe(false);
  });

  it("allows the accountant to administer the POS catalog", () => {
    expect(canRoleAccess(["owner"], "posCatalog")).toBe(true);
    expect(canRoleAccess(["general_manager"], "posCatalog")).toBe(true);
    expect(canRoleAccess(["receptionist"], "posCatalog")).toBe(false);
    expect(canRoleAccess(["accountant"], "posCatalog")).toBe(true);
    expect(canRoleAccess(["restaurant_staff"], "posCatalog")).toBe(false);
    expect(canRoleAccess(["bar_staff"], "posCatalog")).toBe(false);
  });

  it("gives restaurant staff sales access and accountants read-only POS visibility", () => {
    expect(canRoleAccess(["restaurant_staff"], "posSales")).toBe(true);
    expect(canRoleAccess(["accountant"], "posSales")).toBe(true);
    expect(canRoleAccess(["bar_staff"], "posSales")).toBe(false);
    expect(canRoleAccess(["receptionist"], "posSales")).toBe(false);
    expect(canRoleAccess(["restaurant_staff"], "posCatalog")).toBe(false);
  });

  it("gives bar staff access only to the bar POS, not the restaurant POS", () => {
    expect(canRoleAccess(["bar_staff"], "barSales")).toBe(true);
    expect(canRoleAccess(["bar_staff"], "posSales")).toBe(false);
    expect(canRoleAccess(["restaurant_staff"], "barSales")).toBe(false);
    expect(canRoleAccess(["accountant"], "barSales")).toBe(true);
  });

  it("keeps cashier access limited to settlement work", () => {
    expect(visible("cashier")).toEqual([
      "dashboard",
      "folios",
      "payments",
    ]);
    expect(canRoleAccess(["cashier"], "stays")).toBe(false);
  });

  it("gives accountants GM-level pages without giving them the Owner role", () => {
    expect(visible("accountant")).toEqual(features);
    expect(canRoleAccess(["accountant"], "staff")).toBe(true);
  });

  it("limits inventory and supplier operations to Owner, GM, and Storekeeper", () => {
    expect(canRoleAccess(["storekeeper"], "inventory")).toBe(true);
    expect(canRoleAccess(["general_manager"], "inventory")).toBe(true);
    expect(canRoleAccess(["managing_director"], "inventory")).toBe(true);
    expect(canRoleAccess(["managing_director"], "staff")).toBe(true);
    expect(canRoleAccess(["owner"], "inventory")).toBe(true);
    expect(canRoleAccess(["accountant"], "inventory")).toBe(true);
    expect(canRoleAccess(["restaurant_staff"], "inventory")).toBe(false);
    expect(canRoleAccess(["bar_staff"], "inventory")).toBe(false);
    expect(canRoleAccess(["receptionist"], "inventory")).toBe(false);
    expect(canRoleAccess(["storekeeper"], "dashboard")).toBe(true);
    expect(canRoleAccess(["storekeeper"], "payments")).toBe(false);
    expect(canRoleAccess(["storekeeper"], "rooms")).toBe(false);
  });

  it("combines multiple assigned roles without weakening restrictions", () => {
    expect(canRoleAccess(["cashier", "accountant"], "audit")).toBe(true);
    expect(canRoleAccess(["cashier", "accountant"], "staff")).toBe(true);
  });
});
