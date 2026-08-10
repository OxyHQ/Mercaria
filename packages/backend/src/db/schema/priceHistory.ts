/**
 * Currency-safe offer price history — issue #78, closing the seam ADR 0002 D18
 * opened: `offer_price_snapshots`, `offer_price_series`, `offer_price_points`,
 * `offer_price_write_metrics`.
 *
 * #57 holds an offer's CURRENT terms and states outright that the price-history
 * TABLE belongs here. This is that table, plus the derived series a chart reads
 * and the counters that make the derivation's own health observable.
 *
 * ## The four properties this file makes STRUCTURAL rather than conventional
 *
 * 1. **An observation is immutable.** `mercaria_offer_price_snapshots_immutable`
 *    raises on UPDATE, so a correction is a SUPERSEDING record naming the one it
 *    revises (issue snapshot policy 7) and there is no path — service, replay or
 *    `psql` — on which a stored price is rewritten. DELETE is deliberately
 *    PERMITTED; see the retention note below.
 * 2. **A point cannot outlive its evidence.** `offer_price_points.snapshot_id`
 *    is NOT NULL and CASCADEs, so acceptance 6 — "every aggregate point can be
 *    traced to an immutable offer observation" — is true at every instant rather
 *    than true until a retention sweep runs. A source whose agreement requires
 *    deletion takes its chart with it, which is what the agreement says.
 * 3. **A cross-currency point carries its quote.** `fx_rate`, `fx_from`,
 *    `fx_to`, `fx_provider` and `fx_as_of` are present EXACTLY when the
 *    contributing observation's currency differs from the series' display
 *    currency — a biconditional CHECK, the `retail_cost_components` device — so
 *    a converted amount with no identifiable rate is unrepresentable (issue
 *    currency rule 4).
 * 4. **Two observations of different currencies are never compared in raw minor
 *    units.** `offer_price_points.native_currency` is CHECKed against
 *    `ALL_CURRENCY_CODES` while `offer_price_snapshots.item_price_currency`
 *    carries #57's OPEN shape check. An observation in a currency Mercaria
 *    cannot convert is recorded faithfully and simply never becomes a point.
 *
 * ## Retention: DELETE is permitted, and that inverts the ledger's posture
 *
 * The trigger refuses UPDATE and says nothing about DELETE, for
 * `analytics_events`' reason: erasure on a schedule is the policy, and a trigger
 * refusing it would make retention fail silently. Here the schedule is a source
 * RIGHT — an agreement capping how long its facts may be cached — so
 * `retention_expires_at` is stamped at WRITE time from the source's own policy
 * and swept by `db/expiryTargets.ts`. NULL means no source-imposed deadline and
 * is the ordinary case; a `retentionSeconds: 0` target then never touches the
 * row, exactly as `notifications.dismissed_at` never touches an undismissed one.
 *
 * ## What is deliberately NOT here
 *
 * - **No canonical product, variant, merchant or storefront id on a SNAPSHOT.**
 *   The offer already names all four and a merge repoints the offer, so issue
 *   operations 4 — "preserve history through offer, product and merchant merge
 *   workflows" — holds by construction, with no write and no census entry. This
 *   is #57's own reasoning for refusing a canonical product id on `offers`: a
 *   denormalized copy is a second representation a merge can put out of step
 *   with the first, and here the copy would additionally be unfixable, because
 *   the row is immutable.
 * - **No condition GROUP column.** It is `CONDITION_KEY_GROUP[condition_key]`,
 *   total by construction, and storing it would be the same second
 *   representation one derivation away.
 * - **No alert, threshold or subscription of any kind.** #79 owns alerts and
 *   #80's `ProductSavePriceAlert` seam stays as it is.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CONDITION_GROUPS,
  OFFER_AVAILABILITY_STATES,
  OFFER_CONDITION_KEYS,
  OFFER_FRESHNESS_LEVELS,
  PRICE_OBSERVATION_ANOMALIES,
  PRICE_OBSERVATION_CHANGE_REASONS,
  PRICE_POINT_ADMITTED_FRESHNESS,
  PRICE_SERIES_GRANULARITIES,
  PRICE_SERIES_MEASURES,
  PRICE_SERIES_REBUILD_STATUSES,
  PRICE_SERIES_SCOPE_KINDS,
  PRICE_TAX_INCLUSIONS,
} from '@mercaria/shared-types';
import {
  asEnumValues,
  checkEveryElementOf,
  checkOneOf,
  currencyChecks,
  CURRENCY_CODE_VALUES,
} from './columns';
import { canonicalProducts, canonicalVariants } from './canonicalCatalog';
import { catalogSources, sourceRecords } from './provenance';
import { catalogSourceRuns } from './ingestion';
import { offers } from './offers';

/** Bound on a stored rebuild error — `offer_price_series_last_error_length_check`. */
export const PRICE_SERIES_MAX_LAST_ERROR_LENGTH = 2_000;

