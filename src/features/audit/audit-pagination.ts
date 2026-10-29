export function auditPaginationLabel(
  page: number,
  pageCount: number,
  isFetching: boolean,
  hasError: boolean,
) {
  if (isFetching) return `Loading page ${page}…`;
  if (hasError) return `Page ${page} unavailable`;
  return `Page ${page} of ${pageCount}`;
}
