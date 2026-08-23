/**
 * The catalog metric aggregates (#367 W17).
 *
 * ## Why these live here and not in the owning repositories
 *
 * `services/payments/reconciliation/metrics-queries.ts` set the precedent and
 * the reasoning carries over exactly: "how many drafts were abandoned last week"
 * is not a question the authoring lifecycle ever asks, and adding a
 * count-everything query to a domain repository invites the next reader to use
 * it for a DECISION rather than for a dashboard. A metric aggregate has no
 * `where` narrowing it to one tenant, so it is the wrong shape for anything that
 * serves a request.
 *
 * Where an owning domain already publishes a counting reader, this module CALLS
 * it and adds nothing — `summarizeMatchQueue`, `readCatalogQuality`,
 * `readGovernanceQueues`, `tallyBackfillRecords`. A second spelling of a count
 * is a number that can disagree with the surface it came from.
 *
 * ## Every aggregate is bounded by its GROUPING, not by table size
 *
 * These are `count(*) filter (where <enum> = …)` over closed value sets, so the
 * result is bounded by the number of distinct states rather than by how much
 * catalogue exists. The two exceptions are stated where they occur.
 *
 * ## Everything here returns COUNTS
 *
 * No labels, no keys a person typed, no ids belonging to a person. The payments
 * metrics module put it best: the cheapest way to guarantee a metrics surface
 * leaks nothing is one whose values are all integers and whose dimensions are
 * all closed enum sets. The one place an id appears is a bounded operator
 * SAMPLE, and those live in the integrity report rather than here.
 */

