/**
 * Legacy reads against new reads — #367 workstream 13's reconciliation report.
 *
 * ADR 0007 D13 keeps two v1 read contracts alive on purpose:
 * `listings.category_slugs` (five services filter on it) and `categories.is_active`
 * (derived from `lifecycle`). Both are PROJECTIONS of something else, both are
 * retired in a later `post` migration "once no reader remains", and until then
 * both can silently disagree with the authority they project.
 *
 * The disagreement is not hypothetical and it is not held by any constraint:
 *
 * - `taxonomyRepository.moveCategory` rewrites `categories.ancestor_slugs` for a
 *   whole subtree in one statement and touches no listing. Every listing under a
 *   moved node therefore keeps the path it was written with, and the five slug
 *   filters silently return a different set of products from the id-and-ancestry
 *   read.
 * - `is_active` and `lifecycle` are kept in step by the repository and by
 *   nothing else. `taxonomy-write-chokepoint.test.ts` says so in as many words:
 *   the cross-column CHECK is a `post`-phase statement that has not been
 *   applied, and a second writer "writes a row that looks entirely ordinary".
 *
 * ## Every probe carries its own vacuity floor
 *
 * A probe that examined nothing reports perfect agreement, which is the
 * measurement failure this whole workstream is shaped around. So each probe
 * reports `examined` beside `agreed`/`diverged`, and
 * {@link assertProbesMeasuredSomething} throws when a probe examined nothing
 * while its population is non-empty. Reporting a tidy `diverged: 0` off an empty
 * scan is the exact shape of report that gets quoted in a cutover decision.
 */

import type {
  LegacyCatalogReconciliationProbe,
  LegacyCatalogReconciliationReport,
} from '@mercaria/shared-types';
import { isCategoryLifecycleActive } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  countListingsBothWays,
  listCategoryActivityProjections,
  listLegacyListingPage,
  listReconcilableCategories,
  loadCategoryFactsFor,
  readLegacyCatalogCoverage,
} from '../../db/catalogBackfill/legacyCatalogRepository.js';
import { categoryPathsAgree, derivedCategoryPath, LEGACY_CATALOG_CLASSIFIER_VERSION } from './classification.js';
import { ALL_COHORT, type BackfillCohort } from '../backfill/cohort.js';

/** How many diverging subjects a probe names, so an operator can open one by hand. */
const SAMPLE_LIMIT = 20;

/** How a caller drives one reconciliation pass. */
export interface LegacyCatalogReconciliationOptions {
  /**
   * Which slice of the catalogue the LISTING-grain comparisons cover.
   *
   * `category_is_active_projection` is deliberately unaffected: a cohort is a
   * predicate over `listings`, and that probe compares two columns of
   * `categories`. Scoping it by "the categories this cohort's listings sit
   * under" would make a rollout gate answer a narrower question than the one it
   * appears to ask.
   */
  readonly cohort?: BackfillCohort;
  readonly afterListingId?: string | null;
  readonly listingLimit?: number;
  /** How many categories the two category-grain probes examine per pass. */
  readonly categoryLimit?: number;
}

/** Accumulate one probe's result, keeping a bounded sample of divergences. */
class Probe {
  private examined = 0;
  private diverged = 0;
  private readonly sample: string[] = [];

  constructor(private readonly name: string) {}

  record(subjectId: string, agrees: boolean): void {
    this.examined += 1;
    if (agrees) return;
    this.diverged += 1;
    if (this.sample.length < SAMPLE_LIMIT) this.sample.push(subjectId);
  }

  freeze(): LegacyCatalogReconciliationProbe {
    return {
      probe: this.name,
      examined: this.examined,
      agreed: this.examined - this.diverged,
      diverged: this.diverged,
      sample: [...this.sample],
    };
  }
}

/**
 * Refuse to return a report whose probes measured nothing.
 *
 * The population each probe is compared against is stated per probe rather than
 * shared: "there are listings" says nothing about whether the category probes
 * had subjects, and a single floor over the whole report would pass on a run
 * where two of the three probes silently found no rows.
 */
