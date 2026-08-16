/**
 * What a candidate mapping would change, counted, before anybody applies it
 * (#367 Workstream 11).
 *
 * ## This module writes nothing, and that is a scanned gate
 *
 * A preview that could change something is not a preview. `external-mapping-isolation.test.ts`
 * asserts this file imports no writer from the repository and contains no
 * `insert`, `update` or `delete` — because the tempting version of "let me just
 * record that somebody previewed this" is the version that opens a review row
 * for a token an operator was only looking at.
 *
 * ## Every number here is exact, or it is not printed
 *
 * The counts are `count(*)` over rows this domain owns, so when
 * `coverage === 'measured'` they are exact rather than sampled. When this domain
 * has never recorded an observation for the source and dimension, the coverage
 * is `no_observations_recorded` and the observation counts are ZERO but must not
 * be read as zero IMPACT — they are unknown. #82's `unmeasured`, applied to an
 * impact estimate, and the reason it matters is that a confident `0` is the one
 * output that would get a bad mapping approved without argument.
 *
 * The seam that produces the gap is named rather than hidden: nothing in
 * ingestion calls `resolveExternalToken` yet, so nothing populates
 * `catalog_external_token_observations`. See `docs/catalog-external-mappings.md`
 * §"Seams".
 */

import type {
  CatalogExternalMappingDimension,
  CatalogExternalMappingImpact,
  CatalogExternalTarget,
  CatalogExternalTransformRule,
  CatalogExternalUnresolvedReason,
} from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  controlledValueIsResolvable,
  findActiveAttributeVersion,
} from '../../db/catalogExternalMappings/conceptReadRepository.js';
import {
  countOpenReviewsForToken,
  hasRecordedObservations,
  readLiveMappings,
  tallyTokenObservations,
} from '../../db/catalogExternalMappings/externalMappingRepository.js';
import { resolveUnit, unitFamilyOf } from '../canonical/units.js';
import { conceptExists } from './concept-registry.port.js';
import { columnsToTarget, targetsAgree } from './target.js';
import { isTransformRuleRegistered, latestTransformRuleVersion } from './transform-rules.js';

/** The mapping somebody is thinking about creating. */
export interface PreviewCandidateInput {
  readonly catalogSourceId: string;
  readonly dimension: CatalogExternalMappingDimension;
  readonly externalKey: string;
  readonly target: CatalogExternalTarget;
  readonly transformRule?: CatalogExternalTransformRule;
  readonly transformRuleVersion?: number;
  readonly at: Date;
}

/**
 * Count what a candidate would change.
 *
 * Reads only. The target check is the SAME derivation the resolver performs, so
 * a preview cannot report a target as fine that the resolver would then refuse —
 * two spellings of one rule can disagree, and here the disagreement would be
 * discovered after approval.
 */
export async function previewCandidateMapping(
  input: PreviewCandidateInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogExternalMappingImpact> {
  if (input.target.dimension !== input.dimension) {
    throw validationError(
      `A ${input.dimension} mapping cannot carry a ${input.target.dimension} target.`,
    );
  }
  const transformRule = input.transformRule ?? 'identity';
  const transformRuleVersion =
    input.transformRuleVersion ?? latestTransformRuleVersion(transformRule);
  if (!isTransformRuleRegistered(transformRule, transformRuleVersion)) {
    throw validationError(
      `No transform rule '${transformRule}' at version ${transformRuleVersion} ships in this image.`,
    );
  }

  const live = await readLiveMappings(
    input.catalogSourceId,
    input.dimension,
    input.externalKey,
    input.at,
    db,
  );

  const equivalent: string[] = [];
  let conflicting = 0;
  for (const row of live) {
    const existing = columnsToTarget(row.dimension, row);
    if (existing !== null && targetsAgree(existing, input.target)) {
      equivalent.push(row.id);
    } else {
      conflicting += 1;
    }
  }

  const [openReviews, coverageKnown, tally, targetVerdict] = await Promise.all([
    countOpenReviewsForToken(input.catalogSourceId, input.dimension, input.externalKey, db),
    hasRecordedObservations(input.catalogSourceId, input.dimension, db),
    tallyTokenObservations(
      {
        catalogSourceId: input.catalogSourceId,
        dimension: input.dimension,
        externalKey: input.externalKey,
        equivalentMappingIds: equivalent,
      },
      db,
    ),
    verifyCandidateTarget(input.target, db),
  ]);

  return {
    coverage: coverageKnown ? 'measured' : 'no_observations_recorded',
    // A candidate supersedes the mappings it AGREES with only in the sense of
    // being a redundant restatement; what it displaces is the conflicting set.
    // Reported separately so a reviewer can see both, because "this replaces
    // three mappings" and "this contradicts three mappings" are different
    // sentences and only the second needs a second operator.
    supersededMappings: equivalent.length,
    conflictingMappings: conflicting,
    openReviewsAnswered: openReviews,
    observationsAffected: tally.total,
    observationsRetargeted: tally.resolvedElsewhere,
    observationsNewlyMapped: tally.unresolved,
    targetResolves: targetVerdict === null,
    ...(targetVerdict === null ? {} : { targetUnresolvedReason: targetVerdict }),
    requiresFanOutApproval: conflicting > 0,
  };
}

/**
 * Whether a candidate's target resolves. `null` means it does.
 *
 * Deliberately shaped as "the reason it does NOT", so the caller cannot report
 * `targetResolves: true` beside a reason — the two fields come from one value.
 */
async function verifyCandidateTarget(
  target: CatalogExternalTarget,
  db?: DatabaseOrTransaction,
): Promise<CatalogExternalUnresolvedReason | null> {
  switch (target.dimension) {
    case 'attribute':
      return (await findActiveAttributeVersion(target.attributeKey, db)) === null
        ? 'target_unresolvable'
        : null;
    case 'controlled_value':
      return (await controlledValueIsResolvable(target.attributeKey, target.controlledValue, db))
        ? null
        : 'target_unresolvable';
    case 'unit': {
      const canonical = resolveUnit(target.unitCode);
      if (canonical === null) return 'target_unresolvable';
      return unitFamilyOf(canonical) === target.unitFamily ? null : 'target_unresolvable';
    }
    case 'product_type':
    case 'size_system': {
      const key =
        target.dimension === 'product_type' ? target.productTypeKey : target.sizeSystemKey;
      const existence = await conceptExists(target.dimension, key);
      if (existence.state === 'present') return null;
      return existence.state === 'unavailable' ? 'registry_unavailable' : 'target_unresolvable';
    }
  }
}
