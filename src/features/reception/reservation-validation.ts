export function guestCountError(
  adults: number,
  children: number,
  capacity: number | undefined,
) {
  if (!Number.isInteger(adults) || adults < 1)
    return "At least one adult is required.";
  if (!Number.isInteger(children) || children < 0)
    return "Children cannot be negative.";
  if (capacity !== undefined && adults + children > capacity)
    return `This room type allows a maximum of ${capacity} guest${capacity === 1 ? "" : "s"}.`;
  return null;
}
