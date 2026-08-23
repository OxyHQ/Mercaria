/**
 * The catalog metrics collector (#367 W17).
 *
 * ## The registry decides which metrics exist; this file decides their VALUES
 *
 * `collectCatalogMetrics` walks `CATALOG_METRICS` — never its own list — so the
 * report and the definitions cannot drift. Which branch a reading takes is read
 * off the definition's `unmeasured` field and nowhere else:
 *
 * - definition carries `unmeasured` ⇒ the reading is `unmeasured`, with that
 *   field's reason and seam. There is no producer, and registering one would be
 *   refused (see `PRODUCERS` below).
 * - definition carries no `unmeasured` ⇒ a producer MUST exist, and
 *   `censusProducers` fails loudly if one does not.
 *
 * That biconditional is the whole anti-vacuity device. A metric somebody adds to
 * the registry and forgets to produce does not silently report zero; it fails
 * the census. A metric declared unmeasured cannot be quietly produced from a
 * guess, because the collector never looks for a producer for it.
 *
 * ## A reader that throws degrades the METRIC, never the report
 *
 * Eleven domains feed this. One of their readers throwing must not take the
 * other twenty-nine metrics with it, so each producer is wrapped: the metric
 * becomes `unmeasured` with `source_unavailable`, and
 * `recordMetricCollectionFailure()` fires so the failure is VISIBLE as a
 * must-stay-zero counter rather than being indistinguishable from a designed
 * seam. Those are different facts and the report keeps them apart — a permanent
 * seam is work outstanding, an unavailable source is an incident.
 *
 * ## Everything is a count, a ratio of counts, a latency or an age
 *
 * No labels, no free text, no id belonging to a person. `services/payments/`'s
 * metrics module states the reasoning and it holds here: the cheapest way to
 * guarantee a metrics surface leaks nothing is one whose values are integers and
 * whose dimensions are closed enum sets. Breakdown keys are locales, markets,
 * source ids and states — never a category name, which is localized
 * presentation, and never a merchant or a person.
 */

