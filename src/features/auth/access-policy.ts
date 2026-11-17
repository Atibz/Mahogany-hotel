export type Feature =
  | "dashboard"
  | "rooms"
  | "maintenance"
  | "guests"
  | "reservations"
  | "stays"
  | "departures"
  | "folios"
  | "payments"
  | "staff"
  | "audit"
  | "settings"
  | "businessAccounts"
  | "expenses"
  | "internalBalancing"
  | "inventory"
  | "posCatalog"
  | "posSales"
  | "barSales";
export type RoleCode =
  | "owner"
  | "general_manager"
  | "managing_director"
  | "receptionist"
  | "cashier"
  | "restaurant_staff"
  | "bar_staff"
  | "storekeeper"
  | "accountant";

const featureRoles: Record<Feature, RoleCode[]> = {
  dashboard: [
    "owner",
    "general_manager",
    "receptionist",
    "cashier",
    "accountant",
    "storekeeper",
  ],
  rooms: ["owner", "general_manager", "receptionist", "accountant"],
  maintenance: ["owner", "general_manager", "receptionist", "accountant"],
  guests: ["owner", "general_manager", "receptionist", "accountant"],
  reservations: ["owner", "general_manager", "receptionist", "accountant"],
  stays: ["owner", "general_manager", "receptionist", "accountant"],
  departures: ["owner", "general_manager", "receptionist", "accountant"],
  folios: ["owner", "general_manager", "receptionist", "cashier", "accountant"],
  payments: ["owner", "general_manager", "cashier", "accountant"],
  staff: ["owner", "general_manager", "accountant"],
  audit: ["owner", "general_manager", "accountant"],
  settings: ["owner", "general_manager", "accountant"],
  businessAccounts: ["owner", "general_manager", "accountant"],
  expenses: ["owner", "general_manager", "accountant"],
  internalBalancing: ["owner", "general_manager", "accountant"],
  inventory: ["owner", "general_manager", "storekeeper", "accountant"],
  posCatalog: ["owner", "general_manager", "accountant"],
  posSales: ["owner", "general_manager", "restaurant_staff", "accountant"],
  barSales: ["owner", "general_manager", "bar_staff", "accountant"],
};

export function canRoleAccess(roleCodes: RoleCode[], feature: Feature) {
  return (
    roleCodes.includes("owner") ||
    (roleCodes.includes("managing_director") && featureRoles[feature].includes("general_manager")) ||
    featureRoles[feature].some((role) => roleCodes.includes(role))
  );
}

export function getHomeDestination(roleCodes: RoleCode[]) {
  if (canRoleAccess(roleCodes, "dashboard")) return null;
  if (canRoleAccess(roleCodes, "posSales")) return "/restaurant-pos";
  if (canRoleAccess(roleCodes, "barSales")) return "/bar-pos";
  return null;
}