/**
 * `offer_price_snapshots` — one immutable observation of one offer's terms
 * (issue §OfferPriceSnapshot).
 *
 * ### `item_price_amount` is NOT NULL, and that is issue snapshot policy 5
 *
 * "A source outage does not create a false unavailable or zero-price point."
 * The strongest form of that is a table in which a priceless observation has no
 * row shape: the writer skips an offer whose source published no price, so
 * there is nothing for a chart to read as zero and nothing for a `coalesce` to
 * turn into one later. An offer that stops carrying a price stops producing
 * observations, and the GAP that leaves is a true statement about what Mercaria
 * knows.
 *
 * ### The currency column carries #57's OPEN shape check
 *
 * ADR 0002 D18 names `offers.price_currency` as the documented CHECK exception
 * — an external platform reports whatever currency it trades in — and an
 * observation is a record of what that platform SAID. Narrowing it here would
 * refuse the observation rather than the comparison, which is the wrong end:
 * the comparison is refused by `offer_price_points.native_currency`, which does
 * carry the presentment tuple's CHECK.
 */
export const offerPriceSnapshots = pgTable(
  'offer_price_snapshots',
  {
    id: generatedId(),
    /**
     * The offer these terms belong to.
     *
     * CASCADE, and it is the one direction this domain gives ground on. #57
     * chose CASCADE from the NATIVE side — from `listings` and
     * `product_variants` onto `offers` — because a seller deleting their
     * listing is an existing, legitimate flow the graph must not block. A
     * RESTRICT here would put this table in front of that flow and refuse the
     * delete, which was measured: `offers.realdb.test.ts`' "deleting the
     * listing takes its offers with it" fails on `23503` the moment one
     * observation exists.
     *
     * Nothing is lost that still has meaning: an observation explains an
     * OFFER's terms, and an offer that no longer exists has no terms to
     * explain. Retirement — which is how an offer normally leaves — is a status
     * transition and touches nothing here, so the ordinary case keeps its whole
     * chain (acceptance 4).
     */
    offerId: text()
      .notNull()
      .references(() => offers.id, { onDelete: 'cascade' }),
    /**
     * The provenance record this reading came from (issue snapshot field 11's
     * "source-record version"). NULL for a native offer, which is a projection
     * of a row Mercaria already holds and has no external observation behind
     * it. RESTRICT, matching `offers.source_record_id`.
     */
    sourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    /**
     * The ingestion RUN, which is how issue snapshot policy 6 —
     * "anomaly-quarantined source record does not enter public history until
     * released" — is satisfied without mutating anything.
     *
     * #68 quarantines a RUN, and a quarantine is released or corrected later.
     * A stored `published`/`quarantined` flag on this immutable row could
     * therefore never be corrected; the run id lets the DERIVATION join
     * `catalog_source_run_quarantines` and exclude an observation while its run
     * is held, and include it the moment an operator releases it. The
     * `deriveNativeCheckoutEligibility` posture, applied to publication.
     */
    sourceRunId: text().references(() => catalogSourceRuns.id, { onDelete: 'restrict' }),
    /**
     * The SOURCE, denormalized from the record so a retention sweep and the
     * per-source write metrics do not need a join.
     *
     * This is not the second-representation trap the docblock warns about: a
     * source record's own source never changes (`source_records` is
     * append-only), so the copy cannot go out of step with anything. RESTRICT
     * for the provenance registry's reason.
     */
    sourceId: text().references(() => catalogSources.id, { onDelete: 'restrict' }),

    /** When the source was READ. The x axis of every chart built from this row. */
    observedAt: timestamptz().notNull(),

    // ── The observed money (issue snapshot fields 4, 5, 6) ───────────────────
    itemPriceAmount: bigint({ mode: 'number' }).notNull(),
    itemPriceCurrency: text().notNull(),
    compareAtPriceAmount: bigint({ mode: 'number' }),
    compareAtPriceCurrency: text(),
    /**
     * What delivery cost, when the source published it. BOTH halves absent
     * means UNKNOWN and zero means FREE — #57's paired-CHECK device, and the
     * reason `lowest_known_total` is legitimately sparser than
     * `lowest_item_price` rather than quietly equal to it.
     */
    shippingCostAmount: bigint({ mode: 'number' }),
    shippingCostCurrency: text(),
    /** Issue snapshot field 7. `unknown` until an offer-side column carries it — see the DTO. */
    taxInclusion: text({ enum: asEnumValues(PRICE_TAX_INCLUSIONS) }).notNull().default('unknown'),

    // ── What was being offered (issue snapshot fields 8, 9, 10) ──────────────
    /** #90's taxonomy key, or `unknown`. The SEGMENT is derived; see the docblock. */
    conditionKey: text({ enum: asEnumValues(OFFER_CONDITION_KEYS) }).notNull(),
    availability: text({ enum: asEnumValues(OFFER_AVAILABILITY_STATES) }).notNull(),
    /** ISO 3166-1 alpha-2, shape-CHECKed to match `offers.country`. */
    market: text(),
    region: text(),
    language: text(),

    // ── Freshness and quality (issue snapshot field 12) ──────────────────────
    /**
     * #68's verdict at the moment of observation — a RECORD of what was
     * believed then, never a live read.
     *
     * Storing it is not a second representation of the offer's live freshness:
     * that derivation answers "may this offer appear in a comparison NOW" and
     * this column answers "what did the policy say when this price was read",
     * which is the question an operator asks about a point on a chart from
     * three weeks ago.
     */
    freshnessLevel: text({ enum: asEnumValues(OFFER_FRESHNESS_LEVELS) }).notNull(),

    // ── Identity of the observation itself (issue snapshot field 13) ─────────
    /**
     * sha-256 hex of the observed FACTS — price, compare-at, delivery,
     * condition, availability and tax inclusion, and nothing else.
     *
     * It is what makes deduplication mean "the source said the same thing"
     * rather than "the row looks similar": `observed_at` and the run id are
     * deliberately outside the digest, because every re-read changes both and a
     * digest including them would never collide and would deduplicate nothing.
     */
    observationHash: text().notNull(),
    /**
     * Why this observation was written. An ARRAY, because one re-read can move
     * the price AND the condition AND the availability.
     *
     * `cardinality(...) >= 1` and NEVER `array_length(...) >= 1`:
     * `array_length` of an empty array is NULL, a CHECK rejects only FALSE, and
     * the obvious spelling therefore ADMITS exactly the row it exists to refuse
     * — measured twice in #68 and once in #108 before this file was written.
     */
    changeReasons: text({ enum: asEnumValues(PRICE_OBSERVATION_CHANGE_REASONS) })
      .array()
      .notNull(),
    /**
     * What was wrong with this observation (issue operations 3). Stored, and
     * refused entry to a series by the derivation — #68's persist-then-judge
     * order, because provenance is never withheld whatever the verdict.
     */
    anomalies: text({ enum: asEnumValues(PRICE_OBSERVATION_ANOMALIES) })
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * The observation this one CORRECTS (issue snapshot policy 7).
     *
     * A self-reference with no `onDelete` action, so a retention sweep that
     * removed a corrected observation while its correction survived would be
     * REFUSED rather than leaving a correction pointing at nothing. The two are
     * the same offer's rows under the same source policy, so they expire
     * together in practice; the constraint is what makes that a fact rather
     * than an expectation.
     */
    supersedesSnapshotId: text().references((): AnyPgColumn => offerPriceSnapshots.id),

    /**
     * When a source's own agreement stops permitting Mercaria to keep this
     * observation (issue snapshot policy 8, operations 6).
     *
     * NULL means no source-imposed deadline, which is the ordinary case, and
     * the shared sweep never touches a NULL — `notifications.dismissed_at`'s
     * shape exactly. It is stamped at WRITE time from the source's active
     * rights policy so a later policy change cannot retroactively shorten what
     * was already lawfully kept, and cannot silently lengthen it either: the
     * deadline a row carries is the one that was agreed when it was written.
     */
    retentionExpiresAt: timestamptz(),

    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('offer_price_snapshots_condition_key_check', t.conditionKey, OFFER_CONDITION_KEYS),
    checkOneOf('offer_price_snapshots_availability_check', t.availability, OFFER_AVAILABILITY_STATES),
    checkOneOf('offer_price_snapshots_tax_inclusion_check', t.taxInclusion, PRICE_TAX_INCLUSIONS),
    checkOneOf('offer_price_snapshots_freshness_level_check', t.freshnessLevel, OFFER_FRESHNESS_LEVELS),
    checkEveryElementOf(
      'offer_price_snapshots_change_reasons_check',
      t.changeReasons,
      PRICE_OBSERVATION_CHANGE_REASONS,
    ),
    checkEveryElementOf(
      'offer_price_snapshots_anomalies_check',
      t.anomalies,
      PRICE_OBSERVATION_ANOMALIES,
    ),
    // See the column docblock: `array_length` is NULL on `{}` and would admit
    // an observation that states no reason for existing.
    check(
      'offer_price_snapshots_change_reasons_present_check',
      sql`cardinality(${t.changeReasons}) >= 1`,
    ),
    // Every `Money` is two columns absent TOGETHER. Without these an amount
    // could be stored with no currency, which is not a price.
    check(
      'offer_price_snapshots_compare_at_paired_check',
      sql`(${t.compareAtPriceAmount} is null) = (${t.compareAtPriceCurrency} is null)`,
    ),
    check(
      'offer_price_snapshots_shipping_paired_check',
      sql`(${t.shippingCostAmount} is null) = (${t.shippingCostCurrency} is null)`,
    ),
    // ADR 0002 D18's documented CHECK exception — shape, not the presentment
    // tuple. See the table docblock.
    check(
      'offer_price_snapshots_item_currency_check',
      sql`${t.itemPriceCurrency} ~ '^[A-Z]{3,4}$'`,
    ),
    check(
      'offer_price_snapshots_compare_at_currency_check',
      sql`${t.compareAtPriceCurrency} is null or ${t.compareAtPriceCurrency} ~ '^[A-Z]{3,4}$'`,
    ),
    check(
      'offer_price_snapshots_shipping_currency_check',
      sql`${t.shippingCostCurrency} is null or ${t.shippingCostCurrency} ~ '^[A-Z]{3,4}$'`,
    ),
    /**
     * Issue operations 3's "impossible negative prices", as a constraint rather
     * than a detector.
     *
     * A negative observation is not an anomaly to flag and quarantine, it is a
     * parse error with no true reading, so `PriceObservationAnomaly` has no
     * member for it: there is no row for a flag to sit on. The three DETECTED
     * anomalies are the ones with a plausible innocent explanation.
     */
    check(
      'offer_price_snapshots_non_negative_money_check',
      sql`${t.itemPriceAmount} >= 0
          and coalesce(${t.compareAtPriceAmount}, 0) >= 0
          and coalesce(${t.shippingCostAmount}, 0) >= 0`,
    ),
    check('offer_price_snapshots_market_check', sql`${t.market} ~ '^[A-Z]{2}$'`),
    // A correction names another observation; it cannot name itself, which
    // would make the supersession chain a cycle of length one.
    check(
      'offer_price_snapshots_supersedes_self_check',
      sql`${t.supersedesSnapshotId} is distinct from ${t.id}`,
    ),
    /**
     * The DEDUPLICATION key is deliberately NOT a unique index (issue snapshot
     * policy 3).
     *
     * Two identical observations of one offer are legitimate when they are far
     * enough apart: the second is an ANCHOR, and policy 2 exists precisely so a
     * price that held for ninety days is distinguishable from a feed that
     * stopped publishing. A unique on `(offer_id, observation_hash)` would
     * refuse the anchor. What suppresses the near-duplicate is the writer's
     * interval check, and what makes that check auditable is
     * `offer_price_write_metrics`, which counts the suppressions a table of
     * rows cannot show.
     */
    index('offer_price_snapshots_offer_observed_idx').on(t.offerId, t.observedAt.desc()),
    // The rebuild's own scan: every observation of a set of offers inside a
    // window, oldest first, which is the order the derivation buckets in.
    index('offer_price_snapshots_observed_at_idx').on(t.observedAt),
    index('offer_price_snapshots_source_run_idx')
      .on(t.sourceRunId)
      .where(sql`${t.sourceRunId} is not null`),
    index('offer_price_snapshots_source_observed_idx')
      .on(t.sourceId, t.observedAt)
      .where(sql`${t.sourceId} is not null`),
    // The retention sweep's own order. Partial, so it is the size of the set
    // that has a deadline rather than of every observation ever taken.
    index('offer_price_snapshots_retention_idx')
      .on(t.retentionExpiresAt)
      .where(sql`${t.retentionExpiresAt} is not null`),
  ],
);

