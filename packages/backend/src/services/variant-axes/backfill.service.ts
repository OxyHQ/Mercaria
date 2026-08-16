/**
 * The legacy-option backfill (#367 step 4, ADR 0007 D6).
 *
 * Turning `listing_options` and `product_variant_option_values` into typed axes
 * where — and ONLY where — the registry can settle them unambiguously, while
 * preserving every one of them verbatim as a retained claim (ADR 0007 D7).
 *
 * ## The four properties, and the mechanism for each
 *
 * - **Fails safe.** Every resolution goes through `legacy-resolution.ts`, which
 *   is pure and refuses by name. Nothing in this file resolves anything itself,
 *   so "the backfill invented a normalization" is not a thing a diff to this
 *   file could do. A listing whose data cannot be settled ends the pass with its
 *   legacy rows untouched, its claims recorded and a COUNT against a named cause.
 * - **Idempotent.** Claims converge on `<table>_identity_key` with
 *   `ON CONFLICT DO NOTHING` — a genuine no-op, not a write that moves
 *   `updated_at`. Axes converge on `(listing_id, attribute_key)`. Assignments and
 *   signatures are re-DERIVED from the legacy rows every pass, so a second run
 *   over unchanged data writes nothing and reports it.
 * - **Resumable.** A keyset cursor over listing ids, returned in the report. A
 *   crashed pass is resumed with `--after`; a pass re-run from zero is a no-op by
 *   the point above, which is the property that makes the cursor a convenience
 *   rather than a correctness requirement.
 * - **Dry-runnable, and the dry run measures the APPLY.** Both modes run the
 *   identical code inside a transaction; a dry run rolls it back. Not a parallel
 *   "predict" path — a prediction is a second implementation, and the two
 *   disagree exactly where it matters. A dry run therefore also hits every
 *   trigger and every unique index the apply would hit, so a listing that would
 *   fail is reported as failing rather than as fine.
 *
 * ## The vacuity floor
 *
 * Every legacy row gets EXACTLY ONE outcome, and the outcome counters SUM to the
 * scanned counts by EQUALITY. `assertReportSums` refuses to return a report whose
 * sums disagree — `catalog_backfill_runs_counters_total_check`'s rule applied to
 * a script, because "a page that swallowed a record" and "a clean run" produce
 * the same output otherwise.
 *
 * ## No run table, deliberately
 *
 * #60's `catalog_backfill_runs` is the canonical-graph migration and its stages
 * are about canonical entities; a second run table here would be a second
 * representation of a fact the claim rows already carry. "What could not be
 * resolved" is a QUERY over `<table>.attribute_refusal` / `.value_refusal`
 * (`countQueuedClaims`), which cannot go stale the way a stored counter can —
 * `attribute_coverage_runs`' absence, one domain over, for the same reason.
 */

import { TransactionRollbackError } from 'drizzle-orm';
import type {
  VariantAxisAttributeRefusal,
  VariantAxisBackfillReport,
  VariantAxisValueRefusal,
} from '@mercaria/shared-types';
import {
  VARIANT_AXIS_ATTRIBUTE_REFUSALS,
  VARIANT_AXIS_VALUE_REFUSALS,
} from '@mercaria/shared-types';
import type { Database, DatabaseOrTransaction } from '../../db/postgres.js';
import {
  countListingsWithLegacyOptions,
  listLegacyListingOptions,
  listLegacyVariantOptionValues,
  listListingIdsWithLegacyOptions,
  listVariantsForListings,
  type LegacyListingOptionRow,
  type LegacyVariantOptionValueRow,
} from '../../db/variantAxes/legacyOptionRepository.js';
import {
  findVariantAttributeClaim,
  recordListingAttributeClaim,
  recordVariantAttributeClaim,
} from '../../db/variantAxes/attributeClaimRepository.js';
import {
  declareVariantAxis,
  listVariantAxisAssignments,
  replaceVariantAxisAssignments,
  upsertVariantSignature,
  type NewNativeVariantAxisAssignment,
} from '../../db/variantAxes/variantAxisRepository.js';
import {
  resolveActiveDefinition,
  type ResolvedAttributeDefinition,
} from '../attributes/definition-registry.service.js';
import {
  legacyOptionNameToKey,
  resolveLegacyOptionName,
  resolveLegacyOptionValue,
} from './legacy-resolution.js';
import { typedVariantSignature } from './signature.js';

