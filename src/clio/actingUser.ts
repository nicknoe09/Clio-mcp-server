import { getContext } from "../auth/identity";
import { rawGetSingle } from "./pagination";

/**
 * Who is actually making this request, in Clio terms.
 *
 * Clio attributes a created object (time entry, task, calendar entry, …) to the
 * OWNER OF THE OAUTH TOKEN used — unless the request explicitly sets a
 * user/assignee/owner field. Our write tools historically took an explicit,
 * caller-supplied `user_id`, so an agent that passed the wrong id (or relied on
 * a hardcoded roster default) would register the action under a DIFFERENT
 * attorney. These helpers let the write tools default attribution to the acting
 * attorney and guard against accidental cross-user attribution.
 *
 * The acting attorney's Clio user id is resolved once per request via
 * /users/who_am_i and cached on the ALS context.
 */

/** Resolve + cache the acting attorney's Clio user id for this request. */
export async function getActingClioUserId(): Promise<number> {
  const ctx = getContext();
  if (!ctx) {
    throw new Error("No user context: the acting Clio user is only available inside an authenticated /mcp request.");
  }
  if (ctx.clioUserId != null) return ctx.clioUserId;

  const me = await rawGetSingle("/users/who_am_i", { fields: "id" });
  const id = Number((me as any)?.data?.id ?? (me as any)?.id);
  if (!Number.isFinite(id)) {
    throw new Error("Could not resolve the acting Clio user (GET /users/who_am_i returned no id).");
  }
  ctx.clioUserId = id;
  return id;
}

/** Thrown when a write tool is asked to attribute an action to someone else. */
export class AttributionError extends Error {
  constructor(public readonly requested: number, public readonly acting: number) {
    super(
      `Refusing to attribute this to Clio user ${requested}: that isn't you (you are user ${acting}). ` +
        `Omit the user id to act as yourself, or set on_behalf_of=true to deliberately act for another user.`
    );
    this.name = "AttributionError";
  }
}

/**
 * Pure attribution decision (kept separate so it's trivially unit-testable):
 *   - no id requested        → the acting user (the safe default)
 *   - id requested == acting  → the acting user
 *   - id requested != acting  → allowed only when `allowOther` is set; else throws
 */
export function decideAttributedUser(
  requested: number | undefined,
  acting: number,
  allowOther: boolean
): number {
  if (requested == null) return acting;
  if (requested === acting) return acting;
  if (allowOther) return requested;
  throw new AttributionError(requested, acting);
}

/**
 * Resolve the user id a write tool should attribute its action to: defaults to
 * the acting attorney; a different id requires `allowOther` (the tool's
 * `on_behalf_of` flag), otherwise throws AttributionError.
 */
export async function resolveActingUserId(
  requested: number | undefined,
  allowOther = false
): Promise<number> {
  const acting = await getActingClioUserId();
  return decideAttributedUser(requested, acting, allowOther);
}