function assertProbesMeasuredSomething(input: {
  readonly probes: readonly LegacyCatalogReconciliationProbe[];
  readonly populations: Readonly<Record<string, number>>;
}): void {
  for (const probe of input.probes) {
    const population = input.populations[probe.probe] ?? 0;
    if (population > 0 && probe.examined === 0) {
      throw new Error(
        `catalog reconciliation: probe '${probe.probe}' examined nothing while its population is ` +
          `${String(population)}. A probe that measured nothing reports perfect agreement.`,
      );
    }
  }
}

/**
 * Run one reconciliation pass.
 *
 * Reads only, in every probe. A reconciliation that repaired what it found would
 * be a second writer racing the first, and it would destroy the evidence of how
 * far the two reads had drifted — #60's consistency sweep makes the same choice
 * for the same reason.
 */
export async function runLegacyCatalogReconciliation(
  db: DatabaseOrTransaction,
  options: LegacyCatalogReconciliationOptions = {},
): Promise<LegacyCatalogReconciliationReport> {
  const cohort = options.cohort ?? ALL_COHORT;
  const afterListingId = options.afterListingId ?? null;
  const listingLimit = options.listingLimit ?? 200;
  const categoryLimit = options.categoryLimit ?? 100;

  const coverage = await readLegacyCatalogCoverage(db, cohort);
  const page = await listLegacyListingPage(db, { cohort, afterListingId, limit: listingLimit });
  const categoryFacts = await loadCategoryFactsFor(
    db,
    page.listings.flatMap((listing) => (listing.categoryId === null ? [] : [listing.categoryId])),
  );

  // Probe 1 — the listing's stored ancestor path against the path its own
  // category derives today. A listing with no category is not a subject: it has
  // no path to project, and counting it as agreement would let an uncategorized
  // catalogue report perfect health.
  const pathProbe = new Probe('listing_category_path_projection');
  for (const listing of page.listings) {
    if (listing.categoryId === null) continue;
    const category = categoryFacts.get(listing.categoryId);
    if (category === undefined) {
      pathProbe.record(listing.id, false);
      continue;
    }
    pathProbe.record(
      listing.id,
      categoryPathsAgree(listing.categorySlugs, derivedCategoryPath(category)),
    );
  }

  // Probe 2 — the same drift measured from the READ side, which is what a
  // shopper experiences: browsing one shelf must return one set of products
  // whether the service filtered by slug path or by category ancestry.
  const browseProbe = new Probe('category_browse_count_agreement');
  const browsable = await listReconcilableCategories(db, {
    afterCategoryId: null,
    limit: categoryLimit,
  });
  for (const category of browsable) {
    const counts = await countListingsBothWays(db, category, cohort);
    browseProbe.record(category.id, counts.viaSlugPath === counts.viaCategoryTree);
  }

  // Probe 3 — `categories.is_active` against the lifecycle it is DERIVED from
  // (ADR 0007 D13). Nothing in the database holds these together today; the
  // repository does, and a second writer would not.
  const activityProbe = new Probe('category_is_active_projection');
  const projections = await listCategoryActivityProjections(db, {
    afterCategoryId: null,
    limit: categoryLimit,
  });
  for (const projection of projections) {
    activityProbe.record(
      projection.id,
      projection.isActive === isCategoryLifecycleActive(projection.lifecycle),
    );
  }

  const probes = [pathProbe.freeze(), browseProbe.freeze(), activityProbe.freeze()];
  assertProbesMeasuredSomething({
    probes,
    populations: {
      // The listing probe's subjects are the listings on THIS page that have a
      // category, so its population is the page rather than the catalogue: a
      // later page legitimately holds only uncategorized listings.
      listing_category_path_projection: page.listings.filter(
        (listing) => listing.categoryId !== null,
      ).length,
      category_browse_count_agreement: browsable.length,
      category_is_active_projection: projections.length,
    },
  });

  // Reported so a reader can see the catalogue the probes ran against without
  // taking a second measurement: a probe's `examined` alone cannot distinguish a
  // small catalogue from a broken scan.
  if (coverage.listingsTotal > 0 && page.listings.length === 0 && afterListingId === null) {
    throw new Error(
      `catalog reconciliation: the catalogue holds ${String(coverage.listingsTotal)} listing(s) ` +
        'and the first page returned none. The pager is broken.',
    );
  }

  return {
    classifierVersion: LEGACY_CATALOG_CLASSIFIER_VERSION,
    probes,
    resumeAfterListingId: page.resumeAfterListingId,
  };
}