/** How a caller drives one pass. */
export interface VariantAxisBackfillOptions {
  /** `dry_run` runs the identical code and rolls it back. Defaults to `dry_run`. */
  readonly mode?: 'dry_run' | 'apply';
  /** Resume point, from a previous report's `resumeAfterListingId`. */
  readonly afterListingId?: string | null;
  /** How many listings this pass may touch. */
  readonly listingLimit?: number;
}

/** Zeroed buckets for both refusal vocabularies, every member present. */
function emptyRefusalCounts(): {
  attribute: Record<VariantAxisAttributeRefusal, number>;
  value: Record<VariantAxisValueRefusal, number>;
} {
  return {
    attribute: Object.fromEntries(
      VARIANT_AXIS_ATTRIBUTE_REFUSALS.map((refusal) => [refusal, 0]),
    ) as Record<VariantAxisAttributeRefusal, number>,
    value: Object.fromEntries(
      VARIANT_AXIS_VALUE_REFUSALS.map((refusal) => [refusal, 0]),
    ) as Record<VariantAxisValueRefusal, number>,
  };
}

/** The mutable tally one pass accumulates. */
interface Counters {
  listings: number;
  listingOptions: number;
  variantOptionValues: number;
  axesDeclared: number;
  axesAlreadyDeclared: number;
  axesUnresolved: number;
  assignmentsWritten: number;
  assignmentsAlreadyWritten: number;
  assignmentsUnresolved: number;
  assignmentsWithheld: number;
  assignmentsRemoved: number;
  claimsWritten: number;
  claimsAlreadyPresent: number;
  signaturesWritten: number;
  signaturesUnchanged: number;
  listingsWithIndistinguishableVariants: number;
  refusals: ReturnType<typeof emptyRefusalCounts>;
}

function newCounters(): Counters {
  return {
    listings: 0,
    listingOptions: 0,
    variantOptionValues: 0,
    axesDeclared: 0,
    axesAlreadyDeclared: 0,
    axesUnresolved: 0,
    assignmentsWritten: 0,
    assignmentsAlreadyWritten: 0,
    assignmentsUnresolved: 0,
    assignmentsWithheld: 0,
    assignmentsRemoved: 0,
    claimsWritten: 0,
    claimsAlreadyPresent: 0,
    signaturesWritten: 0,
    signaturesUnchanged: 0,
    listingsWithIndistinguishableVariants: 0,
    refusals: emptyRefusalCounts(),
  };
}

/** One resolved axis, carried from the option pass into the value pass. */
interface ResolvedAxis {
  readonly axisId: string;
  readonly attributeDefinitionId: string;
  readonly attributeKey: string;
  readonly attributeDefinitionVersion: number;
  readonly definition: ResolvedAttributeDefinition;
}

/**
 * Fold every option name of ONE listing and find the names that collide.
 *
 * Two of a listing's option names folding to one key (`Shoe Size` and
 * `Shoe-Size`) is the one ambiguity this pass can genuinely produce, and the
 * answer is to resolve NEITHER: `native_listing_variant_axes_listing_attribute_key`
 * would refuse the second, and taking whichever row came first would type an
 * axis from a coin toss. A name that folds to nothing is not a collision — it is
 * simply unmapped, and several of those are fine.
 */
