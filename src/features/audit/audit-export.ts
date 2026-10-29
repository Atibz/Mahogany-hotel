import type {
  ActivityRegisterFilters,
  ActivityRegisterItem,
} from "@/features/reception/reception-service";

const EXPORT_PAGE_SIZE = 100;

/** Fetch every matching record; the register itself remains paginated. */
export async function loadMatchingAuditRows(
  filters: ActivityRegisterFilters,
  loadPage: (filters: ActivityRegisterFilters) => Promise<ActivityRegisterItem[]>,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ActivityRegisterItem[]> {
  const rows: ActivityRegisterItem[] = [];
  let expectedTotal: number | null = null;

  while (expectedTotal === null || rows.length < expectedTotal) {
    const page = await loadPage({ ...filters, limit: EXPORT_PAGE_SIZE, offset: rows.length });
    if (expectedTotal === null) expectedTotal = Number(page[0]?.total_count ?? 0);
    if (page.length === 0 && rows.length < expectedTotal) {
      throw new Error("The audit history changed during export. Please retry.");
    }
    if (page.length > 0 && Number(page[0].total_count) !== expectedTotal) {
      throw new Error("The audit history changed during export. Please retry.");
    }
    rows.push(...page);
    onProgress?.(rows.length, expectedTotal);
    if (rows.length > expectedTotal) {
      throw new Error("The audit history changed during export. Please retry.");
    }
  }

  if (new Set(rows.map((row) => row.log_id)).size !== rows.length) {
    throw new Error("The audit history changed during export. Please retry.");
  }
  return rows;
}
