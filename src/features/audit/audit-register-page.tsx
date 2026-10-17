import { useMemo, useState, type FormEvent } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
  ShieldCheck,
} from "lucide-react";

import {
  EmptyState,
  PageError,
  PageLoading,
} from "@/components/shared/page-state";
import { formatNaira } from "@/lib/money";
import {
  useActiveHotel,
  useActivityRegister,
} from "@/features/reception/use-reception";
import type { ActivityRegisterFilters } from "@/features/reception/reception-service";
import { buildAuditCsv } from "./audit-csv";

const PAGE_SIZE = 50;

function dateValue(date: Date) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function defaultDates() {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 30);
  return { fromDate: dateValue(from), toDate: dateValue(today) };
}

function sentence(value: string) {
  return value.replaceAll(".", " · ").replaceAll("_", " ");
}

function downloadRows(rows: ReturnType<typeof useActivityRegister>["data"]) {
  if (!rows?.length) return false;
  const content = buildAuditCsv(rows);
  const url = URL.createObjectURL(
    new Blob([`\uFEFF${content}`], { type: "text/csv;charset=utf-8" }),
  );
  const fileName = `audit-register-${dateValue(new Date())}.csv`;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.setAttribute("aria-hidden", "true");
  anchor.tabIndex = -1;
  Object.assign(anchor.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
  });
  document.body.appendChild(anchor);
  anchor.click();
  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 30_000);
  return { url, fileName };
}

