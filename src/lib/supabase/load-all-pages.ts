type PageResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

/** PostgREST limits response rows; never treat one response as a complete register. */
export async function loadAllPages<T>(
  loadPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize = 500,
): Promise<T[]> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error("Page size must be a positive integer.");
  }

  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await loadPage(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}
