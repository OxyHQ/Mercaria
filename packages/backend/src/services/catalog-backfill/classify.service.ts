/**
 * One classification pass over the legacy catalogue — #367 workstream 13.
 *
 * The loop that READS; `classification.ts` is the module that DECIDES. Keeping
 * them apart is what makes "this backfill invented a normalization" a property
 * a diff can be checked for rather than something a reviewer has to hold in
 * their head while following a pager.
 *
 * ## The vacuity floor, which is most of why this file is longer than the loop
 *
 * A migration report's worst failure is a clean-looking pass over nothing. A
 * cohort that matched no rows, a keyset that never advanced and a predicate that
 * silently excluded everything all produce `0 scanned` — indistinguishable from
 * a healthy catalogue with nothing left to do, and `resumeAfterListingId: null`
 * then tells an operator the migration is finished.
 *
 * Four things stand between that and a report somebody trusts:
 *
 * 1. **The population is printed on SUCCESS.** {@link LegacyCatalogCoverage} is
 *    reported by every pass, whether or not anything was classified, so "how
 *    many listings are there" never has to be inferred from the outcome counts.
 * 2. **The positive control.** A FIRST page that classified nothing while the
 *    catalogue is not empty throws, naming both figures. This is #367 step 4's
 *    `listingsWithLegacyOptionsTotal` device, and it was worth having there: the
 *    first end-to-end run of that script printed a perfect all-zero report
 *    against a database whose seed had silently not landed.
 * 3. **The sums, by EQUALITY.** Every subject's reason counts sum to its
 *    `scanned`, and so do its class counts, so a row that fell through a branch
 *    cannot be omitted — it is `catalog_backfill_runs_counters_total_check`'s
 *    rule (`<=` would admit the pass that read a million rows and classified
 *    none of them) applied to a script.
 * 4. **The three listing-grain subjects must agree with each other.** Each is a
 *    total function over the SAME page, so any of them disagreeing with
 *    `scannedListings` means a loop stopped early.
 *
 * ## Vendor is computed once, not per page
 *
 * Its grain is the normalized VALUE, and a paged aggregate produces groups that
 * are not the real groups — #60's `vendor_brand_candidates` refuses a cohort for
 * exactly that reason. So it runs on the first page only, and later pages report
 * `not_in_this_pass` rather than a partial tally that would look like a smaller
 * catalogue.
 */

import type {
  LegacyCatalogClassificationReport,
  LegacyCatalogSubjectKind,
  LegacyCatalogSubjectResult,
  LegacyCatalogSubjectTally,
  LegacyCatalogVerdict,
  LegacyMappingClass,
  LegacyMappingReason,
  LegacyRetainedClaimSummary,
  LegacyReviewOwner,
} from '@mercaria/shared-types';
import {
  LEGACY_CATALOG_SUBJECT_CLASSIFIERS,
  LEGACY_CATALOG_SUBJECT_KINDS,
  LEGACY_MAPPING_CLASSES,
  LEGACY_MAPPING_REASON_CLASSES,
  LEGACY_REVIEW_OWNERS,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  listLegacyListingPage,
  listLegacyVendorValues,
  loadCategoryFactsFor,
  loadProductTypeFactsFor,
  readLegacyCatalogCoverage,
} from '../../db/catalogBackfill/legacyCatalogRepository.js';
import {
  findBrandIdsByNormalizedAlias,
  findBrandsByNormalizedName,
} from '../../db/canonical/brandRepository.js';
import { countQueuedClaims } from '../../db/variantAxes/attributeClaimRepository.js';
import { normalizeAliasLookup, normalizeEntityName } from '../canonical/normalization.js';
import { ALL_COHORT, cohortLabel, type BackfillCohort } from '../backfill/cohort.js';
import {
  classifyCategoryAssignment,
  classifyCategoryPath,
  classifyProductTypeText,
  classifyVendorValue,
  LEGACY_CATALOG_CLASSIFIER_VERSION,
} from './classification.js';
import { legacyProductTypeTextToKey } from './product-type-text.js';

/** How a caller drives one pass. */
export interface LegacyCatalogClassificationOptions {
  /**
   * Which slice of the catalogue to classify. Defaults to the whole of it.
   *
   * #60's cohort, reused rather than redefined: one vocabulary across both
   * migrations means a rollout that says "selected stores" means the same thing
   * to each of them, and a second `BackfillCohort` would be two answers to one
   * question. It is what workstream 13's staged rollout (internal → selected
   * stores → selected categories) actually runs on.
   */
  readonly cohort?: BackfillCohort;
  /** Resume point, from a previous report's `resumeAfterListingId`. */
  readonly afterListingId?: string | null;
  /** How many listings this pass may read. */
  readonly listingLimit?: number;
  /** The clock every effective-window comparison is made against. */
  readonly now?: Date;
}

/** A mutable tally, collapsed into a {@link LegacyCatalogSubjectTally} at the end. */
class SubjectTally {
  private scanned = 0;
  private readonly byReason = new Map<LegacyMappingReason, number>();

