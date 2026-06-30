import { getActingClioIdentity } from "./pagination";

/**
 * The "owner" is the attorney the custom calendaring tooling was originally
 * built for (RomSum / NRN event types, cross-calendar assignment, NRN calendar
 * IDs). When the server was scoped to one person, that behavior applied to
 * every request. Now that the whole firm uses the server, those customizations
 * should ONLY apply to the owner — everyone else gets plain calendaring: events
 * land on their own personal Clio calendar with no custom event types and no
 * cross-calendar targeting.
 *
 * Configurable via OWNER_EMAILS (comma-separated, case-insensitive). Defaults
 * to Nicholas Noe, who authored the custom tooling.
 */
const DEFAULT_OWNER_EMAILS = "nnoe@romanosumner.com";

/** The configured owner email allowlist, normalized to lowercase. */
export function getOwnerEmails(): string[] {
  return (process.env.OWNER_EMAILS ?? DEFAULT_OWNER_EMAILS)
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Pure check (unit-testable): is `email` one of the configured owner emails?
 * A missing/blank email is never the owner.
 */
export function isOwnerEmail(email: string | undefined, ownerEmails: string[]): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (!e) return false;
  return ownerEmails.includes(e);
}

/**
 * Whether the acting attorney (the Clio token owner for THIS request) is the
 * configured owner who gets the custom calendaring behavior.
 *
 * Fail-CLOSED: if identity can't be resolved (no context, who_am_i error), we
 * treat the caller as a non-owner so the owner-only customizations never leak
 * to the wrong user.
 */
export async function isActingUserOwner(): Promise<boolean> {
  try {
    const email = (await getActingClioIdentity()).email;
    return isOwnerEmail(email, getOwnerEmails());
  } catch {
    return false;
  }
}
