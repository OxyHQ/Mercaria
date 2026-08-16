/**
 * Reconciling this layer with #94's `attribute_source_mappings`
 * (#367 Workstream 11).
 *
 * ## The overlap, stated plainly
 *
 * `attribute_source_mappings` already answers "what does this source's field
 * name mean" — `(catalog_source_id, source_field) → attribute_key`, plus an
 * `assumed_unit` and a `component_axis`. That IS the external-attribute-mapping
 * responsibility for one of this domain's five dimensions, and it landed first.
 *
 * What it does not carry is the governance Workstream 11 requires of every
 * mapping: no version, no confidence, no review state, no provenance and no
 * validity window. Its unique is `(catalog_source_id, source_field)` — exactly
 * one row per field, forever — so it cannot express a supersession, a validity
 * window or a reviewed fan-out even in principle. A mapping with no review state
 * also cannot satisfy "an unmapped or ambiguous value goes to REVIEW, never to a
 * guess", because there is nothing on the row that could be un-reviewed.
 *
 * ## What this branch did about it, and what it did not
 *
 * It did NOT extend that table, and the reason is territorial rather than
 * technical: `db/schema/attributeRegistry.ts` belongs to another agent in this
 * parallel batch and editing it would have been a cross-branch conflict on the
 * one file the localization workstream is also reshaping. The recommended
 * reconciliation is in `docs/catalog-external-mappings.md` §"The
 * `attribute_source_mappings` overlap" and is a `post` migration somebody else
 * owns.
 *
 * Until that lands, the two coexist under three rules, all of which are here:
 *
 * 1. **This domain never WRITES `attribute_source_mappings`.** A scanned gate
 *    fails the build if any module in the domain does. #94 owns that table.
 * 2. **A governed mapping WINS.** The resolver consults the legacy row only when
 *    nothing governed answers, and marks the answer `legacy_registry` so no
 *    caller can mistake it for a reviewed decision.
 * 3. **A disagreement is RECORDED, never resolved by a rule.** Detection and
 *    repair are separate acts — the `payment_discrepancies` posture — because
 *    "which of these two people was right" is not a question a precedence rule
 *    should be answering silently on a live catalogue.
 *
 * The alternative to reading the legacy table at all was considered and refused:
 * ignoring it would silently un-map every field a deployment had already
 * configured, on the deploy that adopted this domain, with no error anywhere.
 */

import type {
  CatalogExternalLegacyReconciliation,
  CatalogExternalMappingDimension,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  readLegacyAttributeMappings,
  readLiveMappings,
  readLiveMappingsForDimension,
} from '../../db/catalogExternalMappings/externalMappingRepository.js';
import { columnsToTarget } from './target.js';
import { openLegacyDisagreementReview } from './review.service.js';

const ATTRIBUTE: CatalogExternalMappingDimension = 'attribute';

/**
 * Compare the governed mappings with #94's registry for one source.
 *
 * Counts, names the disagreements, and stops. Nothing here rewrites, deletes or
 * migrates a legacy row: the migration is a decision with a `post` migration
 * behind it, and a function that quietly performed it would make the backlog
 * this report exists to size disappear without anybody having approved it.
 *
 * `governedOnly` is counted too, deliberately. A report that only counted the
 * backlog would read as though the governed layer were behind, when the ordinary
 * state after adoption is that it is ahead.
 */
export async function reconcileLegacyAttributeMappings(
  input: {
    readonly catalogSourceId: string;
    readonly at: Date;
    /**
     * Whether to open a review row for each disagreement.
     *
     * Off by default, so the report is a pure read — the preview's rule. An
     * operator asks for the rows once, having read the report, rather than
     * generating a queue by looking.
     */
    readonly openReviews?: boolean;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogExternalLegacyReconciliation> {
  const legacy = await readLegacyAttributeMappings(input.catalogSourceId, db);

  let agreeing = 0;
  let legacyOnly = 0;
  const disagreements: {
    sourceField: string;
    legacyAttributeKey: string;
    governedAttributeKey: string;
    governedMappingId: string;
  }[] = [];
  const covered = new Set<string>();

  for (const row of legacy) {
    const live = await readLiveMappings(
      input.catalogSourceId,
      ATTRIBUTE,
      row.sourceField,
      input.at,
      db,
    );
    if (live.length === 0) {
      legacyOnly += 1;
      continue;
    }
    for (const mapping of live) covered.add(mapping.id);

    // A fanned-out token agrees with the legacy row if ANY of its approved
    // targets names the same attribute: the legacy table cannot express a
    // fan-out, so its single answer being one of several reviewed ones is not a
    // disagreement — it is the legacy row being less specific.
    // The literal `'attribute'` rather than the `ATTRIBUTE` constant: a `const`
    // typed as the whole dimension union does not NARROW the target union, so
    // the comparison would compile and the property read after it would not.
    const matched = live.some((mapping) => {
      const target = columnsToTarget(mapping.dimension, mapping);
      return target !== null && target.dimension === 'attribute'
        && target.attributeKey === row.attributeKey;
    });

    if (matched) {
      agreeing += 1;
      continue;
    }

    const first = live[0];
    const firstTarget = first === undefined ? null : columnsToTarget(first.dimension, first);
    const governedKey =
      firstTarget !== null && firstTarget.dimension === 'attribute' ? firstTarget.attributeKey : '';
    disagreements.push({
      sourceField: row.sourceField,
      legacyAttributeKey: row.attributeKey,
      governedAttributeKey: governedKey,
      governedMappingId: first === undefined ? '' : first.id,
    });

    if (input.openReviews === true) {
      await openLegacyDisagreementReview(
        {
          catalogSourceId: input.catalogSourceId,
          sourceField: row.sourceField,
          legacyAttributeKey: row.attributeKey,
          governedAttributeKey: governedKey,
          at: input.at,
        },
        db,
      );
    }
  }

  // Every live governed attribute mapping the walk above did NOT touch — that
  // is, one whose token no legacy row names. Read as its own statement: deriving
  // it from the legacy field list would make it structurally zero, and a zero
  // that cannot be anything else is a number that looks like agreement and
  // measures nothing.
  const allGoverned = await readLiveMappingsForDimension(
    input.catalogSourceId,
    ATTRIBUTE,
    input.at,
    db,
  );
  const governedOnly = allGoverned.filter((mapping) => !covered.has(mapping.id)).length;

  return {
    catalogSourceId: input.catalogSourceId,
    agreeing,
    legacyOnly,
    governedOnly,
    disagreements,
  };
}
