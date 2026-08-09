/**
 * What a viewer may see of a P2P seller — DERIVED, never stored (#92).
 *
 * The `deriveNativeCheckoutEligibility` shape (#57) and the deliberate
 * divergence from `provider_accounts`' one-stored-verdict rule, for the same
 * reason #57 gives: the inputs to this decision live in systems this domain
 * does not own — Oxy's profile privacy, Oxy Trust's tier, Oxy's block graph —
 * so a stored verdict would be a fourth authority able to disagree with all
 * three, and the place that must not happen is a page that keeps rendering
 * somebody who has just made their account private.
 *
 * Every function here is PURE. The reads that feed them live in
 * `viewer-oxy-client.ts` and `seller-trust.ts`, which is what makes each of the
 * four outcomes #92 names — blocked, deleted, privacy-restricted, trust
 * restricted — a case in a unit test rather than a network fixture.
 */

import type { User } from '@oxyhq/core';
import {
  SELLER_TRUST_RESTRICTED_TIERS,
  type PublicSellerTrust,
  type SellerProfileVisibility,
  type SellerProfileWithheldReason,
} from '@mercaria/shared-types';

/** The derived verdict: what to render, and why, when it is not everything. */
export interface SellerVisibilityVerdict {
  visibility: SellerProfileVisibility;
  withheldReason?: SellerProfileWithheldReason;
}

/**
 * Whether the Oxy account restricts its own profile.
 *
 * TWO independent flags, and both are read because they mean different things
 * and either one is the account holder saying no: `isPrivateAccount` is the
 * whole-account switch, `profileVisibility` is the profile-specific one. Absent
 * is NOT private — every field on `PrivacySettings` is optional and the vast
 * majority of accounts send none of them, so treating absence as a restriction
 * would hide the entire marketplace.
 *
 * `profileVisibility` is read as "may this profile be seen", so it restricts
 * when explicitly `false`. Reading it the other way round would invert the
 * setting for everyone who ever touched it, which is the kind of mistake that
 * is invisible until somebody complains their profile is hidden.
 */
export function oxyProfileIsPrivate(user: User): boolean {
  const privacy = user.privacySettings;
  if (!privacy) return false;
  return privacy.isPrivateAccount === true || privacy.profileVisibility === false;
}

/**
 * Whether Oxy Trust's verdict triggers Mercaria's own visibility policy.
 *
 * The membership test is against {@link SELLER_TRUST_RESTRICTED_TIERS} — ONE
 * named constant — which is what makes this "an explicit policy" rather than
 * "a client guess" (#92 reputation rule 6). Mercaria computes no tier, stores
 * no tier and suspends no Oxy account; it reads the canonical service's verdict
 * and decides what its own marketplace surface does about it.
 *
 * An ABSENT trust signal restricts nothing, and the reason is worth stating:
 * `trust` is absent both for an account Oxy Trust has never scored and for a
 * read that failed, and the two are indistinguishable from here. Withholding on
 * absence would turn a reputation-service outage into a marketplace-wide
 * delisting. Mercaria's own enforcement lever — `listings.status = 'restricted'`
 * from a CrowdSource decision — stops sales independently and does not depend
 * on this being reachable.
 */
export function trustTierIsRestricted(trust: PublicSellerTrust | null): boolean {
  if (!trust) return false;
  return (SELLER_TRUST_RESTRICTED_TIERS as readonly string[]).includes(trust.tier);
}

/**
 * The verdict.
 *
 * ORDER IS LOAD-BEARING. Profile privacy is checked first because it is the
 * strictest outcome and it is the account holder's own decision: a private
 * account that also carries a trust restriction discloses nothing either way,
 * and reporting `trust_restricted` for it would leak Oxy Trust's opinion of a
 * person whose profile they have asked nobody be shown.
 *
 * Blocked and deleted accounts never reach here — they are answered as 404 by
 * the service before any verdict is derived, because a visibility STATE for
 * them would be a response distinguishable from an unknown id.
 */
export function deriveSellerVisibility(
  user: User,
  trust: PublicSellerTrust | null,
): SellerVisibilityVerdict {
  if (oxyProfileIsPrivate(user)) {
    return { visibility: 'private', withheldReason: 'oxy_profile_private' };
  }
  if (trustTierIsRestricted(trust)) {
    return { visibility: 'restricted', withheldReason: 'trust_restricted' };
  }
  return { visibility: 'visible' };
}

/**
 * Whether a search engine may index this page (#92 privacy rule 7).
 *
 * Two conjuncts and no third: fully visible, and carrying at least one active
 * listing. A profile with nothing on it is a thin page about a named human
 * being, which is exactly what a minimum-content policy exists to keep out of
 * an index — and a private or restricted profile has no content to index at
 * all. Derived on the SERVER so the policy has one home; a client that decided
 * for itself would be a second one, and the two would drift.
 */
export function deriveSellerIndexable(
  verdict: SellerVisibilityVerdict,
  activeListingCount: number,
): boolean {
  return verdict.visibility === 'visible' && activeListingCount > 0;
}