/**
 * `offer_price_series` — one derived answer, and the job that keeps it derived.
 *
 * ### The row IS the job
 *
 * `payment_provider_events`' rule, for its reason: a separate outbox row
 * pointing at a series would be a second thing to keep in step, and a
 * convergence queue delivers a FIXED POINT rather than a message — whatever the
 * observations look like when the worker runs is the answer, so five writes in
 * a second owe one rebuild. That is `offer_outboxes`' shape
 * (`ON CONFLICT DO UPDATE` bumping `requested_revision`), not the moderation
 * outbox's `DO NOTHING`.
 *
 * ### Why a stored aggregate at all, when #61 and #68 both refused one
 *
 * #61 measured a million offers and adopted no materialized view; #68's product
 * summary derives live for the same reason. Both of those reads are expressible
 * in SQL. This one is not: choosing the lowest price across offers in four
 * currencies requires an FX rate map that lives in a service and a cache, not
 * in Postgres, so the comparison cannot be pushed into the query and the
 * alternative to storing the answer is pulling every observation of every
 * offer of a popular product into the process on each request. The exception is
 * therefore about the FX map and not about scale, which is why a MERCHANT-scoped
 * read — bounded by one seller's own offers — is still derived live from the
 * same function, with no series row at all.
 *
 * ### The scope is two nullable columns and a CHECK, not one polymorphic id
 *
 * `carts`' owner device. A polymorphic `scope_id` would carry no foreign key
 * and could name a deleted entity forever; two real references cannot.
 */
