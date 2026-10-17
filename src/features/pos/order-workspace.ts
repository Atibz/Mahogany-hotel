export function mergeRecentAndOpenOrders<T extends { id: string; outlet_id: string; created_at: string }>(
  recent: T[],
  open: T[],
  outletIds: ReadonlySet<string>,
): T[] {
  const orders = new Map<string, T>();
  for (const order of [...recent, ...open]) {
    if (outletIds.has(order.outlet_id)) orders.set(order.id, order);
  }
  return [...orders.values()].sort(
    (a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id),
  );
}