export function AuditRegisterPage() {
  const hotel = useActiveHotel();
  const initialDates = useMemo(() => defaultDates(), []);
  const [draft, setDraft] = useState({
    ...initialDates,
    query: "",
    action: "",
    entityType: "",
    minAmount: "",
    maxAmount: "",
  });
  const [filters, setFilters] = useState<ActivityRegisterFilters>({
    ...initialDates,
    limit: PAGE_SIZE,
    offset: 0,
  });
  const [validationMessage, setValidationMessage] = useState("");
  const [exportMessage, setExportMessage] = useState("");
  const [exportLink, setExportLink] = useState<{
    url: string;
    fileName: string;
  } | null>(null);
  const activity = useActivityRegister(hotel.data?.id, filters);
  const rows = activity.data ?? [];
  const total = Number(rows[0]?.total_count ?? 0);
  const offset = filters.offset ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const actionOptions = [...new Set(rows.map((row) => row.action))].sort();
  const entityOptions = [...new Set(rows.map((row) => row.entity_type))].sort();

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setExportMessage("");
    const minAmount = draft.minAmount.trim()
      ? Number(draft.minAmount.replaceAll(",", ""))
      : undefined;
    const maxAmount = draft.maxAmount.trim()
      ? Number(draft.maxAmount.replaceAll(",", ""))
      : undefined;
    if (
      (minAmount !== undefined &&
        (!Number.isFinite(minAmount) || minAmount < 0)) ||
      (maxAmount !== undefined &&
        (!Number.isFinite(maxAmount) || maxAmount < 0))
    ) {
      setValidationMessage("Enter valid non-negative Naira amounts.");
      return;
    }
    if (
      minAmount !== undefined &&
      maxAmount !== undefined &&
      minAmount > maxAmount
    ) {
      setValidationMessage(
        "Minimum amount cannot be greater than maximum amount.",
      );
      return;
    }
    setValidationMessage("");
    setFilters({
      fromDate: draft.fromDate,
      toDate: draft.toDate,
      query: draft.query,
      action: draft.action,
      entityType: draft.entityType,
      minAmountKobo:
        minAmount === undefined ? undefined : Math.round(minAmount * 100),
      maxAmountKobo:
        maxAmount === undefined ? undefined : Math.round(maxAmount * 100),
      limit: PAGE_SIZE,
      offset: 0,
    });
  }

  function resetFilters() {
    const dates = defaultDates();
    setDraft({
      ...dates,
      query: "",
      action: "",
      entityType: "",
      minAmount: "",
      maxAmount: "",
    });
    setFilters({ ...dates, limit: PAGE_SIZE, offset: 0 });
    setValidationMessage("");
    setExportMessage("");
  }

  if (hotel.isLoading) return <PageLoading />;
  if (hotel.error) return <PageError message="Unable to identify the hotel." />;
  if (!hotel.data)
    return <EmptyState>No hotel is assigned to your staff account.</EmptyState>;

  return (
    <section className="max-w-7xl">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-amber-800">
            <ShieldCheck className="size-4" /> Management control
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            Audit register
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
            Find who performed an operation, when it happened, and the evidence
            recorded with it. Audit records are read-only.
          </p>
        </div>
        <button
          type="button"
          disabled={!rows.length}
          onClick={() => {
            const result = downloadRows(activity.data);
            if (!result) return;
            if (exportLink) URL.revokeObjectURL(exportLink.url);
            setExportLink(result);
            setExportMessage(
              `${rows.length} visible audit record${rows.length === 1 ? "" : "s"} prepared as CSV.`,
            );
            window.setTimeout(() => {
              URL.revokeObjectURL(result.url);
              setExportLink((current) =>
                current?.url === result.url ? null : current,
              );
            }, 30_000);
          }}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-semibold hover:bg-stone-50 disabled:opacity-50"
        >
          <Download className="size-4" /> Export visible rows
        </button>
      </div>
      {exportMessage && (
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-emerald-700" role="status">
          <span>{exportMessage}</span>
          {exportLink && (
            <a
              href={exportLink.url}
              download={exportLink.fileName}
              className="underline underline-offset-2"
            >
              If it did not download, click here.
            </a>
          )}
        </div>
      )}

      <form
        onSubmit={applyFilters}
        className="mt-6 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="text-sm font-medium text-stone-700 xl:col-span-2">
            Search user, action, ID, document, room, or details
            <div className="relative mt-1.5">
              <Search className="pointer-events-none absolute left-3 top-3 size-4 text-stone-400" />
              <input
                value={draft.query}
                onChange={(event) =>
                  setDraft((value) => ({ ...value, query: event.target.value }))
                }
                className="w-full rounded-xl border border-stone-300 py-2.5 pl-9 pr-3 font-normal"
                placeholder="e.g. payment, Room 204, receipt number, staff name"
              />
            </div>
          </label>
          <label className="text-sm font-medium text-stone-700">
            From date
            <input
              type="date"
              value={draft.fromDate}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  fromDate: event.target.value,
                }))
              }
              className="mt-1.5 w-full rounded-xl border border-stone-300 px-3 py-2.5 font-normal"
            />
          </label>
          <label className="text-sm font-medium text-stone-700">
            To date
            <input
              type="date"
              value={draft.toDate}
              onChange={(event) =>
                setDraft((value) => ({ ...value, toDate: event.target.value }))
              }
              className="mt-1.5 w-full rounded-xl border border-stone-300 px-3 py-2.5 font-normal"
            />
          </label>
          <label className="text-sm font-medium text-stone-700">
            Exact action
            <input
              list="audit-actions"
              value={draft.action}
              onChange={(event) =>
                setDraft((value) => ({ ...value, action: event.target.value }))
              }
              className="mt-1.5 w-full rounded-xl border border-stone-300 px-3 py-2.5 font-normal"
              placeholder="All actions"
            />
            <datalist id="audit-actions">
              {actionOptions.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </label>
          <label className="text-sm font-medium text-stone-700">
            Entity type
            <input
              list="audit-entities"
              value={draft.entityType}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  entityType: event.target.value,
                }))
              }
              className="mt-1.5 w-full rounded-xl border border-stone-300 px-3 py-2.5 font-normal"
              placeholder="All record types"
            />
            <datalist id="audit-entities">
              {entityOptions.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </label>
          <label className="text-sm font-medium text-stone-700">
            Minimum amount (₦)
            <input
              inputMode="decimal"
              value={draft.minAmount}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  minAmount: event.target.value,
                }))
              }
              className="mt-1.5 w-full rounded-xl border border-stone-300 px-3 py-2.5 font-normal"
              placeholder="No minimum"
            />
          </label>
          <label className="text-sm font-medium text-stone-700">
            Maximum amount (₦)
            <input
              inputMode="decimal"
              value={draft.maxAmount}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  maxAmount: event.target.value,
                }))
              }
              className="mt-1.5 w-full rounded-xl border border-stone-300 px-3 py-2.5 font-normal"
              placeholder="No maximum"
            />
          </label>
        </div>
        {validationMessage && (
          <p className="mt-3 text-sm font-medium text-red-700" role="alert">
            {validationMessage}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="submit"
            className="rounded-xl bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-950"
          >
            Apply filters
          </button>
          <button
            type="button"
            onClick={resetFilters}
            className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold hover:bg-stone-50"
          >
            Reset
          </button>
        </div>
      </form>

      <div className="mt-5 overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-4 py-3">
          <p className="text-sm font-semibold">
            {activity.isFetching ? "Searching…" : `${total} matching records`}
          </p>
          <p className="text-xs text-stone-500">
            Newest activity appears first
          </p>
        </div>
        {activity.isLoading ? (
          <PageLoading />
        ) : activity.error ? (
          <PageError
            message={
              activity.error instanceof Error
                ? activity.error.message
                : "Unable to load the audit register."
            }
          />
        ) : !rows.length ? (
          <div className="p-6">
            <EmptyState>No audit records match these filters.</EmptyState>
          </div>
        ) : (
          <div className="divide-y divide-stone-100">
            {rows.map((row) => (
              <article key={row.log_id} className="p-4 sm:p-5">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold capitalize">
                        {sentence(row.action)}
                      </h2>
                      <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs capitalize text-stone-600">
                        {sentence(row.entity_type)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-stone-600">
                      {row.actor_name} ·{" "}
                      {new Date(row.occurred_at).toLocaleString("en-NG")}
                    </p>
                    {row.entity_id && (
                      <p className="mt-1 break-all font-mono text-xs text-stone-400">
                        Record {row.entity_id}
                      </p>
                    )}
                  </div>
                  {row.display_amount_kobo != null && (
                    <p className="shrink-0 text-sm font-semibold text-stone-900">
                      {formatNaira(row.display_amount_kobo)}
                    </p>
                  )}
                </div>
                {Object.keys(row.metadata).length > 0 && (
                  <details className="mt-3 rounded-xl bg-stone-50 px-3 py-2 text-sm">
                    <summary className="cursor-pointer font-medium text-stone-700">
                      View recorded evidence
                    </summary>
                    <dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {Object.entries(row.metadata).map(([key, value]) => (
                        <div key={key} className="min-w-0">
                          <dt className="text-xs capitalize text-stone-500">
                            {sentence(key)}
                          </dt>
                          <dd className="mt-0.5 break-words text-stone-800">
                            {typeof value === "object"
                              ? JSON.stringify(value)
                              : String(value)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                )}
              </article>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between border-t border-stone-200 px-4 py-3">
          <p className="text-sm text-stone-600">
            Page {page} of {pageCount}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              aria-label="Previous audit page"
              disabled={offset === 0 || activity.isFetching}
              onClick={() =>
                setFilters((value) => ({
                  ...value,
                  offset: Math.max(0, offset - PAGE_SIZE),
                }))
              }
              className="grid size-9 place-items-center rounded-lg border border-stone-300 hover:bg-stone-50 disabled:opacity-40"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Next audit page"
              disabled={offset + PAGE_SIZE >= total || activity.isFetching}
              onClick={() =>
                setFilters((value) => ({
                  ...value,
                  offset: offset + PAGE_SIZE,
                }))
              }
              className="grid size-9 place-items-center rounded-lg border border-stone-300 hover:bg-stone-50 disabled:opacity-40"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
