export function formatNaira(kobo: number | null | undefined) {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format((kobo ?? 0) / 100);
}

export function nairaToKobo(value: string) {
  const normalizedValue = value.replace(/,/g, "").trim();
  if (!normalizedValue) throw new Error("Enter a valid non-negative amount.");

  const amount = Number(normalizedValue);
  if (!Number.isFinite(amount) || amount < 0)
    throw new Error("Enter a valid non-negative amount.");
  return Math.round(amount * 100);
}