export const offerPriceSeries = pgTable(
  'offer_price_series',
  {
    id: generatedId(),
    scopeKind: text({ enum: asEnumValues(PRICE_SERIES_SCOPE_KINDS) }).notNull(),
    /** RESTRICT: a canonical entity is never hard-deleted under a series that describes it. */
    canonicalProductId: text().references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    canonicalVariantId: text().references(() => canonicalVariants.id, { onDelete: 'restrict' }),
    /** ISO 3166-1 alpha-2, or NULL for "every market this thing is offered in". */
    market: text(),
    /**
     * The currency this series is displayed in AND was compared in.
     *
     * A presentment `CurrencyCode` with the tuple's CHECK — unlike an
     * observation's currency, which is open. A series in a currency Mercaria
     * cannot present would be a chart nobody could be shown.
     */
    displayCurrency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    granularity: text({ enum: asEnumValues(PRICE_SERIES_GRANULARITIES) }).notNull(),
    /**
     * The derivation version every stored point was produced under (acceptance
     * 5). A bump makes every series stale rather than silently changing what an
     * old point means.
     */
    policyVersion: integer().notNull(),

    // ── The convergence job (the row IS the job) ─────────────────────────────
    /** Bumped by every enqueue. Monotonic per row; never a clock. */
    requestedRevision: bigint({ mode: 'number' }).notNull().default(1),
    /** The revision this claim is answering. NULL before the first claim. */
    claimedRevision: bigint({ mode: 'number' }),
    status: text({ enum: asEnumValues(PRICE_SERIES_REBUILD_STATUSES) }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),

    // ── Coverage, which is what makes a GAP distinguishable from an UNBUILT range ──
    /**
     * The window the last rebuild actually examined.
     *
     * Without it, "no point in this bucket" means both "nobody was offering
     * this" and "the rebuild has not reached here", and only one of those is a
     * fact about prices. A read outside the window returns
     * `PriceHistoryUncovered` and never `PriceHistoryGap`.
     */
    coveredFrom: timestamptz(),
    coveredThrough: timestamptz(),
    rebuiltAt: timestamptz(),
    pointCount: integer().notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),

    /**
     * The convergence key, GENERATED so no write path can supply one that
     * disagrees with the columns it summarises — `offers.source_key`'s device,
     * and needed here for its reason: Postgres treats NULLs as distinct, and
     * both `canonical_product_id` and `market` are legitimately NULL.
     *
     * The separator is `|`, which no uuid v7 and no currency code contains.
     */
    seriesKey: text()
      .notNull()
      .generatedAlwaysAs(
        sql`coalesce("canonical_product_id", '') || '|' || coalesce("canonical_variant_id", '') || '|' ||
            coalesce("market", '') || '|' || "display_currency" || '|' || "granularity"`,
      ),
  },
  (t) => [
    checkOneOf('offer_price_series_scope_kind_check', t.scopeKind, PRICE_SERIES_SCOPE_KINDS),
    checkOneOf('offer_price_series_granularity_check', t.granularity, PRICE_SERIES_GRANULARITIES),
    checkOneOf('offer_price_series_status_check', t.status, PRICE_SERIES_REBUILD_STATUSES),
    ...currencyChecks('offer_price_series', [t.displayCurrency]),
    /**
     * The scope is EXACTLY the one its kind names — `else false`, so an
     * unrecognised kind is unrepresentable even with the kind CHECK removed.
     * #57's `offers_kind_shape_check` device.
     */
    check(
      'offer_price_series_scope_shape_check',
      sql`case ${t.scopeKind}
        when 'canonical_product' then ${t.canonicalProductId} is not null and ${t.canonicalVariantId} is null
        when 'canonical_variant' then ${t.canonicalVariantId} is not null and ${t.canonicalProductId} is null
        else false
      end`,
    ),
    check('offer_price_series_market_check', sql`${t.market} ~ '^[A-Z]{2}$'`),
    check('offer_price_series_policy_version_check', sql`${t.policyVersion} >= 1`),
    check('offer_price_series_attempts_check', sql`${t.attempts} >= 0`),
    check('offer_price_series_point_count_check', sql`${t.pointCount} >= 0`),
    check('offer_price_series_requested_revision_check', sql`${t.requestedRevision} >= 1`),
    check(
      'offer_price_series_claimed_revision_check',
      sql`${t.claimedRevision} is null or ${t.claimedRevision} <= ${t.requestedRevision}`,
    ),
    // Coverage is a window or it is nothing: a half-stated one would let a read
    // treat an unbuilt range as a gap in exactly one direction.
    check(
      'offer_price_series_coverage_shape_check',
      sql`(${t.coveredFrom} is null) = (${t.coveredThrough} is null)
          and (${t.coveredFrom} is null or ${t.coveredThrough} >= ${t.coveredFrom})`,
    ),
    check(
      'offer_price_series_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(PRICE_SERIES_MAX_LAST_ERROR_LENGTH))}`,
    ),
    uniqueIndex('offer_price_series_key').on(t.seriesKey),
    // The dispatcher's two claim branches — due PENDING work, and PROCESSING
    // work whose lease has expired — one partial index each, neither scanning
    // the other's rows. `offer_outboxes`' shape, for its reasons.
    index('offer_price_series_pending_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index('offer_price_series_reclaim_idx')
      .on(t.leaseUntil, t.createdAt)
      .where(sql`${t.status} = 'processing'`),
    index('offer_price_series_product_idx')
      .on(t.canonicalProductId)
      .where(sql`${t.canonicalProductId} is not null`),
    index('offer_price_series_variant_idx')
      .on(t.canonicalVariantId)
      .where(sql`${t.canonicalVariantId} is not null`),
  ],
);