  record(verdict: LegacyCatalogVerdict): void {
    this.scanned += 1;
    this.byReason.set(verdict.reason, (this.byReason.get(verdict.reason) ?? 0) + 1);
  }

  /**
   * Collapse into the report shape, deriving class and ownership from the ONE
   * table that states them.
   *
   * Derived rather than accumulated beside the reasons: two counters for one
   * fact disagree the first time somebody adds a reason and updates one of them,
   * and the failure would be a report whose classes and reasons tell different
   * stories about the same rows.
   */
  freeze(): LegacyCatalogSubjectTally {
    const byClass = Object.fromEntries(
      LEGACY_MAPPING_CLASSES.map((mappingClass) => [mappingClass, 0]),
    ) as Record<LegacyMappingClass, number>;
    const awaitingReview = Object.fromEntries(
      LEGACY_REVIEW_OWNERS.map((owner) => [owner, 0]),
    ) as Record<LegacyReviewOwner, number>;
    const byReason: Partial<Record<LegacyMappingReason, number>> = {};
    let actionable = 0;

    for (const [reason, total] of this.byReason) {
      const meaning = LEGACY_MAPPING_REASON_CLASSES[reason];
      byReason[reason] = total;
      byClass[meaning.mappingClass] += total;
      awaitingReview[meaning.reviewOwner] += total;
      if (meaning.actionable) actionable += total;
    }

    return { scanned: this.scanned, byClass, byReason, actionable, awaitingReview };
  }
}

/**
 * Refuse to return a report whose outcomes do not account for every row read.
 *
 * See the module header for what each of the four checks catches. All four
 * throw; none of them logs and carries on, because a report that has printed is
 * a report somebody will quote.
 */
function assertReportSums(input: {
  readonly firstPage: boolean;
  readonly listingsTotal: number;
  readonly withVendorText: number;
  readonly scannedListings: number;
  readonly tallies: ReadonlyMap<LegacyCatalogSubjectKind, SubjectTally>;
  readonly vendorValuesRead: number | null;
}): void {
  if (input.firstPage && input.listingsTotal > 0 && input.scannedListings === 0) {
    throw new Error(
      `catalog classification: the catalogue holds ${String(input.listingsTotal)} listing(s) and ` +
        'the first page returned none. The pager is broken; the report would say there was ' +
        'nothing to classify.',
    );
  }

  for (const [subject, tally] of input.tallies) {
    const frozen = tally.freeze();
    const reasons = Object.values(frozen.byReason).reduce<number>(
      (sum, total) => sum + (total ?? 0),
      0,
    );
    if (reasons !== frozen.scanned) {
      throw new Error(
        `catalog classification: subject '${subject}' read ${String(frozen.scanned)} row(s) and ` +
          `recorded ${String(reasons)} reason(s). A row was swallowed; the report is not ` +
          'trustworthy.',
      );
    }
    const classes = Object.values(frozen.byClass).reduce<number>((sum, total) => sum + total, 0);
    if (classes !== frozen.scanned) {
      throw new Error(
        `catalog classification: subject '${subject}' read ${String(frozen.scanned)} row(s) and ` +
          `classified ${String(classes)}. A reason has no class; the report is not trustworthy.`,
      );
    }
    // The three listing-grain subjects are TOTAL functions over one page, so any
    // of them disagreeing with the page size means a loop stopped early.
    if (subject !== 'listing_vendor_text' && frozen.scanned !== input.scannedListings) {
      throw new Error(
        `catalog classification: subject '${subject}' covered ${String(frozen.scanned)} of ` +
          `${String(input.scannedListings)} listing(s) on this page. Every listing-grain subject ` +
          'is a total function over the page; one of them did not run.',
      );
    }
  }

  if (input.vendorValuesRead !== null && input.withVendorText > 0 && input.vendorValuesRead === 0) {
    throw new Error(
      `catalog classification: ${String(input.withVendorText)} listing(s) carry vendor text and ` +
        'the value aggregate returned no groups. The aggregate is broken.',
    );
  }
}

/** What #367 step 4 has left unresolved, quoted rather than recomputed. */
async function readRetainedClaims(
  db: DatabaseOrTransaction,
): Promise<LegacyRetainedClaimSummary> {
  const queued = await countQueuedClaims(db);
  return {
    queued: queued.queued,
    neverAttempted: queued.neverAttempted,
    byAttributeRefusal: queued.byAttributeRefusal,
    byValueRefusal: queued.byValueRefusal,
  };
}

/**
 * Classify one page of the legacy catalogue.
 *
 * Reads only. There is no mode argument and no `--apply`, because there is
 * nothing here to apply: the one write this domain performs lives in
 * `repair.service.ts` and is a different pass with a different report.
 */
