/**
 * Generic compatibility reads — "what fits this" and "what does this fit"
 * (#367 step 8, ADR 0007 D8).
 *
 * The reverse read is the one D8 names by name, and it is the reason four
 * partial indexes sit on `generic_compatibility_relations`. What this module
 * adds on top of the repository is the PUBLICATION policy: which verification
 * states may speak, and the asymmetry between a positive and a negative claim.
 * That policy is here rather than in the repository because it is a decision
 * about what a shopper is told, and the repository's job is to find rows.
 */

import type {
  CompatibilityApplicability,
  CompatibilityRelationKind,
  CompatibilitySubject,
  CompatibilityTarget,
  CompatibilityVerificationState,
} from '@mercaria/shared-types';
import {
  listRelationsForSubject,
  listRelationsForTarget,
  type CompatibilityRelationRow,
} from '../../db/compatibility/compatibilityRelationRepository.js';

/**
 * The publication policy, and the asymmetry that is the whole of it.
 *
 * A claim that something FITS is published only when a person or a manufacturer
 * document stands behind it — an unreviewed guess is a purchase somebody makes.
 * A claim that something does NOT fit is published from a wider set, because
 * withholding it sells the thing anyway, and "we are not sure this fits" is the
 * cheapest possible thing to be wrong about.
 *
 * `disputed` publishes NEITHER direction. Two sourced parties contradict each
 * other, and rendering one of them is picking a side, which is exactly what the
 * state exists to avoid; a disputed pairing reads as `unknown`.
 */
const PUBLISHABLE_POSITIVE: readonly CompatibilityVerificationState[] = ['verified'];
const PUBLISHABLE_NEGATIVE: readonly CompatibilityVerificationState[] = [
  'verified',
  'candidate',
  'disputed',
];

export interface CompatibilityReadOptions {
  readonly kinds?: readonly CompatibilityRelationKind[];
  /** ISO 3166-1 alpha-2. A worldwide relation matches every market. */
  readonly market?: string;
  readonly limit?: number;
  /**
   * Include the states a shopper is not shown. For an operator trace only, and
   * named so it reads differently from an ordinary call — there is deliberately
   * no helper that flips it, per the `publicColumns` opt-in convention.
   */
  readonly includeUnpublished?: boolean;
}

/** May this relation be shown to a shopper? See the two tuples above. */
export function publishable(row: {
  readonly applicability: CompatibilityApplicability;
  readonly verification: CompatibilityVerificationState;
}): boolean {
  if (row.applicability === 'unknown') return false;
  if (row.applicability === 'does_not_apply') {
    return PUBLISHABLE_NEGATIVE.includes(row.verification);
  }
  return PUBLISHABLE_POSITIVE.includes(row.verification);
}

/**
 * "What fits this product?" — the reverse read, and an indexed one (D8).
 *
 * The publication filter runs AFTER the query rather than inside it, and the
 * limit is therefore an upper bound on what is examined rather than on what is
 * returned. That is the `stale_at` posture from #68: the SQL narrows on an
 * indexed column and the derivation decides, so a policy change bites at the
 * next read with no sweep having run, and the two can only ever disagree in the
 * direction that shows LESS.
 */
export async function listCompatibleWith(
  target: CompatibilityTarget,
  options: CompatibilityReadOptions = {},
): Promise<CompatibilityRelationRow[]> {
  const rows = await listRelationsForTarget(target, {
    kinds: options.kinds,
    market: options.market,
    limit: options.limit,
  });
  return options.includeUnpublished === true ? rows : rows.filter(publishable);
}

/** "What does this fit?" — the forward read. */
export async function listCompatibilityOf(
  subject: CompatibilitySubject,
  options: CompatibilityReadOptions = {},
): Promise<CompatibilityRelationRow[]> {
  const rows = await listRelationsForSubject(subject, {
    kinds: options.kinds,
    market: options.market,
    limit: options.limit,
  });
  return options.includeUnpublished === true ? rows : rows.filter(publishable);
}