import {
  CATALOG_METRICS,
  CATALOG_METRIC_KEYS,
  type CatalogLatencySample,
  type CatalogMetricBucket,
  type CatalogMetricDefinition,
  type CatalogMetricReading,
  type CatalogMetricsReport,
  type CatalogProposalState,
  type LocalizedEntityKind,
  SUPPORTED_LOCALES,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { readVariantAxisShadowCounters } from '../variant-axes/projection.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { summarizeMatchQueue } from '../../db/matching/matchQueueRepository.js';
import { readCatalogQuality } from '../catalog-governance/quality.service.js';
import {
  type LocalizationDomainLocaleCounts,
  readLocalizationCompletenessCounts,
} from '../../db/catalogLocalization/completenessRepository.js';
import { sweepFacetScopes } from './facet-scope-sweep.js';
import {
  catalogObservabilityCounters,
  readRouteObservation,
  recordMetricCollectionFailure,
  recordUndefinedMetricEmission,
} from './route-observations.js';
import {
  countOpenDrafts,
  countOpenMappingReviews,
  countPendingReindexRequests,
  tallyAttributeLocalizedLabels,
  tallyBackfillRetries,
  tallyBackfillRuns,
  tallyDraftOutcomes,
  tallyExternalMappingCoverage,
  tallyLinkMethods,
  tallyLocalizationStatuses,
  tallyProposals,
  tallyZeroResultsByMarket,
} from './queries.js';

/* -------------------------------------------------------------------------- */
/* Reading builders                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A ratio reading. `ratio` is omitted when the denominator is zero.
 *
 * `0 / 0` is neither 100% nor unmeasured: the read RAN and the population is
 * genuinely empty. `quality.service.ts`'s `cell()` made this choice first and
 * this is the same decision at a different grain — a consumer that wants to draw
 * a bar has to notice there is nothing to draw.
 */
function ratio(
  definition: CatalogMetricDefinition,
  numerator: number,
  denominator: number,
  by?: readonly CatalogMetricBucket[],
): CatalogMetricReading {
  const base = {
    state: 'measured' as const,
    key: definition.key,
    kind: definition.kind,
    numerator,
    denominator,
  };
  if (denominator === 0) {
    return by === undefined ? base : { ...base, by };
  }
  const withRatio = { ...base, ratio: numerator / denominator };
  return by === undefined ? withRatio : { ...withRatio, by };
}

/** A bare count. `numerator` IS the count; there is no second field for it. */
function count(definition: CatalogMetricDefinition, total: number): CatalogMetricReading {
  return {
    state: 'measured',
    key: definition.key,
    kind: definition.kind,
    numerator: total,
  };
}

/**
 * A latency reading.
 *
 * `numerator` is the observation count and `latency` is present exactly when it
 * is above zero — so a task that has served none of these requests reports a
 * population of zero rather than a p95 of 0 ms, which would make every cold task
 * the fastest one in the fleet.
 */
function latency(
  definition: CatalogMetricDefinition,
  sample: CatalogLatencySample | undefined,
): CatalogMetricReading {
  if (!sample || sample.observations === 0) {
    return { state: 'measured', key: definition.key, kind: definition.kind, numerator: 0 };
  }
  return {
    state: 'measured',
    key: definition.key,
    kind: definition.kind,
    numerator: sample.observations,
    latency: sample,
  };
}

/**
 * An age reading.
 *
 * `numerator` is how many rows the age was taken over, and `ageSeconds` is
 * present exactly when that is above zero. An empty queue therefore reports
 * "zero rows, no age" rather than "age zero", which would read as a queue that
 * is perfectly up to date — the same shape as one that has stopped being fed.
 */
function ageSeconds(
  definition: CatalogMetricDefinition,
  rows: number,
  seconds: number | null,
): CatalogMetricReading {
  if (rows === 0 || seconds === null) {
    return { state: 'measured', key: definition.key, kind: definition.kind, numerator: 0 };
  }
  return {
    state: 'measured',
    key: definition.key,
    kind: definition.kind,
    numerator: rows,
    ageSeconds: seconds,
  };
}

/** Turn a numerator/denominator pair into a bucket, omitting a zero-denominator ratio. */
function bucket(key: string, numerator: number, denominator: number): CatalogMetricBucket {
  if (denominator === 0) {
    return { key, numerator, denominator };
  }
  return { key, numerator, denominator, ratio: numerator / denominator };
}

/* -------------------------------------------------------------------------- */
/* Windows                                                                     */
/* -------------------------------------------------------------------------- */

const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 24 * HOUR_SECONDS;

/**
 * The window a definition declares, in seconds.
 *
 * Read from the definition rather than passed by the producer, so a metric's
 * stated window and the interval its query actually covers are the same value.
 * `instant` and `since_process_start` have no interval; a producer that asked for
 * one would be asking the wrong question, so this throws rather than returning a
 * plausible default.
 */
function windowSeconds(definition: CatalogMetricDefinition): number {
  switch (definition.window) {
    case 'rolling_1h':
      return HOUR_SECONDS;
    case 'rolling_24h':
      return DAY_SECONDS;
    case 'rolling_7d':
      return 7 * DAY_SECONDS;
    default:
      throw new Error(
        `${definition.key} declares window '${definition.window}', which has no interval.`,
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Shared reads                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The reads several metrics share, taken ONCE per collection.
 *
 * `readCatalogQuality` alone is four completeness measurements and three
 * duplicate scans; calling it once per metric that needs a slice of it would run
 * it four times and, worse, would let two metrics in one report disagree because
 * the catalogue moved between them.
 */
interface SharedReads {
  readonly quality: Awaited<ReturnType<typeof readCatalogQuality>> | undefined;
  readonly matchQueue: Awaited<ReturnType<typeof summarizeMatchQueue>> | undefined;
  readonly localization: Awaited<ReturnType<typeof tallyLocalizationStatuses>> | undefined;
  readonly deskCompleteness:
    | Awaited<ReturnType<typeof readLocalizationCompletenessCounts>>
    | undefined;
  readonly mappings: Awaited<ReturnType<typeof tallyExternalMappingCoverage>> | undefined;
  readonly backfillRuns: Awaited<ReturnType<typeof tallyBackfillRuns>> | undefined;
  readonly drafts7d: Awaited<ReturnType<typeof tallyDraftOutcomes>> | undefined;
  readonly links: Awaited<ReturnType<typeof tallyLinkMethods>> | undefined;
  readonly proposals7d: Awaited<ReturnType<typeof tallyProposals>> | undefined;
  readonly facetScopes: Awaited<ReturnType<typeof sweepFacetScopes>> | undefined;
}

/**
 * Run a shared read, answering `undefined` on failure.
 *
 * The failure is COUNTED here rather than swallowed, so every metric that
 * depended on it degrades to `source_unavailable` and the operator sees one
 * non-zero counter rather than nine mysterious seams.
 */
async function attempt<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch {
    // Deliberately not `catch {}`: the counter IS the handling, and it is the
    // thing that makes this failure visible on the surface below.
    recordMetricCollectionFailure();
    return undefined;
  }
}

async function readShared(
  db: DatabaseOrTransaction,
  facetSampleSize: number,
): Promise<SharedReads> {
  const week = 7 * DAY_SECONDS;
  const [
    quality,
    matchQueue,
    localization,
    deskCompleteness,
    mappings,
    backfillRuns,
    drafts7d,
    links,
    proposals7d,
    facetScopes,
  ] = await Promise.all([
    attempt(() => readCatalogQuality(db)),
    attempt(() => summarizeMatchQueue(db)),
    attempt(() => tallyLocalizationStatuses(db)),
    attempt(() => readLocalizationCompletenessCounts(SUPPORTED_LOCALES, db)),
    attempt(() => tallyExternalMappingCoverage(db)),
    attempt(() => tallyBackfillRuns(db)),
    attempt(() => tallyDraftOutcomes(week, db)),
    attempt(() => tallyLinkMethods(db)),
    attempt(() => tallyProposals(week, db)),
    attempt(() => sweepFacetScopes({ db, sampleSize: facetSampleSize })),
  ]);
  return {
    quality,
    matchQueue,
    localization,
    deskCompleteness,
    mappings,
    backfillRuns,
    drafts7d,
    links,
    proposals7d,
    facetScopes,
  };
}

/* -------------------------------------------------------------------------- */
/* Producers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Which flag-gated catalog surfaces this deployment mounts.
 *
 * Resolved ONCE per collection rather than read from `config` inside each
 * producer, for the reason every shared read here is taken once: three metrics
 * hang off the authoring route, and three producers reading the same flag
 * independently is three chances for one of them to read a different one.
 */
export interface MountedSurfaces {
  readonly catalogAuthoring: boolean;
  readonly facets: boolean;
}

/** What a producer is handed. */
interface ProducerContext {
  readonly db: DatabaseOrTransaction;
  readonly shared: SharedReads;
  readonly mounted: MountedSurfaces;
}

type Producer = (
  definition: CatalogMetricDefinition,
  context: ProducerContext,
) => Promise<CatalogMetricReading>;

/** Sum the completeness cells of one governance dimension into one ratio. */
function completenessOf(
  definition: CatalogMetricDefinition,
  shared: SharedReads,
  dimension: 'category' | 'product_type' | 'locale',
): CatalogMetricReading {
  if (!shared.quality) return unavailable(definition);
  const cells = shared.quality.completeness.filter((cell) => cell.dimension === dimension);
  let numerator = 0;
  let denominator = 0;
  const by: CatalogMetricBucket[] = [];
  for (const cell of cells) {
    numerator += cell.present;
    denominator += cell.eligible;
    by.push(bucket(cell.key, cell.present, cell.eligible));
  }
  return ratio(definition, numerator, denominator, by);
}

/**
 * The three domains `translation_coverage` and `translation_missing_count`
 * publish a denominator over.
 *
 * The desk reader measures SEVEN localizable domains; these two metrics name
 * three, so the read is FILTERED here rather than summed wholesale. Widening the
 * population is a decision with an audience, not a side effect of a repoint — a
 * metric whose population widens silently makes its own history incomparable,
 * and nothing in a stored series would say so (#565).
 *
 * `translation-metric-population.realdb.test.ts` asserts the computation touches
 * every domain named here, against a fixture with one domain populated and the
 * others empty.
 */
export const TRANSLATION_METRIC_DOMAINS: readonly LocalizedEntityKind[] = [
  'category',
  'product_type',
  'attribute_value',
];

/**
 * One state's bucket out of the proposal tally, or `undefined`.
 *
 * `undefined` is NOT the same as a count of zero and the two callers keep them
 * apart: an empty state is a bucket carrying `0`, because `tallyProposals`
 * renders one column per member of `CATALOG_PROPOSAL_STATES` whether or not any
 * row is in it. A missing bucket means the read and this build's tuple disagree,
 * which degrades the metric rather than reporting a reassuring zero.
 */
function proposalState(
  tally: NonNullable<SharedReads['proposals7d']>,
  state: CatalogProposalState,
): { count: number; oldestAgeSeconds: number | null } | undefined {
  return tally.byState.find((entry) => entry.state === state);
}

/** A count of the proposals in one lifecycle state. */
function proposalStateCount(
  definition: CatalogMetricDefinition,
  shared: SharedReads,
  state: CatalogProposalState,
): CatalogMetricReading {
  if (!shared.proposals7d) return unavailable(definition);
  const bucket = proposalState(shared.proposals7d, state);
  if (!bucket) return unavailable(definition);
  return count(definition, bucket.count);
}

/** The desk rows this deployment's translation metrics are computed over. */
function translationDeskRows(
  shared: SharedReads,
): readonly LocalizationDomainLocaleCounts[] | undefined {
  if (!shared.deskCompleteness) return undefined;
  const named = new Set<string>(TRANSLATION_METRIC_DOMAINS);
  return shared.deskCompleteness.filter((row) => named.has(row.domain));
}

/**
 * Translation coverage, from the DESK read rather than from
 * `catalog_governance_quality`.
 *
 * The quality reader's locale completeness counts PUBLISHED CATEGORIES as its
 * whole denominator, so this metric reported a category-only number under a
 * definition naming three domains: a deployment with complete category names and
 * nothing else translated read as high coverage (#565).
 *
 * The desk counts its denominator from the ENTITY population per (domain,
 * locale), which is what makes the ratio fall when a domain is untranslated
 * instead of being invisible to it.
 */
function deskCoverage(
  definition: CatalogMetricDefinition,
  shared: SharedReads,
): CatalogMetricReading {
  const rows = translationDeskRows(shared);
  if (!rows) return unavailable(definition);
  const byLocale = new Map<string, { present: number; owed: number }>();
  for (const row of rows) {
    const cell = byLocale.get(row.locale) ?? { present: 0, owed: 0 };
    // `reviewed + approved` IS `HUMAN_SETTLED_LOCALIZATION_STATUSES`, which the
    // desk exports as `DESK_SETTLED_STATUSES` and which this definition's
    // numerator names. `machine_translated` is deliberately excluded.
    cell.present += row.reviewed + row.approved;
    cell.owed += row.owed;
    byLocale.set(row.locale, cell);
  }
  let numerator = 0;
  let denominator = 0;
  const by: CatalogMetricBucket[] = [];
  for (const [locale, cell] of [...byLocale].sort(([left], [right]) => left.localeCompare(right))) {
    numerator += cell.present;
    denominator += cell.owed;
    by.push(bucket(locale, cell.present, cell.owed));
  }
  return ratio(definition, numerator, denominator, by);
}

/**
 * Entity-locale pairs with NO localization row, from the desk's `absent`.
 *
 * This metric read the governance queue's `missing_translation` depth, which is
 * `countLocalizations(db, ['missing'])` — rows that EXIST carrying the status
 * `missing`. So a locale with nothing written at all reported ZERO missing,
 * which is the vacuity the metric exists to expose delivered as a reassuring
 * number (#565).
 *
 * `absent` and `missing` are different facts and are never summed — see the
 * definition's attribution limit. The triage backlog stays on the governance
 * queue, where a translator acts on it.
 */
function deskAbsentCount(
  definition: CatalogMetricDefinition,
  shared: SharedReads,
): CatalogMetricReading {
  const rows = translationDeskRows(shared);
  if (!rows) return unavailable(definition);
  return count(
    definition,
    rows.reduce((total, row) => total + row.absent, 0),
  );
}

/**
 * Every metric this deployment produces, keyed by definition key.
 *
 * A key here whose definition carries `unmeasured`, or a definition without
 * `unmeasured` and no key here, is refused by `censusProducers` — so the
 * two halves cannot drift into a metric that is silently zero.
 */
const PRODUCERS: Readonly<Record<string, Producer>> = {
  /* ---- Authoring schema -------------------------------------------------- */
  authoring_schema_fetch_latency: async (definition, { mounted }) => {
    if (!mounted.catalogAuthoring) return notMounted(definition, 'CATALOG_AUTHORING_ENABLED');
    return latency(definition, readRouteObservation('GET', '/catalog-authoring/schemas/:productTypeKey')?.latency);
  },

  authoring_schema_error_rate: async (definition, { mounted }) => {
    if (!mounted.catalogAuthoring) return notMounted(definition, 'CATALOG_AUTHORING_ENABLED');
    const observed = readRouteObservation('GET', '/catalog-authoring/schemas/:productTypeKey');
    return ratio(definition, observed?.serverErrors ?? 0, observed?.requests ?? 0);
  },

  authoring_schema_client_cache_hit_rate: async (definition, { mounted }) => {
    if (!mounted.catalogAuthoring) return notMounted(definition, 'CATALOG_AUTHORING_ENABLED');
    const observed = readRouteObservation('GET', '/catalog-authoring/schemas/:productTypeKey');
    return ratio(definition, observed?.notModified ?? 0, observed?.requests ?? 0);
  },

  /* ---- Drafts ------------------------------------------------------------ */
  draft_completion_rate: async (definition, { shared }) => {
    if (!shared.drafts7d) return unavailable(definition);
    return ratio(definition, shared.drafts7d.published, shared.drafts7d.created);
  },

  draft_abandonment_rate: async (definition, { shared }) => {
    if (!shared.drafts7d) return unavailable(definition);
    const abandoned = shared.drafts7d.discarded + shared.drafts7d.expired;
    return ratio(definition, abandoned, shared.drafts7d.created);
  },

  draft_open_count: async (definition, { db }) => count(definition, await countOpenDrafts(db)),

  /* ---- Resolution mix ---------------------------------------------------- */
  direct_canonical_selection_rate: async (definition, { shared }) => {
    if (!shared.links) return unavailable(definition);
    return ratio(definition, shared.links.declared, shared.links.total);
  },

  automated_match_rate: async (definition, { shared }) => {
    if (!shared.links) return unavailable(definition);
    return ratio(definition, shared.links.automated, shared.links.total);
  },

  unresolved_subject_count: async (definition, { shared }) => {
    if (!shared.matchQueue) return unavailable(definition);
    return count(definition, shared.matchQueue.pending + shared.matchQueue.processing);
  },

  unresolved_subject_oldest_age: async (definition, { shared }) => {
    if (!shared.matchQueue) return unavailable(definition);
    return ageSeconds(
      definition,
      shared.matchQueue.pending,
      shared.matchQueue.oldestPendingAgeSeconds,
    );
  },

  match_queue_dead_letter_count: async (definition, { shared }) => {
    if (!shared.matchQueue) return unavailable(definition);
    return count(definition, shared.matchQueue.deadLetter);
  },

  /* ---- Proposals --------------------------------------------------------- */
  proposal_creation_count: async (definition, { shared }) => {
    if (!shared.proposals7d) return unavailable(definition);
    return count(definition, shared.proposals7d.createdInWindow);
  },

  proposal_backlog_count: async (definition, { shared }) => {
    if (!shared.proposals7d) return unavailable(definition);
    return count(definition, shared.proposals7d.openNow);
  },

  proposal_backlog_oldest_age: async (definition, { shared }) => {
    if (!shared.proposals7d) return unavailable(definition);
    return ageSeconds(
      definition,
      shared.proposals7d.openNow,
      shared.proposals7d.oldestOpenAgeSeconds,
    );
  },

  proposal_decision_count: async (definition, { shared }) => {
    if (!shared.proposals7d) return unavailable(definition);
    return count(definition, shared.proposals7d.decidedInWindow);
  },

  // The three open states, each its own count, all three read out of the SAME
  // tally the backlog total comes from — so `submitted + needs_information +
  // deferred === proposal_backlog_count` is an identity over one snapshot rather
  // than four statements that agree most of the time. `metrics.realdb.test.ts`
  // asserts it absolutely (it holds whatever a parallel file is doing) as well as
  // asserting the delta this file's own insert moves.
  proposal_backlog_awaiting_operator_count: async (definition, { shared }) =>
    proposalStateCount(definition, shared, 'submitted'),

  proposal_backlog_awaiting_submitter_count: async (definition, { shared }) =>
    proposalStateCount(definition, shared, 'needs_information'),

  proposal_backlog_deferred_count: async (definition, { shared }) =>
    proposalStateCount(definition, shared, 'deferred'),

  proposal_awaiting_operator_oldest_age: async (definition, { shared }) => {
    if (!shared.proposals7d) return unavailable(definition);
    const submitted = proposalState(shared.proposals7d, 'submitted');
    // `undefined` means the tally carried no bucket for a state this build's own
    // tuple names, which is a defect rather than an empty queue — so it degrades
    // to `source_unavailable` and is counted, instead of reporting a healthy
    // "nothing is waiting".
    if (!submitted) return unavailable(definition);
    return ageSeconds(definition, submitted.count, submitted.oldestAgeSeconds);
  },

  /* ---- Completeness ------------------------------------------------------ */
  taxonomy_completeness: async (definition, { shared }) =>
    completenessOf(definition, shared, 'category'),

  product_type_completeness: async (definition, { shared }) =>
    completenessOf(definition, shared, 'product_type'),

  attribute_localized_label_completeness: async (definition, { db }) => {
    const tally = await tallyAttributeLocalizedLabels(db);
    return ratio(definition, tally.numerator, tally.denominator);
  },

  /* ---- Translation ------------------------------------------------------- */
  translation_coverage: async (definition, { shared }) =>
    deskCoverage(definition, shared),

  translation_machine_share: async (definition, { shared }) => {
    if (!shared.localization) return unavailable(definition);
    let numerator = 0;
    let denominator = 0;
    const by: CatalogMetricBucket[] = [];
    for (const row of shared.localization) {
      numerator += row.machineTranslated;
      denominator += row.rows;
      by.push(bucket(row.locale, row.machineTranslated, row.rows));
    }
    return ratio(definition, numerator, denominator, by);
  },

  translation_stale_count: async (definition, { shared }) => {
    if (!shared.localization) return unavailable(definition);
    return count(
      definition,
      shared.localization.reduce((total, row) => total + row.stale, 0),
    );
  },

  translation_missing_count: async (definition, { shared }) =>
    deskAbsentCount(definition, shared),

  /* ---- Search ------------------------------------------------------------ */
  search_zero_result_rate_by_market: async (definition, { db }) => {
    const rows = await tallyZeroResultsByMarket(windowSeconds(definition), db);
    let numerator = 0;
    let denominator = 0;
    const by: CatalogMetricBucket[] = [];
    for (const row of rows) {
      numerator += row.numerator;
      denominator += row.denominator;
      by.push(bucket(row.key, row.numerator, row.denominator));
    }
    return ratio(definition, numerator, denominator, by);
  },

  /* ---- Facets ------------------------------------------------------------ */
  facet_generation_latency: async (definition, { mounted }) => {
    if (!mounted.facets) return notMounted(definition, 'FACETS_ENABLED');
    return latency(definition, readRouteObservation('POST', '/facets')?.latency);
  },

  facet_scope_empty_rate: async (definition, { shared }) => {
    if (!shared.facetScopes) return unavailable(definition);
    // `sampled` is the denominator and `population` is not: a scope whose
    // generation raised has no verdict and is excluded from both halves, which
    // is why the sweep reports the two numbers separately.
    return ratio(definition, shared.facetScopes.empty, shared.facetScopes.sampled);
  },

  /* ---- External mappings ------------------------------------------------- */
  external_mapping_coverage: async (definition, { shared }) => {
    if (!shared.mappings) return unavailable(definition);
    let numerator = 0;
    let denominator = 0;
    const by: CatalogMetricBucket[] = [];
    for (const row of shared.mappings) {
      numerator += row.resolvedTokens;
      denominator += row.distinctTokens;
      by.push(bucket(row.sourceId, row.resolvedTokens, row.distinctTokens));
    }
    return ratio(definition, numerator, denominator, by);
  },

  external_mapping_ambiguity: async (definition, { shared }) => {
    if (!shared.mappings) return unavailable(definition);
    let numerator = 0;
    let denominator = 0;
    const by: CatalogMetricBucket[] = [];
    for (const row of shared.mappings) {
      numerator += row.ambiguousTokens;
      denominator += row.unresolvedTokens;
      by.push(bucket(row.sourceId, row.ambiguousTokens, row.unresolvedTokens));
    }
    return ratio(definition, numerator, denominator, by);
  },

  external_mapping_review_backlog: async (definition, { db }) =>
    count(definition, await countOpenMappingReviews(db)),

  /* ---- Backfill and reindex --------------------------------------------- */
  backfill_progress: async (definition, { shared }) => {
    if (!shared.backfillRuns) return unavailable(definition);
    return ratio(definition, shared.backfillRuns.completed, shared.backfillRuns.total);
  },

  backfill_retry_count: async (definition, { db }) => {
    const tally = await tallyBackfillRetries(db);
    return count(definition, tally.numerator);
  },

  backfill_failed_run_count: async (definition, { shared }) => {
    if (!shared.backfillRuns) return unavailable(definition);
    return count(definition, shared.backfillRuns.failed);
  },

  reindex_pending_count: async (definition, { db }) =>
    count(definition, await countPendingReindexRequests(db)),

  /* ---- Typed variant axes on the catalogue read (#367 line 324) ----------- */
  //
  // Both read the SAME process-local counters, and neither checks the lever: a
  // zero denominator already says it is off, and `ratio` keeps a zero
  // denominator in the MEASURED branch (its own docblock's `0 / 0` rule). A
  // `notMounted` branch here would report "we did not look" for a deployment
  // that simply has not turned shadow on, which is a different sentence.
  variant_axis_typed_coverage: async (definition) => {
    const counters = readVariantAxisShadowCounters();
    return ratio(definition, counters.listings - counters.typedAbsent, counters.listings);
  },

  variant_axis_shadow_divergence: async (definition) => {
    const counters = readVariantAxisShadowCounters();
    // `agreed + diverged` — the listings where both representations carried
    // something. Using `listings` would make the rate track the migration
    // backlog rather than the drift, and it would FALL as coverage rose.
    return ratio(definition, counters.diverged, counters.agreed + counters.diverged);
  },
};

/**
 * The reading for a metric whose SOURCE failed this time round.
 *
 * Distinct from a declared seam: the reason is `source_unavailable` and the seam
 * text says the metric is normally produced, so an operator can tell "we never
 * built this" from "this broke just now". The counter incremented at the failure
 * site is the other half of that signal.
 */
/**
 * The reading for a metric whose ROUTE IS NOT MOUNTED in this deployment.
 *
 * The distinction this domain exists to make, applied to its own blind spot.
 * `measured, numerator: 0` asserts that this task served none of those requests —
 * a fact about traffic. A route behind a rollout flag that is off cannot be
 * served at all, which is a fact about the deployment, and reading the second as
 * the first puts a quiet, healthy-looking tile on a dashboard for a feature
 * nobody switched on.
 *
 * TWO of the four budgeted routes sit behind a flag defaulting to false, and FOUR
 * metrics answer this on a stock deployment — three of them hang off the one
 * authoring route. Two routes, two flags, four metrics. An operator reading it is
 * told which variable to set rather than left to wonder why a surface looks idle.
 */
function notMounted(
  definition: CatalogMetricDefinition,
  flag: string,
): CatalogMetricReading {
  return {
    state: 'unmeasured',
    key: definition.key,
    kind: definition.kind,
    reason: 'surface_not_mounted',
    seam:
      `The route this metric observes is not mounted: ${flag} is off in this deployment, so the `
      + 'surface cannot be served and a population of zero would be a statement about traffic '
      + 'rather than about the deployment. Setting it makes this metric measure immediately; no '
      + 'code change is owed.',
  };
}

function unavailable(definition: CatalogMetricDefinition): CatalogMetricReading {
  return {
    state: 'unmeasured',
    key: definition.key,
    kind: definition.kind,
    reason: 'source_unavailable',
    seam:
      `This metric is normally produced from ${definition.source}; that read failed on this `
      + 'collection. See the metricCollectionFailures counter, which is non-zero for the same '
      + 'reason, and the error log line at the failure site.',
  };
}

/* -------------------------------------------------------------------------- */
/* The census                                                                  */
/* -------------------------------------------------------------------------- */

/** What the producer census found. Returned rather than thrown, so a test can name each side. */
export interface ProducerCensus {
  /** Defined, expected to be produced, and no producer exists. */
  readonly missingProducers: readonly string[];
  /** Declared unmeasured, yet a producer exists. */
  readonly unexpectedProducers: readonly string[];
  /** Producers whose key is in no definition. */
  readonly orphanedProducers: readonly string[];
  readonly definitions: number;
  readonly producers: number;
}

/**
 * Check the registry against the producer table, both ways.
 *
 * Returned rather than thrown so the gate test can assert each direction by name
 * and mutation-test the detector — `findFinancialSourceViolations`'s shape. The
 * counts are reported unconditionally so a census that walked NOTHING is
 * distinguishable from one that walked everything and found it consistent.
 */
export function censusProducers(): ProducerCensus {
  const producerKeys = Object.keys(PRODUCERS);
  const missingProducers: string[] = [];
  const unexpectedProducers: string[] = [];
  for (const definition of CATALOG_METRICS) {
    const hasProducer = Object.prototype.hasOwnProperty.call(PRODUCERS, definition.key);
    if (definition.unmeasured === undefined && !hasProducer) {
      missingProducers.push(definition.key);
    }
    if (definition.unmeasured !== undefined && hasProducer) {
      unexpectedProducers.push(definition.key);
    }
  }
  const orphanedProducers = producerKeys.filter((key) => !CATALOG_METRIC_KEYS.includes(key));
  return {
    missingProducers,
    unexpectedProducers,
    orphanedProducers,
    definitions: CATALOG_METRICS.length,
    producers: producerKeys.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Collection                                                                  */
/* -------------------------------------------------------------------------- */

/** How many category scopes the facet sweep samples during a metrics collection. */
export const METRICS_FACET_SAMPLE_SIZE = 60;

export interface CollectCatalogMetricsOptions {
  readonly db?: DatabaseOrTransaction;
  /** Lowered in tests; the default keeps one collection to a bounded amount of facet planning. */
  readonly facetSampleSize?: number;
  /**
   * Override which flag-gated surfaces count as mounted.
   *
   * Defaults to this deployment's own configuration, which is the production
   * path. It is an explicit input rather than a `config` read inside each
   * producer so a test can drive the store-reading arithmetic without a second
   * process — `config` is frozen at module load, so the alternative would be
   * asserting the mount refusal and nothing beyond it.
   */
  readonly mounted?: Partial<MountedSurfaces>;
}

/**
 * Collect every defined catalog metric.
 *
 * Walks `CATALOG_METRICS`, so the report has exactly one reading per definition
 * and in the registry's order. A producer that throws — as opposed to a shared
 * read that failed, which is already handled — degrades that ONE metric and
 * counts the failure.
 */
export async function collectCatalogMetrics(
  options: CollectCatalogMetricsOptions = {},
): Promise<CatalogMetricsReport> {
  const db = options.db ?? getDb();
  const facetSampleSize = options.facetSampleSize ?? METRICS_FACET_SAMPLE_SIZE;

  const census = censusProducers();
  if (census.missingProducers.length > 0) {
    // Loud rather than a zero. A metric defined and unproduced is the exact
    // vacuity this domain exists to prevent, so it fails the read instead of
    // reporting a clean catalogue.
    throw new Error(
      `catalog metrics have no producer: ${census.missingProducers.join(', ')} `
        + `(${String(census.definitions)} definitions, ${String(census.producers)} producers)`,
    );
  }

  const mounted: MountedSurfaces = {
    catalogAuthoring: options.mounted?.catalogAuthoring ?? config.catalogAuthoring.enabled,
    facets: options.mounted?.facets ?? config.catalog.facetsEnabled,
  };

  const shared = await readShared(db, facetSampleSize);
  const context: ProducerContext = { db, shared, mounted };

  const readings: CatalogMetricReading[] = [];
  for (const definition of CATALOG_METRICS) {
    if (definition.unmeasured !== undefined) {
      readings.push({
        state: 'unmeasured',
        key: definition.key,
        kind: definition.kind,
        reason: definition.unmeasured.reason,
        seam: definition.unmeasured.seam,
      });
      continue;
    }
    const producer = PRODUCERS[definition.key];
    if (!producer) {
      // Unreachable: the census above refuses this. Written out because the
      // census and this loop are separated by an await, which is the pair that
      // drifts.
      recordUndefinedMetricEmission();
      readings.push(unavailable(definition));
      continue;
    }
    try {
      readings.push(await producer(definition, context));
    } catch {
      recordMetricCollectionFailure();
      readings.push(unavailable(definition));
    }
  }

  return {
    collectedAt: new Date().toISOString(),
    readings,
    awaitingSeams: CATALOG_METRICS.filter(
      (definition) => definition.unmeasured !== undefined,
    ).map((definition) => ({
      key: definition.key,
      // Non-null-safe without an assertion: the filter above is the narrowing,
      // and `strict: false` means the compiler accepts the read either way — so
      // the fallback is written out rather than asserted away.
      seam: definition.unmeasured ? definition.unmeasured.seam : '',
    })),
    mustStayZero: catalogObservabilityCounters(),
  };
}
