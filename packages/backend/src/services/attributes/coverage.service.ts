/**
 * Attribute completeness, measured by category, source and field
 * (#94 coverage rules 1 and 3).
 *
 * A live query, never a stored number — the reasoning is on the schema file. The
 * job here is to give the measurement a DENOMINATOR that makes it honest: the
 * attributes a category's registry says apply, not the attributes some value
 * happens to exist for. Measured the second way, a category where nobody has
 * ever recorded screen size reports 100 % coverage of the two attributes it does
 * have, which is the exact opposite of what the report is for.
 */

import type { AttributeCoverageCell, AttributeEntityKind } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { measureAttributeCoverage } from '../../db/attributes/attributeOpsRepository.js';
import {
  resolveAllActiveDefinitions,
  resolveDefinitionsForCategory,
} from './definition-registry.service.js';

export interface CoverageRequest {
  readonly entityKind: AttributeEntityKind;
  readonly categoryId?: string;
  readonly catalogSourceId?: string;
}

/**
 * Completeness for one scope.
 *
 * The key list comes from the REGISTRY: every active definition that applies to
 * the category (or every active definition, unscoped). An attribute with zero
 * recorded values is therefore a row reading `observedCount: 0` against a real
 * denominator — the most interesting cell in the report, and the one a
 * value-derived key list could not produce.
 */
export async function measureCoverage(
  db: DatabaseOrTransaction,
  request: CoverageRequest,
): Promise<AttributeCoverageCell[]> {
  const definitions =
    request.categoryId === undefined
      ? await resolveAllActiveDefinitions(db)
      : await resolveDefinitionsForCategory(db, request.categoryId);

  const attributeKeys = definitions.map((definition) => definition.row.key);

  return measureAttributeCoverage(db, {
    entityKind: request.entityKind,
    ...(request.categoryId === undefined ? {} : { categoryId: request.categoryId }),
    ...(request.catalogSourceId === undefined ? {} : { catalogSourceId: request.catalogSourceId }),
    attributeKeys,
  });
}

/**
 * The launch-priority ordering (#94 coverage rule 3).
 *
 * "Prioritize attributes required by launch search use cases rather than
 * attempting every product category simultaneously" is a report-ordering
 * decision, not a schema one: the registry already says which attributes can
 * EXCLUDE a product, and those are precisely the ones whose gaps cost a shopper
 * results. Sorting by that puts the work that matters at the top without needing
 * a hand-maintained list of "important" attributes that would go stale.
 */
export function prioritizeCoverage(
  cells: readonly AttributeCoverageCell[],
  hardConstraintCapableKeys: ReadonlySet<string>,
): AttributeCoverageCell[] {
  return [...cells].sort((left, right) => {
    const leftHard = hardConstraintCapableKeys.has(left.attributeKey) ? 1 : 0;
    const rightHard = hardConstraintCapableKeys.has(right.attributeKey) ? 1 : 0;
    if (leftHard !== rightHard) return rightHard - leftHard;
    return completenessOf(left) - completenessOf(right);
  });
}

/** Selected values over eligible entities, in [0, 1]. An empty scope is complete. */
export function completenessOf(cell: AttributeCoverageCell): number {
  if (cell.eligibleCount === 0) return 1;
  return cell.selectedCount / cell.eligibleCount;
}
