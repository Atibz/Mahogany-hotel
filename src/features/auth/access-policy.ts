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
  rooms: ["owner", "general_manager", "receptionist"],
  maintenance: ["owner", "general_manager", "receptionist"],
  guests: ["owner", "general_manager", "receptionist"],
  reservations: ["owner", "general_manager", "receptionist"],
  stays: ["owner", "general_manager", "receptionist"],
  departures: ["owner", "general_manager", "receptionist"],
  folios: ["owner", "general_manager", "receptionist", "cashier", "accountant"],
  payments: ["owner", "general_manager", "cashier", "accountant"],
  staff: ["owner", "general_manager"],
  audit: ["owner", "general_manager", "accountant"],
  settings: ["owner", "general_manager"],
  businessAccounts: ["owner", "general_manager", "accountant"],
  expenses: ["owner", "general_manager", "accountant"],
  internalBalancing: ["owner", "general_manager", "accountant"],
  inventory: ["owner", "general_manager", "storekeeper"],
  posCatalog: ["owner", "general_manager"],
  posSales: ["owner", "general_manager", "restaurant_staff", "accountant"],
  barSales: ["owner", "general_manager", "bar_staff", "accountant"],
};

export function canRoleAccess(roleCodes: RoleCode[], feature: Feature) {
  return (
    roleCodes.includes("owner") ||
    featureRoles[feature].some((role) => roleCodes.includes(role))
  );
}
