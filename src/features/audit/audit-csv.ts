import type { ActivityRegisterItem } from "@/features/reception/reception-service";

function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if ("=+-@".includes(text.trimStart()[0] ?? "")) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildAuditCsv(rows: ActivityRegisterItem[]) {
  return [
    [
      "Occurred at",
      "User",
      "Action",
      "Entity",
      "Entity ID",
      "Amount",
      "Details",
    ],
    ...rows.map((row) => [
      row.occurred_at,
      row.actor_name,
      row.action,
      row.entity_type,
      row.entity_id ?? "",
      row.display_amount_kobo == null
        ? ""
        : (row.display_amount_kobo / 100).toFixed(2),
      JSON.stringify(row.metadata),
    ]),
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");
}