/**
 * `offer_price_points` — one derived answer for one bucket of one series.
 *
 * Everything here DERIVES and nothing increments — `review_aggregates`' rule,
 * which is what makes a rebuild idempotent (issue operations 2) and what makes
 * acceptance 5's "identical output for the same policy and data" checkable by
 * running the rebuild twice and comparing rows rather than by trusting a
 * comment.
 */
export const offerPricePoints = pgTable(
  'offer_price_points',
  {
    id: generatedId(),
    /** CASCADE: a point is meaningless without the series that defines its question. */
    seriesId: text()
      .notNull()
      .references(() => offerPriceSeries.id, { onDelete: 'cascade' }),
    /** The bucket's START. Its width is the series' `granularity`. */
    bucketStart: timestamptz().notNull(),
    measure: text({ enum: asEnumValues(PRICE_SERIES_MEASURES) }).notNull(),
    /**
     * #90's coarse SEGMENT, never a taxonomy key.
     *
     * A column and not a filter, which is acceptance 2: "new, refurbished and
     * used history remain separate" cannot be got wrong by a read that forgot
     * to narrow, because a point IS about one segment.
     */
    segment: text({ enum: asEnumValues(CONDITION_GROUPS) }).notNull(),

    /**
     * The offer that produced this point.
     *
     * CASCADE, matching the snapshot's and for its reason: a RESTRICT here
     * would block a seller's listing delete just as surely. The point would go
     * anyway through `snapshot_id`, so the two agree.
     */
    offerId: text()
      .notNull()
      .references(() => offers.id, { onDelete: 'cascade' }),
    /**
     * The immutable observation behind it (acceptance 6).
     *
     * CASCADE, deliberately, and it is the one place this domain accepts data
     * loss: a source whose agreement requires deletion takes its points with
     * its observations, so there is never a point whose evidence is gone. The
     * alternative — a nullable reference — would leave a chart asserting a
     * price with nothing behind it, which is the failure this domain exists to
     * prevent.
     */
    snapshotId: text()
      .notNull()
      .references(() => offerPriceSnapshots.id, { onDelete: 'cascade' }),
    /** The contributing observation's own time — never the bucket boundary. */
    observedAt: timestamptz().notNull(),
    /** The #68 level that admitted it: the "ranking-eligibility reason" the issue requires. */
    admittedFreshness: text({ enum: asEnumValues(PRICE_POINT_ADMITTED_FRESHNESS) }).notNull(),
    /** How many eligible observations the bucket held. One is not the same as forty. */
    contributingObservationCount: integer().notNull(),

    // ── The money, in BOTH the currency it was published in and the one it is shown in ──
    /**
     * What the source published, verbatim (issue currency rule 1).
     *
     * The presentment tuple's CHECK, unlike the snapshot's open one: only a
     * convertible currency can become a point, so a value here outside the
     * tuple would mean the derivation had compared raw minor units across
     * currencies — which is exactly what currency rule 6 forbids and what this
     * constraint makes unrepresentable.
     */
    nativeAmount: bigint({ mode: 'number' }).notNull(),
    nativeCurrency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    /** The same value in the series' display currency. Equal to `native_amount` when nothing was converted. */
    displayAmount: bigint({ mode: 'number' }).notNull(),

    // ── The historical quote (issue currency rules 4 and 5) ──────────────────
    /**
     * The conversion that produced `display_amount`, present EXACTLY when one
     * happened.
     *
     * A biconditional CHECK rather than four nullable columns nobody checks
     * together: a converted amount whose rate is unidentifiable is precisely
     * the chart currency rule 5 exists to forbid, and an unconverted amount
     * carrying a rate is a claim that a conversion happened when it did not.
     */
    fxRate: doublePrecision(),
    fxFrom: text(),
    fxTo: text(),
    fxProvider: text(),
    fxAsOf: timestamptz(),

    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('offer_price_points_measure_check', t.measure, PRICE_SERIES_MEASURES),
    checkOneOf('offer_price_points_segment_check', t.segment, CONDITION_GROUPS),
    checkOneOf(
      'offer_price_points_admitted_freshness_check',
      t.admittedFreshness,
      PRICE_POINT_ADMITTED_FRESHNESS,
    ),
    ...currencyChecks('offer_price_points', [t.nativeCurrency]),
    check(
      'offer_price_points_non_negative_money_check',
      sql`${t.nativeAmount} >= 0 and ${t.displayAmount} >= 0`,
    ),
    check(
      'offer_price_points_contributing_count_check',
      sql`${t.contributingObservationCount} >= 1`,
    ),
    /**
     * The five FX columns are present together or absent together, and their
     * presence is EXACTLY the case where a conversion happened.
     *
     * `fx_from` must be the point's own native currency and `fx_to` the series'
     * display currency; the second cannot be checked here (it is a column of
     * another table), so the derivation asserts it and a realdb case pins it.
     * What the constraint holds is the half a service bug could plausibly get
     * wrong: a quote naming a currency the point was not denominated in.
     */
    check(
      'offer_price_points_fx_shape_check',
      sql`case
        when ${t.fxRate} is null then
          ${t.fxFrom} is null and ${t.fxTo} is null
          and ${t.fxProvider} is null and ${t.fxAsOf} is null
          and ${t.displayAmount} = ${t.nativeAmount}
        else
          ${t.fxFrom} is not null and ${t.fxTo} is not null
          and ${t.fxProvider} is not null and ${t.fxAsOf} is not null
          and ${t.fxRate} > 0
          and ${t.fxFrom} = ${t.nativeCurrency}
          and ${t.fxFrom} <> ${t.fxTo}
      end`,
    ),
    /**
     * One answer per question per bucket. A second would mean the derivation
     * ran twice and disagreed with itself, which is what a rebuild's `delete`
     * plus `insert` inside one transaction makes impossible — and this is what
     * refuses it anyway.
     */
    uniqueIndex('offer_price_points_bucket_key').on(t.seriesId, t.bucketStart, t.measure, t.segment),
    // The read's own shape: one series, one question, ordered along the x axis.
    index('offer_price_points_read_idx').on(t.seriesId, t.measure, t.segment, t.bucketStart),
    index('offer_price_points_snapshot_idx').on(t.snapshotId),
    index('offer_price_points_offer_idx').on(t.offerId),
  ],
);

