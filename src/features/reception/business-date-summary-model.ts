export type OutletSales = {
  outlet_id: string;
  outlet_name: string;
  department_code: string;
  gross_sales_kobo: number;
  pending_kobo: number;
  open_balance_kobo: number;
};

export type OutletCollections = {
  outlet_id: string;
  outlet_name: string;
  department_code: string;
  payments_received_kobo: number;
  refunds_kobo: number;
  net_collected_kobo: number;
};

export type OutletSummaryRow = {
  id: string;
  name: string;
  department: string;
  sales: number;
  received: number;
  refunds: number;
  netCollected: number;
  pending: number;
  openBalance: number;
};

export function buildOutletSummary(
  sales: OutletSales[],
  collections: OutletCollections[],
): OutletSummaryRow[] {
  const outlets = new Map<string, OutletSummaryRow>();
  for (const row of sales) {
    outlets.set(row.outlet_id, {
      id: row.outlet_id,
      name: row.outlet_name,
      department: row.department_code,
      sales: Number(row.gross_sales_kobo),
      received: 0,
      refunds: 0,
      netCollected: 0,
      pending: Number(row.pending_kobo),
      openBalance: Number(row.open_balance_kobo),
    });
  }
  for (const row of collections) {
    const entry = outlets.get(row.outlet_id) ?? {
      id: row.outlet_id,
      name: row.outlet_name,
      department: row.department_code,
      sales: 0,
      received: 0,
      refunds: 0,
      netCollected: 0,
      pending: 0,
      openBalance: 0,
    };
    entry.received = Number(row.payments_received_kobo);
    entry.refunds = Number(row.refunds_kobo);
    entry.netCollected = Number(row.net_collected_kobo);
    outlets.set(row.outlet_id, entry);
  }
  return [...outlets.values()];
}
