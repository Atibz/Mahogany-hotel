export const roles = [
  'owner',
  'general_manager',
  'receptionist',
  'cashier',
  'restaurant_staff',
  'bar_staff',
  'storekeeper',
  'accountant',
  'staff_admin',
] as const

export type Role = (typeof roles)[number]

// The database will own the permission catalogue and assignments in Step 2.
// This type keeps frontend consumers independent from a hard-coded role matrix.
export type PermissionCode = string
