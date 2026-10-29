export function isRequiredTextComplete(value: string, minLength: number): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length >= minLength;
}
