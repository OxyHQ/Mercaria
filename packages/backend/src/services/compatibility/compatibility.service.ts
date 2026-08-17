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
 * **`disputed` follows the same asymmetry rather than escaping it**, and the two
 * tuples below are the whole statement of it. A disputed POSITIVE publishes
 * nothing: two sourced parties contradict each other about whether a part fits,
 * and rendering one of them is picking the side that makes a sale. A disputed
 * NEGATIVE is published, because it is a caution — somebody credible says this
 * does not fit, and suppressing that until a reviewer arrives sells the part in
 * the meantime.
 *
 * Stated at length because this file used to claim the opposite in prose —
 * "`disputed` publishes NEITHER direction" — while `PUBLISHABLE_NEGATIVE` listed
 * it, and nothing tested the sentence. `brake-pad.ts` described the same tuple
 * accurately, so the repository carried two readings of one rule with no way to
 * tell which was meant. The behaviour was and is the safe one; the comment was
 * wrong, and `compatibility-public-read.realdb.test.ts` now pins it.
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

/** One page of relations, and whether the query's own bound was reached. */
export interface CompatibilityRelationPage {
  readonly relations: readonly CompatibilityRelationRow[];
  readonly examinedLimit: number;
  readonly truncated: boolean;
}

/**
 * A bounded page of either direction, for the PUBLIC read.
 *
 * It exists because `truncated` is not something a caller can work out from the
 * returned rows: the publication filter runs after the query, so a page that
 * examined its full limit can return three rows, and `rows.length < limit` is
 * therefore no evidence that the end was reached. The bound is measured with
 * `limit + 1` and the extra row is discarded — the alternative, comparing
 * `rows.length` against the limit, over-reports on every exact multiple, and here
 * over-reporting means telling a shopper there is more to see when the list is
 * complete.
 *
 * `includeUnpublished` is deliberately NOT a parameter. This is the shopper's
 * read; an operator's trace reads a relation by id.
 */
export async function readCompatibilityRelationPage(
  scope:
    | { readonly lookup: 'subject'; readonly subject: CompatibilitySubject }
    | { readonly lookup: 'target'; readonly target: CompatibilityTarget },
  options: { readonly kinds?: readonly CompatibilityRelationKind[]; readonly market?: string; readonly limit: number },
): Promise<CompatibilityRelationPage> {
  const read: CompatibilityReadOptions = {
    ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
    ...(options.market === undefined ? {} : { market: options.market }),
    limit: options.limit + 1,
    // Unfiltered on purpose, and then filtered below through the SAME
    // `publishable` the two service reads use — never a second spelling of the
    // policy. Truncation has to be measured on what the QUERY returned: filtering
    // first and then comparing the length against the bound reports NOT truncated
    // whenever the discarded row was one the policy withheld, which is a page
    // claiming to be complete because part of it was suppressed.
    includeUnpublished: true,
  };
  const examined =
    scope.lookup === 'subject'
      ? await listCompatibilityOf(scope.subject, read)
      : await listCompatibleWith(scope.target, read);
  const truncated = examined.length > options.limit;
  const page = truncated ? examined.slice(0, options.limit) : examined;
  return {
    relations: page.filter(publishable),
    examinedLimit: options.limit,
    truncated,
  };
}