import { sql } from 'drizzle-orm';
import {
  CATALOG_PROPOSAL_AGE_BANDS,
  CATALOG_PROPOSAL_OPEN_STATES,
  CATALOG_PROPOSAL_STATES,
  CATALOG_PROPOSAL_WAIT_AGE_PERCENTILES,
  NATIVE_LISTING_LINK_METHODS,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';

/**
 * The link methods that mean a PERSON named the canonical entity.
 *
 * Derived by subtraction from `NATIVE_LISTING_LINK_METHODS` rather than listed,
 * the `CONFIDENT_LINK_METHODS` device: a method added later is automatically
 * counted as automated rather than becoming declared by omission, which is the
 * safe direction — a new matcher stage must not silently inflate the
 * "a merchant chose this" figure.
 */
export const DECLARED_LINK_METHODS: readonly string[] = ['merchant_declared', 'seller_declared'];

/** Everything else in the tuple. Automated by construction. */
export const AUTOMATED_LINK_METHODS: readonly string[] = NATIVE_LISTING_LINK_METHODS.filter(
  (method) => !DECLARED_LINK_METHODS.includes(method),
);

/** A numerator and the population it came out of. */
export interface CountOverPopulation {
  readonly numerator: number;
  readonly denominator: number;
}

/** One closed-set dimension value and its counts. */
export interface DimensionCount {
  readonly key: string;
  readonly numerator: number;
  readonly denominator: number;
}

/** Render a tuple as a quoted SQL in-list. Values come from shared-types, never a caller. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/* -------------------------------------------------------------------------- */
/* Authoring drafts                                                            */
/* -------------------------------------------------------------------------- */

/** Draft outcomes over a window, in one round trip. */
export interface DraftOutcomeTally {
  readonly created: number;
  readonly published: number;
  readonly discarded: number;
  /** Still `open` with `expires_at` in the past. Abandoned without being discarded. */
  readonly expired: number;
  /** Still `open` and still live. In the denominator, in neither outcome. */
  readonly openLive: number;
}

/**
 * Count draft outcomes for drafts CREATED in the window.
 *
 * Keyed on `created_at` rather than on the outcome's timestamp, because a rate
 * whose numerator and denominator are selected by different clocks is not a
 * rate: publishing today a draft started three weeks ago would put the numerator
 * above the denominator in a seven-day window.
 *
 * `expires_at` is NULL exactly when the status is `published` (a CHECK on the
 * table), so the expiry arm cannot accidentally catch a published draft.
 */
export async function tallyDraftOutcomes(
  windowSeconds: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<DraftOutcomeTally> {
  const rows = await db.execute<{
    created: number;
    published: number;
    discarded: number;
    expired: number;
    open_live: number;
  }>(sql`
    select
      count(*)::int as created,
      count(*) filter (where status = 'published')::int as published,
      count(*) filter (where status = 'discarded')::int as discarded,
      count(*) filter (where status = 'open' and expires_at is not null and expires_at <= now())::int
        as expired,
      count(*) filter (where status = 'open' and (expires_at is null or expires_at > now()))::int
        as open_live
    from catalog_authoring_drafts
    where created_at > now() - make_interval(secs => ${windowSeconds})
  `);
  const row = rows[0];
  return {
    created: Number(row?.created ?? 0),
    published: Number(row?.published ?? 0),
    discarded: Number(row?.discarded ?? 0),
    expired: Number(row?.expired ?? 0),
    openLive: Number(row?.open_live ?? 0),
  };
}

/** Drafts open and not yet expired, right now. A gauge, not a window. */
export async function countOpenDrafts(db: DatabaseOrTransaction = getDb()): Promise<number> {
  const rows = await db.execute<{ total: number }>(sql`
    select count(*)::int as total
    from catalog_authoring_drafts
    where status = 'open' and (expires_at is null or expires_at > now())
  `);
  return Number(rows[0]?.total ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Canonical resolution mix                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The resolution mix over ACTIVE native listing links.
 *
 * A stock rather than a flow, which the metric's `attributionLimit` states: a
 * link created a year ago counts the same as one created today. `status =
 * 'active'` is explicit rather than left to a partial index, because a revoked
 * link is a decision that was reversed and counting it would report a merchant's
 * withdrawn choice as a live one.
 */
export async function tallyLinkMethods(
  db: DatabaseOrTransaction = getDb(),
): Promise<{ declared: number; automated: number; total: number }> {
  const rows = await db.execute<{ declared: number; automated: number; total: number }>(sql`
    select
      count(*) filter (where method in (${sql.raw(inList(DECLARED_LINK_METHODS))}))::int as declared,
      count(*) filter (where method in (${sql.raw(inList(AUTOMATED_LINK_METHODS))}))::int
        as automated,
      count(*)::int as total
    from native_listing_links
    where status = 'active'
  `);
  const row = rows[0];
  return {
    declared: Number(row?.declared ?? 0),
    automated: Number(row?.automated ?? 0),
    total: Number(row?.total ?? 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Proposals                                                                   */
/* -------------------------------------------------------------------------- */

/** One lifecycle state's depth and the age of its oldest row. */
export interface ProposalStateTally {
  readonly state: string;
  readonly count: number;
  /** `null` when the state is empty — never zero, which reads as "up to date". */
  readonly oldestAgeSeconds: number | null;
}

/** How many open proposals fall in one contiguous age band. */
export interface ProposalAgeBandTally {
  readonly key: string;
  readonly count: number;
}

export interface ProposalTally {
  readonly createdInWindow: number;
  readonly decidedInWindow: number;
  readonly openNow: number;
  /** Seconds since the oldest still-open proposal was created. Null when none is open. */
  readonly oldestOpenAgeSeconds: number | null;
  /**
   * One entry per member of `CATALOG_PROPOSAL_STATES`, present whether or not
   * the state has any rows — an absent bucket and a zero one read the same on a
   * dashboard, and only one of them is a fact about the queue.
   */
  readonly byState: readonly ProposalStateTally[];
  /**
   * Every row, counted as `count(*)`.
   *
   * NOT summed from `byState`, deliberately: the sum and this number disagree
   * exactly when a row carries a state this build's tuple does not contain, and
   * that comparison is the only thing in the read that can notice such a row.
   */
  readonly totalRows: number;
  /** One entry per member of `CATALOG_PROPOSAL_AGE_BANDS`, over the OPEN rows. */
  readonly openByAgeBand: readonly ProposalAgeBandTally[];
  /**
   * Open rows whose age is NEGATIVE, i.e. whose `created_at` is in the future.
   *
   * The bands are contiguous from zero, so such a row falls in none of them and
   * would otherwise vanish out of the distribution silently. It is counted here
   * rather than folded into the first band because a clock fault and a young
   * proposal are opposite facts.
   */
  readonly openWithFutureCreatedAt: number;
  /** Open `deferred` rows whose `deferred_until` has not yet passed. */
  readonly deferredAhead: number;
  /** Nearest-rank percentiles of the open rows' ages. `null` when nothing is open. */
  readonly openAgePercentiles: {
    readonly p50Seconds: number | null;
    readonly p90Seconds: number | null;
    readonly p95Seconds: number | null;
    readonly maxSeconds: number | null;
  };
}

/**
 * The proposal queue: creation, decision, depth by state, aging and percentiles.
 *
 * ## One statement, one clock
 *
 * Every figure comes out of a single `select` over `catalog_proposals`, so they
 * describe one snapshot. Two statements would let the queue move between the
 * depth and the distribution, and the symptom would be a band count that does not
 * sum to the depth — which is exactly the identity the caller checks, and it must
 * fail on a real fault rather than on a race the reader introduced.
 *
 * The age clock is the ROW's own `created_at` against the statement's `now()`
 * (Postgres `now()` is transaction start, so it is one instant for every column
 * here). Nothing is measured from a sweep tick: a page clock captured before the
 * work ran is what produced `observed_at > now` on every ingested record in #63
 * and #65, and the way that failure hides is by looking like a young row.
 *
 * ## The open set is imported, never restated
 *
 * `CATALOG_PROPOSAL_OPEN_STATES` also renders the convergence index's predicate,
 * so "is this proposal still waiting on somebody" has one answer here, in the
 * publication gate and in the database. `deferred` is open — an operator saying
 * "not now" has not decided — and `deferredAhead` is what lets a reader subtract
 * the part of that which is a plan rather than a wait.
 *
 * ## Nothing here is `max`-of-nothing unsafe
 *
 * `min(created_at) filter (…)` over an empty set is NULL and
 * `extract(epoch from (now() - NULL))` is NULL, which the caller renders as an
 * empty population rather than as a healthy zero. Likewise `percentile_disc`
 * over no rows is NULL. `percentile_disc` and not `percentile_cont`: nearest-rank,
 * so every figure published is the age of a proposal that really is waiting
 * rather than a point between two of them.
 */
export async function tallyProposals(
  windowSeconds: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProposalTally> {
  const open = sql.raw(inList(CATALOG_PROPOSAL_OPEN_STATES));
  const age = sql`extract(epoch from (now() - created_at))`;
  // The percentile arguments come from the shared tuple and are NOT spelled out
  // here, because `CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION` is derived from the
  // largest of them: two spellings would let the SQL measure one set while the
  // floor defended another, and both would still return numbers.
  const percentiles = CATALOG_PROPOSAL_WAIT_AGE_PERCENTILES;

  // One column per state and one per band, each rendered from the shared tuple
  // so a vocabulary change cannot leave this read counting a set the rest of the
  // system no longer uses. `sql.join` keeps every state value a BOUND parameter.
  const stateCounts = sql.join(
    CATALOG_PROPOSAL_STATES.map(
      (state, index) => sql`
        count(*) filter (where state = ${state})::int as ${sql.raw(`state_count_${String(index)}`)},
        extract(epoch from (now() - min(created_at) filter (where state = ${state})))
          ::double precision as ${sql.raw(`state_age_${String(index)}`)}`,
    ),
    sql`, `,
  );
  const bandCounts = sql.join(
    CATALOG_PROPOSAL_AGE_BANDS.map((band, index) => {
      const upper =
        band.toSeconds === null ? sql`true` : sql`${age} < ${band.toSeconds}`;
      return sql`
        count(*) filter (
          where state in (${open}) and ${age} >= ${band.fromSeconds} and ${upper}
        )::int as ${sql.raw(`band_count_${String(index)}`)}`;
    }),
    sql`, `,
  );

  const rows = await db.execute<Record<string, number | null>>(sql`
    select
      count(*) filter (
        where created_at > now() - make_interval(secs => ${windowSeconds})
      )::int as created_in_window,
      count(*) filter (
        where decided_at is not null
          and decided_at > now() - make_interval(secs => ${windowSeconds})
      )::int as decided_in_window,
      count(*) filter (where state in (${open}))::int as open_now,
      count(*)::int as total_rows,
      extract(epoch from (
        now() - min(created_at) filter (where state in (${open}))
      ))::double precision as oldest_open_age_seconds,
      count(*) filter (where state in (${open}) and ${age} < 0)::int as open_future_created,
      count(*) filter (
        where state = 'deferred' and deferred_until is not null and deferred_until > now()
      )::int as deferred_ahead,
      percentile_disc(${percentiles[0]}) within group (order by ${age})
        filter (where state in (${open}))::double precision as p50_seconds,
      percentile_disc(${percentiles[1]}) within group (order by ${age})
        filter (where state in (${open}))::double precision as p90_seconds,
      percentile_disc(${percentiles[2]}) within group (order by ${age})
        filter (where state in (${open}))::double precision as p95_seconds,
      max(${age}) filter (where state in (${open}))::double precision as max_seconds,
      ${stateCounts},
      ${bandCounts}
    from catalog_proposals
  `);
  const row = rows[0] ?? {};

  /** A nullable numeric column, kept NULL rather than coerced to a plausible zero. */
  const nullableNumber = (column: string): number | null => {
    const value = row[column];
    return value === null || value === undefined ? null : Number(value);
  };
  const wholeNumber = (column: string): number => Number(row[column] ?? 0);

  return {
    createdInWindow: wholeNumber('created_in_window'),
    decidedInWindow: wholeNumber('decided_in_window'),
    openNow: wholeNumber('open_now'),
    oldestOpenAgeSeconds: nullableNumber('oldest_open_age_seconds'),
    byState: CATALOG_PROPOSAL_STATES.map((state, index) => ({
      state,
      count: wholeNumber(`state_count_${String(index)}`),
      oldestAgeSeconds: nullableNumber(`state_age_${String(index)}`),
    })),
    totalRows: wholeNumber('total_rows'),
    openByAgeBand: CATALOG_PROPOSAL_AGE_BANDS.map((band, index) => ({
      key: band.key,
      count: wholeNumber(`band_count_${String(index)}`),
    })),
    openWithFutureCreatedAt: wholeNumber('open_future_created'),
    deferredAhead: wholeNumber('deferred_ahead'),
    openAgePercentiles: {
      p50Seconds: nullableNumber('p50_seconds'),
      p90Seconds: nullableNumber('p90_seconds'),
      p95Seconds: nullableNumber('p95_seconds'),
      maxSeconds: nullableNumber('max_seconds'),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Localization                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Localization rows by status, per locale, across the four localization tables.
 *
 * `machine_translated` is its OWN arm rather than being folded into `present`,
 * which is `quality.service.ts`'s decision restated at a different grain: an
 * unreviewed machine translation is work outstanding, and counting it as
 * coverage is how a locale reports 98% complete while a shopper reads a
 * machine's guess at a legal category name.
 *
 * The four tables are unioned rather than queried separately because the metric
 * is "translation coverage for this locale", and a per-table split would invite
 * a reader to average four ratios over different denominators.
 */
export interface LocalizationStatusTally {
  readonly locale: string;
  readonly rows: number;
  readonly machineTranslated: number;
  readonly stale: number;
  readonly humanSettled: number;
}

export async function tallyLocalizationStatuses(
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly LocalizationStatusTally[]> {
  const rows = await db.execute<{
    locale: string;
    rows: number;
    machine_translated: number;
    stale: number;
    human_settled: number;
  }>(sql`
    with all_localizations as (
      select locale, status from category_localizations
      union all
      select locale, status from product_type_localizations
      union all
      select locale, status from attribute_value_localizations
      union all
      select locale, status from navigation_node_localizations
    )
    select
      locale,
      count(*)::int as rows,
      count(*) filter (where status = 'machine_translated')::int as machine_translated,
      count(*) filter (where status = 'stale')::int as stale,
      count(*) filter (where status in ('reviewed', 'approved'))::int as human_settled
    from all_localizations
    group by locale
    order by locale
  `);
  return rows.map((row) => ({
    locale: row.locale,
    rows: Number(row.rows),
    machineTranslated: Number(row.machine_translated),
    stale: Number(row.stale),
    humanSettled: Number(row.human_settled),
  }));
}

/* -------------------------------------------------------------------------- */
/* Attributes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Active attribute definitions carrying at least one LOCALIZED label.
 *
 * Deliberately not "carrying a label": `attribute_definitions.label` is NOT
 * NULL, so that metric would be vacuously 100% and could never fall — the
 * question "what would this report if the thing it measures were absent" has the
 * same answer as now, which means it measures nothing. Localized labels are
 * genuinely optional, so this one can move.
 */
export async function tallyAttributeLocalizedLabels(
  db: DatabaseOrTransaction = getDb(),
): Promise<CountOverPopulation> {
  const rows = await db.execute<{ numerator: number; denominator: number }>(sql`
    select
      count(*) filter (where exists (
        select 1 from attribute_labels al where al.attribute_definition_id = ad.id
      ))::int as numerator,
      count(*)::int as denominator
    from attribute_definitions ad
    where ad.lifecycle_state = 'active'
  `);
  const row = rows[0];
  return {
    numerator: Number(row?.numerator ?? 0),
    denominator: Number(row?.denominator ?? 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Search                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Zero-result rate per market over a window.
 *
 * Rows with a NULL market are excluded from BOTH halves rather than pooled into
 * an "unknown" bucket, which the metric's attribution limit states: pooling them
 * would create a bucket whose denominator is "every search whose market we
 * failed to record", and a rate over that is a fact about instrumentation
 * wearing the name of a fact about shoppers.
 *
 * `traffic_class` is narrowed to human traffic. A crawler searching for strings
 * that match nothing is a zero-result search and is not a shopper failing to
 * find something.
 */
export async function tallyZeroResultsByMarket(
  windowSeconds: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly DimensionCount[]> {
  const rows = await db.execute<{ market: string; numerator: number; denominator: number }>(sql`
    select
      market,
      count(*) filter (where result_count = 0)::int as numerator,
      count(*)::int as denominator
    from analytics_search_queries
    where market is not null
      and traffic_class = 'human'
      and created_at > now() - make_interval(secs => ${windowSeconds})
    group by market
    order by market
  `);
  return rows.map((row) => ({
    key: row.market,
    numerator: Number(row.numerator),
    denominator: Number(row.denominator),
  }));
}

/* -------------------------------------------------------------------------- */
/* External mappings                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Mapping coverage and ambiguity per source, over DISTINCT tokens.
 *
 * Distinct tokens rather than observations, which the metric states: one unmapped
 * token seen a million times is one gap in the vocabulary, and counting
 * occurrences would make a single busy unmapped value look like a collapsed
 * integration. The occurrence count lives on the observation row for whoever
 * prioritises the work.
 *
 * `ambiguous` is measured against UNRESOLVED tokens rather than all tokens,
 * because ambiguity and absence need opposite work — one is a decision, the
 * other is a mapping — and a single rate over both would move for either reason.
 */
export interface ExternalMappingTally {
  readonly sourceId: string;
  readonly distinctTokens: number;
  readonly resolvedTokens: number;
  readonly unresolvedTokens: number;
  readonly ambiguousTokens: number;
}

export async function tallyExternalMappingCoverage(
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly ExternalMappingTally[]> {
  const rows = await db.execute<{
    catalog_source_id: string;
    distinct_tokens: number;
    resolved_tokens: number;
    unresolved_tokens: number;
    ambiguous_tokens: number;
  }>(sql`
    with per_token as (
      select
        catalog_source_id,
        dimension,
        external_key_normalized,
        bool_or(resolution_outcome = 'resolved') as ever_resolved,
        bool_or(unresolved_reason = 'ambiguous') as ever_ambiguous
      from catalog_external_token_observations
      group by catalog_source_id, dimension, external_key_normalized
    )
    select
      catalog_source_id,
      count(*)::int as distinct_tokens,
      count(*) filter (where ever_resolved)::int as resolved_tokens,
      count(*) filter (where not ever_resolved)::int as unresolved_tokens,
      count(*) filter (where not ever_resolved and ever_ambiguous)::int as ambiguous_tokens
    from per_token
    group by catalog_source_id
    order by catalog_source_id
  `);
  return rows.map((row) => ({
    sourceId: row.catalog_source_id,
    distinctTokens: Number(row.distinct_tokens),
    resolvedTokens: Number(row.resolved_tokens),
    unresolvedTokens: Number(row.unresolved_tokens),
    ambiguousTokens: Number(row.ambiguous_tokens),
  }));
}

/** Open external mapping reviews. Rows, not sources — one source can hold the lot. */
export async function countOpenMappingReviews(
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db.execute<{ total: number }>(sql`
    select count(*)::int as total
    from catalog_external_mapping_reviews
    where state = 'open'
  `);
  return Number(rows[0]?.total ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Backfill and reindex                                                        */
/* -------------------------------------------------------------------------- */

export interface BackfillRunTally {
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly running: number;
  readonly pending: number;
  readonly paused: number;
}

/** Backfill runs by status. Bounded by the five statuses, not by run count. */
export async function tallyBackfillRuns(
  db: DatabaseOrTransaction = getDb(),
): Promise<BackfillRunTally> {
  const rows = await db.execute<{
    total: number;
    completed: number;
    failed: number;
    running: number;
    pending: number;
    paused: number;
  }>(sql`
    select
      count(*)::int as total,
      count(*) filter (where status = 'completed')::int as completed,
      count(*) filter (where status = 'failed')::int as failed,
      count(*) filter (where status = 'running')::int as running,
      count(*) filter (where status = 'pending')::int as pending,
      count(*) filter (where status = 'paused')::int as paused
    from catalog_backfill_runs
  `);
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    completed: Number(row?.completed ?? 0),
    failed: Number(row?.failed ?? 0),
    running: Number(row?.running ?? 0),
    pending: Number(row?.pending ?? 0),
    paused: Number(row?.paused ?? 0),
  };
}

/**
 * Backfill records that were retried, and the population they came from.
 *
 * `attempts` carries a CHECK of `>= 1`, so `> 1` is genuinely "was retried" and
 * not an off-by-one reading of a zero-based counter. This is the one aggregate
 * here whose cost grows with the table, so it is the one to watch if the record
 * count ever becomes large; today it is a single indexed count.
 */
export async function tallyBackfillRetries(
  db: DatabaseOrTransaction = getDb(),
): Promise<CountOverPopulation> {
  const rows = await db.execute<{ numerator: number; denominator: number }>(sql`
    select
      count(*) filter (where attempts > 1)::int as numerator,
      count(*)::int as denominator
    from catalog_backfill_records
  `);
  const row = rows[0];
  return {
    numerator: Number(row?.numerator ?? 0),
    denominator: Number(row?.denominator ?? 0),
  };
}

/**
 * Reindex requests with no `processed_at`.
 *
 * This number only grows, and that is the expected reading rather than an
 * incident: `attribute_reindex_requests` has several producers and NO consumer —
 * `processed_at` is written by no code path in the repository — so nothing can
 * ever leave the queue. The metric's `attributionLimit` says so, and
 * `reindex_throughput` beside it is `unmeasured` for the same reason rather than
 * reporting a throughput of zero that would be indistinguishable from a stall.
 */
export async function countPendingReindexRequests(
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db.execute<{ total: number }>(sql`
    select count(*)::int as total
    from attribute_reindex_requests
    where processed_at is null
  `);
  return Number(rows[0]?.total ?? 0);
}
