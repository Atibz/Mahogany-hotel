/** Never send an invitation whose password link points at a developer machine. */
export const DEFAULT_PUBLIC_APP_URL = "https://mahogany-hotel-2x6l.vercel.app";

export function getStaffInviteRedirectUrl(publicAppUrl: string | undefined): string | null {
  if (!publicAppUrl) return null;
  try {
    const url = new URL(publicAppUrl);
    if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return null;
    return `${url.origin}/set-password?flow=invite`;
  } catch {
    return null;
  }
}