export async function runLegacyCatalogClassification(
  db: DatabaseOrTransaction,
  options: LegacyCatalogClassificationOptions = {},
): Promise<LegacyCatalogClassificationReport> {
  const now = options.now ?? new Date();
  const cohort = options.cohort ?? ALL_COHORT;
  const afterListingId = options.afterListingId ?? null;
  const limit = options.listingLimit ?? 200;
  const firstPage = afterListingId === null;

  const coverage = await readLegacyCatalogCoverage(db, cohort);
  const page = await listLegacyListingPage(db, { cohort, afterListingId, limit });

  const categoryFacts = await loadCategoryFactsFor(
    db,
    page.listings.flatMap((listing) => (listing.categoryId === null ? [] : [listing.categoryId])),
  );

  // The folded key per listing, computed ONCE: the classifier is handed the key
  // rather than the raw text, so the fold and the decision cannot disagree about
  // what was looked up.
  const foldedKeys = new Map<string, string | null>();
  for (const listing of page.listings) {
    foldedKeys.set(
      listing.id,
      listing.productType === null ? null : legacyProductTypeTextToKey(listing.productType),
    );
  }
  const productTypeFacts = await loadProductTypeFactsFor(
    db,
    [...foldedKeys.values()].flatMap((key) => (key === null ? [] : [key])),
  );

  const tallies = new Map<LegacyCatalogSubjectKind, SubjectTally>([
    ['listing_category_assignment', new SubjectTally()],
    ['listing_category_path', new SubjectTally()],
    ['listing_product_type_text', new SubjectTally()],
  ]);

  for (const listing of page.listings) {
    const key = foldedKeys.get(listing.id) ?? null;
    tallies
      .get('listing_category_assignment')
      ?.record(classifyCategoryAssignment(listing, categoryFacts, now));
    tallies.get('listing_category_path')?.record(classifyCategoryPath(listing, categoryFacts));
    tallies
      .get('listing_product_type_text')
      ?.record(
        classifyProductTypeText(
          listing,
          key,
          key === null ? [] : (productTypeFacts.get(key) ?? []),
          categoryFacts,
        ),
      );
  }

  // The vendor pass is whole-catalogue in BOTH dimensions: it runs on the first
  // page only, and only for the `all` cohort. Its grain is the normalized value,
  // and a cohort-scoped aggregate produces groups that are not the real groups.
  let vendorValuesRead: number | null = null;
  if (firstPage && cohort.kind === 'all') {
    const vendorTally = new SubjectTally();
    const values = await listLegacyVendorValues(db);
    vendorValuesRead = values.length;

    // Grouped by NORMALIZED value first, so two spellings of one name are one
    // decision. #60 groups identically; the difference — that it flags several
    // display forms as ambiguous and this does not — is stated on
    // `classifyVendorValue`.
    const groups = new Map<string, Set<string>>();
    for (const value of values) {
      const normalized = normalizeEntityName(value.vendor.trim());
      const forms = groups.get(normalized) ?? new Set<string>();
      forms.add(value.vendor.trim());
      groups.set(normalized, forms);
    }

    for (const [normalized, forms] of groups) {
      const candidates = new Set<string>();
      if (normalized.length > 0) {
        for (const brand of await findBrandsByNormalizedName(db, normalized)) {
          candidates.add(brand.id);
        }
        for (const form of forms) {
          for (const id of await findBrandIdsByNormalizedAlias(db, normalizeAliasLookup(form))) {
            candidates.add(id);
          }
        }
      }
      vendorTally.record(classifyVendorValue(normalized, [...candidates]));
    }
    tallies.set('listing_vendor_text', vendorTally);
  }

  assertReportSums({
    firstPage,
    listingsTotal: coverage.listingsTotal,
    withVendorText: coverage.withVendorText,
    scannedListings: page.listings.length,
    tallies,
    vendorValuesRead,
  });

  const bySubject = Object.fromEntries(
    LEGACY_CATALOG_SUBJECT_KINDS.map((subject): [LegacyCatalogSubjectKind, LegacyCatalogSubjectResult] => {
      const classifier = LEGACY_CATALOG_SUBJECT_CLASSIFIERS[subject];
      if (classifier !== 'catalog_backfill') {
        return [subject, { state: 'classified_elsewhere', classifier }];
      }
      const tally = tallies.get(subject);
      if (tally === undefined) {
        return [
          subject,
          {
            state: 'not_in_this_pass',
            note:
              `a whole-catalogue subject runs on the FIRST page of the 'all' cohort only, and ` +
              `this pass is ${firstPage ? '' : 'a later page of '}cohort '${cohortLabel(cohort)}'. ` +
              'A paged or cohort-scoped aggregate produces groups that are not the real groups. ' +
              "Today that is the vendor pass, whose grain is the normalized value rather than " +
              'the listing',
          },
        ];
      }
      return [subject, { state: 'tallied', tally: tally.freeze() }];
    }),
  ) as Record<LegacyCatalogSubjectKind, LegacyCatalogSubjectResult>;

  return {
    classifierVersion: LEGACY_CATALOG_CLASSIFIER_VERSION,
    coverage,
    scannedListings: page.listings.length,
    bySubject,
    retainedClaims: await readRetainedClaims(db),
    resumeAfterListingId: page.resumeAfterListingId,
  };
}