function collidingOptionKeys(options: readonly LegacyListingOptionRow[]): ReadonlySet<string> {
  const seen = new Map<string, number>();
  for (const option of options) {
    const key = legacyOptionNameToKey(option.name);
    if (key === null) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const collisions = new Set<string>();
  for (const [key, occurrences] of seen) {
    if (occurrences > 1) collisions.add(key);
  }
  return collisions;
}

/**
 * The instant a legacy claim was asserted.
 *
 * The legacy row's own `updated_at`, never the clock. Stamping preserved text
 * with the migration's time would make the audit trail say the merchant asserted
 * it during the backfill — a fact nobody observed, which is exactly what
 * `native_*_legacy_provenance_check` refuses to let this domain invent about the
 * claimant.
 */
function legacyAssertedAt(row: { updatedAt: Date | null; createdAt: Date | null }): Date {
  return row.updatedAt ?? row.createdAt ?? new Date(0);
}

/** Migrate ONE listing, inside the caller's transaction. */
async function backfillOneListing(
  tx: DatabaseOrTransaction,
  input: {
    readonly listingId: string;
    readonly options: readonly LegacyListingOptionRow[];
    readonly optionValues: readonly LegacyVariantOptionValueRow[];
    readonly counters: Counters;
  },
): Promise<void> {
  const { counters } = input;
  const collisions = collidingOptionKeys(input.options);
  const axesByKey = new Map<string, ResolvedAxis>();
  /**
   * Why each option name was refused, so a VARIANT value under that name is
   * reported against the same cause. Without it every value under a
   * `forbidden_as_axis` option would be counted `unmapped`, which sends an
   * operator to write an alias for something that may never be an axis.
   */
  const refusalByKey = new Map<string, VariantAxisAttributeRefusal>();

  // ── 1. Every legacy option becomes a retained claim, resolved or not ───────
  for (const option of input.options) {
    counters.listingOptions += 1;
    const key = legacyOptionNameToKey(option.name);
    const definition = key === null ? undefined : await resolveActiveDefinition(tx, key);
    const name = resolveLegacyOptionName({
      rawName: option.name,
      definition: definition ?? null,
      collidesWithSiblingOption: key !== null && collisions.has(key),
    });

    const claim = await recordListingAttributeClaim(tx, {
      listingId: input.listingId,
      kind: 'axis_declaration',
      rawName: option.name,
      rawValue: null,
      provenance: 'legacy_option_migration',
      assertedAt: legacyAssertedAt(option),
      attributeResolution: name.outcome === 'resolved' ? 'resolved' : 'blocked',
      attributeRefusal: name.outcome === 'resolved' ? null : name.refusal,
      attributeDefinitionId: name.outcome === 'resolved' ? name.attributeDefinitionId : null,
      attributeDefinitionVersion:
        name.outcome === 'resolved' ? name.attributeDefinitionVersion : null,
    });
    if (claim === null) counters.claimsAlreadyPresent += 1;
    else counters.claimsWritten += 1;

    if (name.outcome === 'refused') {
      counters.axesUnresolved += 1;
      counters.refusals.attribute[name.refusal] += 1;
      if (key !== null) refusalByKey.set(key, name.refusal);
      continue;
    }

    const { row: axis, created } = await declareVariantAxis(tx, {
      listingId: input.listingId,
      attributeDefinitionId: name.attributeDefinitionId,
      attributeKey: name.attributeKey,
      attributeDefinitionVersion: name.attributeDefinitionVersion,
      // NULL: `listings` carries no product type until ADR 0007 D10's authoring
      // workstream widens it, and the backfill has nothing to cite. See the
      // schema's own note on why the column is nullable.
      productTypeDefinitionId: null,
      legacyOptionName: option.name,
      position: option.position,
    });
    // The INSERT's empty `RETURNING` set is the discriminator, not a timestamp
    // comparison — see `declareVariantAxis`.
    if (created) counters.axesDeclared += 1;
    else counters.axesAlreadyDeclared += 1;

    // `definition` is defined here: `resolveLegacyOptionName` only answers
    // `resolved` when it was passed one.
    if (definition === undefined) continue;
    axesByKey.set(name.attributeKey, {
      axisId: axis.id,
      attributeDefinitionId: axis.attributeDefinitionId,
      attributeKey: axis.attributeKey,
      attributeDefinitionVersion: axis.attributeDefinitionVersion,
      definition,
    });
  }

  // ── 2. Every legacy option VALUE becomes a retained claim, resolved or not ─
  const desiredByVariant = new Map<string, NewNativeVariantAxisAssignment[]>();
  for (const value of input.optionValues) {
    counters.variantOptionValues += 1;
    const key = legacyOptionNameToKey(value.name);
    const axis = key === null ? undefined : axesByKey.get(key);
    const resolution =
      axis === undefined
        ? null
        : resolveLegacyOptionValue({ rawValue: value.value, definition: axis.definition });
    // The listing option's own refusal where there is one, so the two grains
    // agree about why. `unmapped` otherwise, which is the honest answer for a
    // variant value naming an option the listing never declared.
    const attributeRefusal =
      axis === undefined ? ((key === null ? undefined : refusalByKey.get(key)) ?? 'unmapped') : null;

    const claim = await recordVariantAttributeClaim(tx, {
      variantId: value.variantId,
      rawName: value.name,
      rawValue: value.value,
      provenance: 'legacy_option_migration',
      assertedAt: legacyAssertedAt(value),
      attributeResolution: axis === undefined ? 'blocked' : 'resolved',
      attributeRefusal,
      attributeDefinitionId: axis?.attributeDefinitionId ?? null,
      attributeDefinitionVersion: axis?.attributeDefinitionVersion ?? null,
      valueResolution: resolution?.outcome === 'resolved' ? 'resolved' : 'blocked',
      valueRefusal:
        resolution === null
          ? 'attribute_unresolved'
          : resolution.outcome === 'resolved'
            ? null
            : resolution.refusal,
      enumValueId: resolution?.outcome === 'resolved' ? resolution.enumValueId : null,
      normalizedValue: resolution?.outcome === 'resolved' ? resolution.normalizedValue : null,
    });
    if (claim === null) counters.claimsAlreadyPresent += 1;
    else counters.claimsWritten += 1;

    if (axis === undefined || resolution === null || resolution.outcome === 'refused') {
      counters.assignmentsUnresolved += 1;
      if (axis === undefined) counters.refusals.attribute[attributeRefusal ?? 'unmapped'] += 1;
      if (resolution === null) counters.refusals.value.attribute_unresolved += 1;
      else if (resolution.outcome === 'refused') counters.refusals.value[resolution.refusal] += 1;
      continue;
    }

    // A claim the insert converged on is read back, because the assignment has
    // to name the claim it came from and a re-run must point at the SAME row —
    // the audit trail is only worth having if it survives a second pass.
    const sourceClaim =
      claim ??
      (await findVariantAttributeClaim(tx, {
        variantId: value.variantId,
        provenance: 'legacy_option_migration',
        rawName: value.name,
        rawValue: value.value,
      }));

    const pending = desiredByVariant.get(value.variantId) ?? [];
    pending.push({
      variantId: value.variantId,
      axisId: axis.axisId,
      attributeDefinitionId: axis.attributeDefinitionId,
      attributeKey: axis.attributeKey,
      displayValue: value.value,
      normalizedValue: resolution.normalizedValue,
      enumValueId: resolution.enumValueId,
      normalizedNumber: resolution.normalizedNumber,
      normalizedUnit: resolution.normalizedUnit,
      sourceClaimId: sourceClaim?.id ?? null,
    });
    desiredByVariant.set(value.variantId, pending);
  }

  if (desiredByVariant.size === 0) return;

  // ── 3. Refuse a listing whose variants would be indistinguishable ─────────
  //
  // Two variants whose resolved axis values fold to one digest are one variant
  // as far as `native_variant_signatures_listing_signature_key` is concerned. The
  // legacy data really does contain these — a merchant with a stray duplicate
  // row — and the answer is to type NONE of the listing rather than to type
  // whichever variant the pass reached first. The claims above are already
  // written and stay written: preserving what somebody said is unconditional.
  const signatures = new Map<string, string>();
  for (const [variantId, assignments] of desiredByVariant) {
    signatures.set(
      variantId,
      typedVariantSignature(
        assignments.map((assignment) => ({
          attributeDefinitionId: assignment.attributeDefinitionId,
          normalizedValue: assignment.normalizedValue,
        })),
      ),
    );
  }
  if (new Set(signatures.values()).size !== signatures.size) {
    counters.listingsWithIndistinguishableVariants += 1;
    for (const assignments of desiredByVariant.values()) {
      // `withheld`, not `unresolved`, and not attributed to a refusal: the
      // registry answered every one of these. What stopped them is a duplicate
      // in the merchant's own data, which no alias can fix.
      counters.assignmentsWithheld += assignments.length;
    }
    return;
  }

  // ── 4. Write the assignments and the signatures, in this transaction ──────
  const existing = await listVariantAxisAssignments(tx, [...desiredByVariant.keys()]);
  const existingByKey = new Map(
    existing.map((row) => [`${row.variantId}|${row.axisId}`, row.normalizedValue]),
  );
  const existingCountByVariant = new Map<string, number>();
  for (const row of existing) {
    existingCountByVariant.set(row.variantId, (existingCountByVariant.get(row.variantId) ?? 0) + 1);
  }

  let desiredCount = 0;
  for (const [variantId, assignments] of desiredByVariant) {
    desiredCount += assignments.length;
    let unchanged = existingCountByVariant.get(variantId) === assignments.length;
    for (const assignment of assignments) {
      const previous = existingByKey.get(`${variantId}|${assignment.axisId}`);
      if (previous === assignment.normalizedValue) {
        counters.assignmentsAlreadyWritten += 1;
        continue;
      }
      counters.assignmentsWritten += 1;
      unchanged = false;
    }

    // A re-run over unchanged data writes NOTHING, and this guard is what makes
    // that true rather than nearly true: `replaceVariantAxisAssignments` deletes
    // and re-inserts, so calling it unconditionally would mint fresh row ids and
    // fresh `created_at` values on every apply — a churn that looks like work in
    // every audit and every replication stream.
    //
    // The SIGNATURE upsert is NOT skipped with it, and that asymmetry is
    // deliberate: it is already a no-op when nothing moved (`setWhere` on the
    // conflict branch), and running it unconditionally is what repairs a variant
    // whose assignments exist with no signature row beside them — a state this
    // backfill cannot produce (one transaction per listing) but which the
    // deferred constraint would otherwise make permanently unfixable by a re-run.
    if (!unchanged) await replaceVariantAxisAssignments(tx, variantId, assignments);
    const signature = signatures.get(variantId);
    if (signature === undefined) continue;
    const { changed } = await upsertVariantSignature(tx, {
      variantId,
      listingId: input.listingId,
      signature,
      axisCount: assignments.length,
    });
    if (changed) counters.signaturesWritten += 1;
    else counters.signaturesUnchanged += 1;
  }
  // A row this pass no longer derives. Reported rather than silent: it means the
  // registry stopped resolving something it used to, which is a change somebody
  // made and should see.
  counters.assignmentsRemoved += Math.max(0, existing.length - desiredCount);
}

/**
 * Refuse to return a report whose outcomes do not account for every row read.
 *
 * The vacuity floor. `catalog_backfill_runs_counters_total_check` states the
 * same rule as a database CHECK and states it as an EQUALITY rather than a `<=`,
 * for the reason #60 records: a pass that swallowed a record produces exactly the
 * output of a clean one.
 */
function assertReportSums(
  counters: Counters,
  population: { readonly listingsWithLegacyOptions: number; readonly firstPage: boolean },
): void {
  // The POSITIVE CONTROL on the pager, and the reason the sum checks below are
  // not enough on their own: they are satisfied by 0 = 0 + 0 + 0, so a pass that
  // read nothing reports exactly what a clean pass over an empty catalogue
  // reports — and `hasMore: false` then tells an operator the migration is done.
  // Measured: the first end-to-end run of this script printed a perfect
  // all-zero report against a database whose seed had silently not landed.
  if (population.firstPage && population.listingsWithLegacyOptions > 0 && counters.listings === 0) {
    throw new Error(
      `variant-axis backfill: ${population.listingsWithLegacyOptions} listing(s) carry legacy ` +
        'options and the first page returned none. The pager is broken; the report would say ' +
        'there was nothing to do.',
    );
  }

  const axes = counters.axesDeclared + counters.axesAlreadyDeclared + counters.axesUnresolved;
  if (axes !== counters.listingOptions) {
    throw new Error(
      `variant-axis backfill: ${counters.listingOptions} legacy option(s) were read and ${axes} ` +
        'outcome(s) recorded. A row was swallowed; the report is not trustworthy.',
    );
  }
  const assignments =
    counters.assignmentsWritten +
    counters.assignmentsAlreadyWritten +
    counters.assignmentsUnresolved +
    counters.assignmentsWithheld;
  if (assignments !== counters.variantOptionValues) {
    throw new Error(
      `variant-axis backfill: ${counters.variantOptionValues} legacy option value(s) were read ` +
        `and ${assignments} outcome(s) recorded. A row was swallowed; the report is not ` +
        'trustworthy.',
    );
  }
}

/**
 * Run one pass.
 *
 * The mode defaults to `dry_run`, the `PRODUCT_SAVE_MIGRATION_ENABLED` posture:
 * a migration that writes because somebody forgot a flag is the one failure
 * neither a report nor a rollback can undo.
 */
export async function runVariantAxisBackfill(
  db: Database,
  options: VariantAxisBackfillOptions = {},
): Promise<VariantAxisBackfillReport> {
  const mode = options.mode ?? 'dry_run';
  const limit = options.listingLimit ?? 100;
  const counters = newCounters();

  const afterListingId = options.afterListingId ?? null;
  const listingsWithLegacyOptions = await countListingsWithLegacyOptions(db);
  const page = await listListingIdsWithLegacyOptions(db, { afterListingId, limit });

  for (const listingId of page.listingIds) {
    counters.listings += 1;
    const options_ = await listLegacyListingOptions(db, [listingId]);
    const variants = await listVariantsForListings(db, [listingId]);
    const variantIds = variants.map((variant) => variant.variantId);
    const optionValues = await listLegacyVariantOptionValues(db, variantIds);

    // ONE transaction per listing, and a dry run is the identical body rolled
    // back. A `predict` branch would be a second implementation of this loop and
    // the two would disagree precisely where a migration is dangerous.
    try {
      await db.transaction(async (tx) => {
        await backfillOneListing(tx, { listingId, options: options_, optionValues, counters });
        if (mode === 'dry_run') tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) throw error;
    }
  }

  assertReportSums(counters, {
    listingsWithLegacyOptions,
    firstPage: afterListingId === null,
  });

  return {
    mode,
    scanned: {
      listings: counters.listings,
      listingOptions: counters.listingOptions,
      variantOptionValues: counters.variantOptionValues,
      listingsWithLegacyOptionsTotal: listingsWithLegacyOptions,
    },
    axes: {
      declared: counters.axesDeclared,
      alreadyDeclared: counters.axesAlreadyDeclared,
      unresolved: counters.axesUnresolved,
    },
    assignments: {
      written: counters.assignmentsWritten,
      alreadyWritten: counters.assignmentsAlreadyWritten,
      unresolved: counters.assignmentsUnresolved,
      withheld: counters.assignmentsWithheld,
    },
    claims: {
      written: counters.claimsWritten,
      alreadyPresent: counters.claimsAlreadyPresent,
    },
    signatures: {
      written: counters.signaturesWritten,
      unchanged: counters.signaturesUnchanged,
    },
    unresolved: {
      total: counters.axesUnresolved + counters.assignmentsUnresolved,
      byAttributeRefusal: counters.refusals.attribute,
      byValueRefusal: counters.refusals.value,
    },
    diagnostics: {
      listingsWithIndistinguishableVariants: counters.listingsWithIndistinguishableVariants,
      assignmentsRemoved: counters.assignmentsRemoved,
    },
    resumeAfterListingId: page.resumeAfterListingId,
  };
}
