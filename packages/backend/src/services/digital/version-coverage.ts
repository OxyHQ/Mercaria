/**
 * Which asset version a buyer's right actually covers — the whole of ADR 0010 D4.
 *
 * #1015 W0 question 4 asks whether updates are included *"forever, only within a
 * major version, or according to the offer/license rule"*, and the answer is the
 * third, which means this function exists and is the only place the rule is
 * applied. Anything that resolved it a second way would be a second answer to
 * "what may this buyer download", and the two would disagree for exactly the
 * buyers who had bought an update-bearing licence.
 *
 * ## The rule is PURE, and that is why it is here rather than in a query
 *
 * It takes the right's pinned version, its policy, and the versions that exist,
 * and returns one version. No database, no clock, no configuration — so a test
 * drives it directly over every policy × every version shape, which is the
 * evidence #1015 acceptance criterion 5 asks for and a SQL predicate cannot
 * provide.
 */

import type { AssetVersionState, DigitalLicenceUpdatePolicy } from '@mercaria/shared-types';
import { DOWNLOADABLE_ASSET_VERSION_STATES } from '@mercaria/shared-types';

/** The part of an asset version this rule reads. Deliberately minimal. */
export interface CoverableVersion {
  readonly id: string;
  readonly label: string;
  readonly majorVersion: number;
  readonly state: AssetVersionState;
  /** NULL for a version that was never published, which cannot be covered. */
  readonly publishedAt: Date | null;
}

/**
 * The newest version `policy` entitles the holder of `purchasedVersion` to.
 *
 * Returns the purchased version itself when nothing newer qualifies — never
 * `null`, because a right always covers what was bought. That is the load-bearing
 * default: a function that could answer "nothing" would make a creator's
 * publication schedule able to revoke a purchase.
 *
 * A version is a candidate only if it is DOWNLOADABLE, which includes `superseded`
 * and `withdrawn` (ADR 0010 D7) and excludes `restricted` — a moderation closure
 * stops access, and it is the one state that does.
 */
export function coveredVersion(
  purchasedVersion: CoverableVersion,
  policy: DigitalLicenceUpdatePolicy,
  versions: readonly CoverableVersion[],
): CoverableVersion {
  if (policy === 'purchased_version_only') {
    return purchasedVersion;
  }
  const purchasedAt = purchasedVersion.publishedAt;
  if (purchasedAt === null) {
    // A right pinned to an unpublished version is not a shape the grant path can
    // produce — `ACQUIRABLE_ASSET_VERSION_STATES` is `['published']` — but if one
    // ever existed, "later than it" is unanswerable and the honest result is the
    // version that was bought.
    return purchasedVersion;
  }

  let best = purchasedVersion;
  let bestAt = purchasedAt;
  for (const candidate of versions) {
    if (candidate.id === purchasedVersion.id) continue;
    if (candidate.publishedAt === null) continue;
    if (!DOWNLOADABLE_ASSET_VERSION_STATES.includes(candidate.state)) continue;
    if (candidate.publishedAt <= bestAt) continue;
    if (
      policy === 'same_major_version' &&
      candidate.majorVersion !== purchasedVersion.majorVersion
    ) {
      continue;
    }
    best = candidate;
    bestAt = candidate.publishedAt;
  }
  return best;
}

/**
 * Whether a right pinned to `purchasedVersion` under `policy` covers `versionId`.
 *
 * Not `coveredVersion(...).id === versionId`: a buyer entitled to v3 is entitled to
 * v1 and v2 as well, because what they bought does not stop being theirs when
 * something newer arrives. The authorizer asks THIS question, and getting it
 * wrong in the tempting direction would make every update silently withdraw the
 * version the buyer had already downloaded.
 */
export function coversVersion(
  purchasedVersion: CoverableVersion,
  policy: DigitalLicenceUpdatePolicy,
  versions: readonly CoverableVersion[],
  versionId: string,
): boolean {
  if (versionId === purchasedVersion.id) return true;
  const target = versions.find((version) => version.id === versionId);
  if (!target || target.publishedAt === null) return false;
  if (!DOWNLOADABLE_ASSET_VERSION_STATES.includes(target.state)) return false;
  const ceiling = coveredVersion(purchasedVersion, policy, versions);
  if (ceiling.publishedAt === null) return false;
  if (target.publishedAt > ceiling.publishedAt) return false;
  if (purchasedVersion.publishedAt !== null && target.publishedAt < purchasedVersion.publishedAt) {
    // Older than what was bought. Not covered: a buyer who paid for v2 did not buy
    // the v1 the creator had already replaced, and handing it over would leak a
    // release the creator may have withdrawn for a reason.
    return false;
  }
  if (policy === 'same_major_version' && target.majorVersion !== purchasedVersion.majorVersion) {
    return false;
  }
  return true;
}

/**
 * The leading integer of a creator's version label, or 0 when it has none.
 *
 * `0` is not a failure and is documented as a real answer: a creator numbering
 * releases `spring-2026` gets 0 for every one of them, so `same_major_version`
 * behaves as `purchased_version_only` for them. ADR 0010 D4 states that rather
 * than leaving it to be discovered, because the alternative is a policy whose
 * meaning depends on a string nobody validated.
 */
export function majorVersionOf(label: string): number {
  const match = /^\s*(\d+)/.exec(label);
  if (!match) return 0;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
