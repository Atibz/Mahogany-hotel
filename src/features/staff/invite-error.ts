const checkBeforeRetrying = "Check the staff list and ask the recipient to check their inbox before trying again.";

export function inviteFailureMessage(status?: number, detail = ""): string {
  const reason = detail.toLowerCase();

  if (status === 401) return "We could not verify your sign-in. Sign in again; if this continues, ask an administrator to check the invitation setup.";
  if (status === 403) return "Your account cannot invite staff. Ask a General Manager to check your access.";
  if (status === 404) return "Staff invitations are not available on this deployment yet. Ask an administrator to check the setup.";
  if (reason.includes("invalid role")) return "That staff role is no longer available. Refresh the page and choose a role again.";
  if (reason.includes("redirect address")) return "The invitation link is not configured for this site. Ask an administrator to check the setup.";
  if (reason.includes("rate limit") || reason.includes("too many")) return "Too many invitation emails have been requested. Please wait before trying again.";
  if (reason.includes("already registered") || reason.includes("already exists")) return "This email already has an account. Check the staff list before sending another invitation.";
  if (reason.includes("invalid email")) return "Please check the email address and try again.";
  if (status && status >= 500) return `The invitation service could not finish this request. ${checkBeforeRetrying}`;
  return `We could not confirm that the invitation was sent. ${checkBeforeRetrying}`;
}
