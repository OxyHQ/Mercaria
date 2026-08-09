/**
 * RIGHTS — issue #62 §"Rights and controlled extraction", and the ONE
 * derivation every consumer reads.
 *
 * Nine rights, one pure function, and a refusal that names the missing right
 * rather than saying "forbidden". `forbidden-evidence.ts` (#121) is the shape:
 * an answer that says which prohibition applied is actionable and an
 * "unrecognized" is not.
 *
 * ## Two inputs, because a right can be withdrawn two different ways
 *
 * The POLICY says what the agreement with the source permits. The source's
 * STATUS says what Mercaria is currently willing to do with it. Those are
 * genuinely different facts — a policy that permits display is still a policy
 * that permits display while an incident has the source paused — and
 * collapsing them would mean an incident pause could only be undone by
 * re-authoring the rights somebody reviewed.
 *
 * The conjunction is stated ONCE here. `catalog_sources`' three coarse columns
 * are a projection of it, and the deferred constraint trigger
 * `mercaria_catalog_source_rights_agree` refuses any commit where they
 * disagree — so this function and the database cannot drift, and a realdb test
 * drives the whole (status × policy) matrix through both.
 *
 * ## No active policy means NO rights, not default rights
 *
 * A source registered but never reviewed permits nothing: no storage, no
 * display, no refresh, no extraction. "Controlled extraction must have an
 * explicit policy/terms review before activation" is the issue's rule for the
 * riskiest source type, and it generalises for the same reason it was written —
 * a right nobody reviewed is a right nobody granted.
 */

import type {
  CatalogSourceRight,
  CatalogSourceRightsVerdict,
  CatalogSourceStatus,
} from '@mercaria/shared-types';
import {
  CATALOG_SOURCE_DISPLAYABLE_STATUSES,
  CATALOG_SOURCE_REFRESHABLE_STATUSES,
  CATALOG_SOURCE_RIGHTS,
} from '@mercaria/shared-types';
import { forbidden } from '../../lib/errors/error-codes.js';

/** The policy fields this derivation reads. A row satisfies it structurally. */
export interface SourcePolicyRights {
  readonly mayDisplay: boolean;
  readonly mayStore: boolean;
  readonly mayCache: boolean;
  readonly cacheTtlSeconds: number | null;
  readonly mayDisplayPrice: boolean;
  readonly mayDisplayMedia: boolean;
  readonly mayLinkOut: boolean;
  readonly mayAppendAffiliateParams: boolean;
  readonly mayIndex: boolean;
  readonly mayRefreshAutomatically: boolean;
  readonly extractionMode: 'disallowed' | 'robots_respecting' | 'contracted';
  readonly attributionRequired: boolean;
}

/** Every right false — what a source with no active policy permits. */
const NO_RIGHTS: CatalogSourceRightsVerdict = Object.freeze(
  Object.fromEntries(CATALOG_SOURCE_RIGHTS.map((right) => [right, false])),
) as CatalogSourceRightsVerdict;

/**
 * The effective rights of one source right now.
 *
 * @param status The config's lifecycle. `draft` and `revoked` permit nothing;
 *   `paused` permits everything the policy does EXCEPT refreshing, which is
 *   what pausing means; `failed` stays fully refreshable, because a source that
 *   answered 500 once must retry without a person re-enabling it.
 * @param policy The ACTIVE version's rights, or `null` when none is active.
 */
export function resolveSourceRights(
  status: CatalogSourceStatus,
  policy: SourcePolicyRights | null,
): CatalogSourceRightsVerdict {
  if (policy === null) return NO_RIGHTS;
  if (!CATALOG_SOURCE_DISPLAYABLE_STATUSES.includes(status)) return NO_RIGHTS;

  const mayRefresh =
    policy.mayRefreshAutomatically && CATALOG_SOURCE_REFRESHABLE_STATUSES.includes(status);

  return Object.freeze({
    store: policy.mayStore,
    cache: policy.mayCache,
    display_price: policy.mayDisplayPrice,
    display_media: policy.mayDisplayMedia,
    outbound_link: policy.mayLinkOut,
    affiliate_params: policy.mayAppendAffiliateParams,
    index: policy.mayIndex,
    automated_refresh: mayRefresh,
    // Extraction beyond `disallowed` is itself a fetch, so a paused source may
    // not extract either — the refresh rule applies to the mechanism that
    // reaches out, whichever right authorises it.
    extraction: policy.extractionMode !== 'disallowed' && mayRefresh,
  });
}

/**
 * The three coarse columns `catalog_sources` projects.
 *
 * `may_display` is the umbrella the price and media rights narrow, so it comes
 * from the policy's own umbrella rather than from their disjunction: a source
 * permitted to show a merchant's NAME and neither its price nor its images is
 * a real agreement, and reading `may_display` as "price or media" would erase
 * it.
 *
 * `attribution_required` defaults to TRUE with no active policy. It is the only
 * one of the three whose safe default is not `false`, and it costs nothing:
 * with `may_display` false there is nothing to attribute, and if that ever
 * changes the conservative answer is to name the source.
 */
export function projectedSourceRights(
  status: CatalogSourceStatus,
  policy: SourcePolicyRights | null,
): { mayDisplay: boolean; mayStore: boolean; attributionRequired: boolean } {
  if (policy === null || !CATALOG_SOURCE_DISPLAYABLE_STATUSES.includes(status)) {
    return { mayDisplay: false, mayStore: false, attributionRequired: true };
  }
  return {
    mayDisplay: policy.mayDisplay,
    mayStore: policy.mayStore,
    attributionRequired: policy.attributionRequired,
  };
}

/** How long a cached copy of this source's facts may live, in seconds. */
export function cacheTtlSeconds(
  status: CatalogSourceStatus,
  policy: SourcePolicyRights | null,
): number | null {
  if (policy === null) return null;
  if (!resolveSourceRights(status, policy).cache) return null;
  return policy.cacheTtlSeconds;
}

/**
 * A refusal that names the right, in words an operator can act on.
 *
 * 403 rather than 404: the source exists and the caller may know it does — this
 * surface is behind an operator allow-list, so there is no enumeration oracle
 * to protect, and telling somebody "your feed cannot be refreshed because the
 * policy does not permit automated refresh" is the whole point of naming the
 * nine rights separately.
 */
export function refuseForRight(sourceName: string, right: CatalogSourceRight): never {
  throw forbidden(
    `Source '${sourceName}' has no '${right}' right under its active policy. ` +
      'Publish and activate a policy version that grants it.',
  );
}

/** Assert one right, or refuse naming it. */
export function assertRight(
  sourceName: string,
  rights: CatalogSourceRightsVerdict,
  right: CatalogSourceRight,
): void {
  if (!rights[right]) refuseForRight(sourceName, right);
}