/**
 * `offer_price_write_metrics` — what the rows cannot show (issue operations 1).
 *
 * A DEDUPLICATED observation leaves no row, so counting rows answers "how much
 * did we keep" and never "how much did we suppress". A domain whose dedup
 * interval was accidentally set to zero would write ten times the rows and
 * report a perfectly healthy write volume; only a counter of the writes that
 * did NOT happen distinguishes the two. `catalog_source_rejections`' residual
 * lesson, as counters rather than rows because a suppressed duplicate carries
 * no information a row could hold.
 *
 * Keyed per DAY and per SOURCE rather than per day alone. Two reasons, and the
 * second is the load-bearing one: "which feed is churning" is the question an
 * operator actually asks, and one global row per day is a hot row every
 * ingestion write in the fleet would contend on.
 */
export const offerPriceWriteMetrics = pgTable(
  'offer_price_write_metrics',
  {
    id: generatedId(),
    /** `YYYY-MM-DD` in UTC, shape-CHECKed. A text day, so the generated key below stays immutable. */
    bucketDay: text().notNull(),
    /**
     * NULL for native offers, which have no source.
     *
     * CASCADE, unlike every other reference to `catalog_sources` in this
     * schema, and the difference is what the row IS: a counter about a source
     * has no meaning once the source is gone, and a RESTRICT here would put a
     * METRICS row in front of a registry deletion the provenance chain itself
     * permits. Evidence is `offer_price_snapshots`; this is a tally.
     */
    sourceId: text().references(() => catalogSources.id, { onDelete: 'cascade' }),
    written: integer().notNull().default(0),
    deduplicated: integer().notNull().default(0),
    /** Offers with no price, and observations the writer refused for a stated reason. */
    refused: integer().notNull().default(0),
    /** Written AND flagged — stored, and excluded from every series until reviewed. */
    flaggedAnomalous: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),

    /**
     * GENERATED, because Postgres treats NULLs as distinct and `source_id` is
     * legitimately NULL — a plain `UNIQUE(bucket_day, source_id)` would admit
     * one native row per write. `||` and `coalesce` over `text` are IMMUTABLE,
     * which a stored generated column requires.
     */
    metricKey: text()
      .notNull()
      .generatedAlwaysAs(sql`"bucket_day" || '|' || coalesce("source_id", '')`),
  },
  (t) => [
    check('offer_price_write_metrics_bucket_day_check', sql`${t.bucketDay} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
    check(
      'offer_price_write_metrics_counters_check',
      sql`${t.written} >= 0 and ${t.deduplicated} >= 0 and ${t.refused} >= 0
          and ${t.flaggedAnomalous} >= 0 and ${t.flaggedAnomalous} <= ${t.written}`,
    ),
    uniqueIndex('offer_price_write_metrics_key').on(t.metricKey),
    index('offer_price_write_metrics_day_idx').on(t.bucketDay),
  ],
);
