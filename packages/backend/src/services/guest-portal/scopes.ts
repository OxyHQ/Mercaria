/**
 * What a portal credential may do — decided HERE and nowhere else (#108).
 *
 * ## Scope is bound server-side, and that is a shape rather than a check
 *
 * #108 magic-link rule 7 asks that purpose, checkout and scope be bound
 * server-side "rather than trusting URL parameters". The strongest form of that
 * is not validating a client's request — it is having nowhere for one to
 * arrive: {@link resolveGrantScopes} takes an ORIGIN and a verification state
 * and no caller-supplied value at all, no route schema accepts a `scopes`
 * field, and the emailed link carries one opaque token and nothing else. A
 * request asking for `orders:read` is not refused; it is unrepresentable.
 *
 * ## Two independent walls, and neither is sufficient alone
 *
 * An unverified grant is held to {@link UNVERIFIED_GRANTABLE_SCOPES} by a
 * database CHECK, so the schema refuses a row this function would never build.
 * Full order detail additionally requires `emailVerified` in
 * `authorizeOrderAccess` (#106), which is a different module reading a
 * different field. Either wall alone would hold; both exist because the
 * failure — an unverified credential reading a stranger's address — is silent,
 * and a silent failure deserves a second reader.
 */

import {
  GUEST_ORDER_SCOPES,
  UNGRANTABLE_GUEST_ORDER_SCOPES,
  UNVERIFIED_GRANTABLE_SCOPES,
  type GuestOrderGrantOrigin,
  type GuestOrderScope,
} from '@mercaria/shared-types';

/**
 * Everything a VERIFIED portal credential carries.
 *
 * Derived by SUBTRACTION from the full tuple rather than listed, so a scope
 * added later is granted by default and a scope that must not be granted has to
 * be named in {@link UNGRANTABLE_GUEST_ORDER_SCOPES}. The direction matters:
 * listing them positively would make a new scope silently ungrantable, which
 * fails in the shape nobody notices (a feature that quietly does not work),
 * while this direction fails in the shape somebody notices immediately (a scope
 * appearing that nobody meant to hand out) — and the disjointness test below is
 * what turns that into a build failure rather than an incident.
 *
 * `#80`'s `CONFIDENT_LINK_METHODS` is the precedent; the reasoning there was
 * the mirror image, and the difference is which mistake is louder.
 */
export const VERIFIED_GRANT_SCOPES: readonly GuestOrderScope[] = GUEST_ORDER_SCOPES.filter(
  (scope) => !UNGRANTABLE_GUEST_ORDER_SCOPES.includes(scope),
);

/**
 * The scopes a grant of this origin and verification state receives.
 *
 * Total over the inputs, and the inputs are the whole of what decides: there is
 * no checkout-group parameter, no seller parameter and no client hint, because
 * scope answers "what may this KIND of proof do" and the group is what the
 * grant row itself names.
 *
 * @param origin - `post_checkout` (proof of a device) or `magic_link` (proof of
 *   an inbox).
 * @param emailVerified - whether a magic link was actually consumed. A
 *   `magic_link` origin with `false` is the EXCHANGE token itself, which
 *   carries the scopes it will confer once consumed.
 */
export function resolveGrantScopes(
  origin: GuestOrderGrantOrigin,
  emailVerified: boolean,
): GuestOrderScope[] {
  if (origin === 'post_checkout') {
    // Proof of a device, so ADR 0003 D17's prospective half and nothing more.
    // The array is copied because the caller stores it and a shared frozen
    // constant reaching a drizzle `values()` is one refactor away from being
    // mutated by whoever adds a scope conditionally.
    return [...UNVERIFIED_GRANTABLE_SCOPES];
  }
  return emailVerified ? [...VERIFIED_GRANT_SCOPES] : [...UNVERIFIED_GRANTABLE_SCOPES];
}

/**
 * The scopes an EXCHANGE token confers once consumed.
 *
 * Stored on the exchange row so the link's authority is decided when the link
 * is SENT rather than when it is clicked. That matters for one case: a policy
 * change between sending and clicking must not silently widen a link already in
 * somebody's inbox, and reading the policy at consume time is exactly how it
 * would.
 */
export function resolveExchangeScopes(): GuestOrderScope[] {
  return [...VERIFIED_GRANT_SCOPES];
}

/** Whether a live credential's scope set permits an action. */
export function grantHasScope(
  scopes: readonly string[],
  required: GuestOrderScope,
): boolean {
  return scopes.includes(required);
}
