/**
 * Merchant demand snapshots and the operator acquisition pipeline (#86) —
 * seven tables.
 *
 * `merchant_demand_snapshots` + `merchant_demand_metrics` +
 * `merchant_demand_products` are the reproducible reporting record; the four
 * `merchant_acquisition_*` tables are the internal workflow that turns one into
 * a conversation with a merchant.
 *
 * ## A snapshot is a RECORDING, and reproducibility is what it is for
 *
 * `payment_discrepancies` and `retail_eligibility_decisions` are the shape: the
 * live answer is derived from live inputs, and a row here says what the answer
 * WAS at a stated instant under stated policy versions. That is why every
 * snapshot carries `event_policy_version`, `attribution_policy_version`,
 * `collection_mode` and `data_fresh_as_of` — a figure whose interpretation
 * rules are not recorded beside it cannot be reproduced, and #86 acceptance 1
 * asks for exactly that.
 *
 * A correction is a NEW snapshot that SUPERSEDES the old one, never an edit.
 * `mercaria_merchant_demand_snapshot_immutable` refuses every UPDATE except
 * `superseded_at`/`superseded_by_id` moving NULL → a value exactly once — the
 * `retail_cost_acceptances.order_id` device. That is #86's "attribution
 * correction" case as a schema property: when a network revises a report weeks
 * later, the number a merchant was shown in March is still on file beside the
 * number that replaced it.
 *
 * ## DELETE is PERMITTED, and that inverts the ledger on purpose
 *
 * `analytics_events` and `offer_price_snapshots` made this decision first and
 * for the same reason: erasure on a schedule IS the policy here, so a trigger
 * refusing DELETE would make the shared expiry sweep fail SILENTLY on every row
 * it was supposed to remove. `expires_at` is registered in `db/expiryTargets.ts`
 * and the two child tables CASCADE, so a swept snapshot takes its metrics and
 * its product rows with it and never leaves a metric row pointing at nothing.
 *
 * The `merchant_acquisition_*` tables carry NO `expires_at`: an outreach log and
 * an operator audit are the record of decisions people made, and a retention
 * clock on them would quietly destroy the evidence they exist to preserve.
 *
 * ## No column in this file holds a contact
 *
 * #86 asks for "public business contact SOURCES with provenance", and that is
 * what `merchant_acquisition_contact_sources` stores: a source kind, the URL of
 * a page an operator can open, a note saying where on it to look, and who
 * recorded it. There is no `email`, no `phone`, no `contact_name` and no
 * `contact_value` column anywhere in this domain.
 *
 * That is not caution, it is the strongest available reading of #86 privacy 7
 * ("do not use payment-onboarding identity data as outreach contact data"). A
 * prohibition on where a value came FROM is a rule somebody has to keep; a
 * schema with nowhere for a value to LAND is a fact. It also removes the whole
 * PII surface — an operator reads the contact off the merchant's own published
 * page at the moment they use it, which is also the only moment it is known to
 * be current. `MERCHANT_ACQUISITION_FORBIDDEN_CONTACT_SOURCES` names the
 * prohibited origins as VALUES beside it, so the reasoning is readable rather
 * than merely absent.
 *
 * ## The claim verdict is NOT duplicated here
 *
 * `merchants.claim_state` is ADR 0002 D9's one stored claim verdict and #83 is
 * its only writer. `merchant_acquisition_candidates` therefore has NO claim
 * column, no `claimed_at` and no `is_claimed` boolean: the conversion funnel
 * (#86 acquisition 7) is DERIVED on read from `merchants.claim_state`,
 * `native_store_links`, `provider_accounts.onboarding_state` and the presence of
 * an active native offer. A second copy would be the one that goes stale the
 * moment a claim is revoked, and it would go stale on the operator's screen.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import {
  MERCHANT_ACQUISITION_ACTIONS,
  MERCHANT_ACQUISITION_CONTACT_SOURCE_KINDS,
  MERCHANT_ACQUISITION_EXCLUSION_REASONS,
  MERCHANT_ACQUISITION_OPEN_STATES,
  MERCHANT_ACQUISITION_OUTREACH_CHANNELS,
  MERCHANT_ACQUISITION_OUTREACH_OUTCOMES,
  MERCHANT_ACQUISITION_SCORE_INPUTS,
  MERCHANT_ACQUISITION_STATES,
  MERCHANT_DEMAND_AGGREGATE_BASES,
  MERCHANT_DEMAND_CHANNELS,
  MERCHANT_DEMAND_METRIC_KEYS,
  MERCHANT_DEMAND_METRIC_KINDS,
  MERCHANT_DEMAND_MONEY_METRIC_KEYS,
  MERCHANT_DEMAND_RATE_METRIC_KEYS,
  MERCHANT_DEMAND_UNAVAILABLE_REASONS,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf, currencyChecks } from './columns';
import { canonicalProducts } from './canonicalCatalog';
import { merchants } from './merchants';

/**
 * `merchant_demand_snapshots` — one reproducible reporting answer.
 *
 * The window is half-open `[window_from, window_to)` and both ends are stored,
 * because a snapshot's whole value is that a reader can say what period a figure
 * describes without recomputing it. `data_fresh_as_of` is a DIFFERENT instant
 * and is the one #86 snapshot item 2 asks for: the newest durable observation
 * the build could see, which on a slow-refreshing source is earlier than
 * `window_to` and is what makes "this number is two days behind" sayable.
 */
export const merchantDemandSnapshots = pgTable(
  'merchant_demand_snapshots',
  {
    id: generatedId(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    /**
     * ISO 3166-1 alpha-2, or `''` for "every market".
     *
     * NOT NULL with no default — the `analytics_rollups` dimension rule. A
     * NULLable dimension breaks the bucket unique outright (Postgres treats
     * NULLs as distinct), and every writer must state which market it means.
     */
    market: text().notNull(),
    windowFrom: timestamptz().notNull(),
    windowTo: timestamptz().notNull(),
    /** The newest durable observation this build could see. */
    dataFreshAsOf: timestamptz().notNull(),
    /** How events were read into facts. A code constant, stamped here. */
    eventPolicyVersion: text().notNull(),
    /** How a fact was tied to this merchant. A code constant, stamped here. */
    attributionPolicyVersion: text().notNull(),
    /**
     * The analytics collection mode in force at build time.
     *
     * Recorded because it is the difference between "nobody searched" and "we
     * were not counting". Every event-sourced metric answers `unavailable` with
     * `collection_disabled` when this is `off`, and a reader can see why.
     */
    collectionMode: text().notNull(),
    /** The floors applied, stored so a re-read cannot silently use new ones. */
    aggregateFloor: integer().notNull(),
    productFloor: integer().notNull(),
    /** #86 snapshot item 8 — coverage, as counts rather than prose. */
    productsOffered: integer().notNull().default(0),
    productRowsDisclosed: integer().notNull().default(0),
    productRowsSuppressed: integer().notNull().default(0),
    /** Which snapshot replaced this one, and when. Written exactly once. */
    supersededAt: timestamptz(),
    supersededById: text(),
    createdAt: createdAt(),
    /** Swept by `db/expiryTargets.ts`. The children CASCADE with it. */
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    check(
      'merchant_demand_snapshots_window_check',
      sql`${t.windowTo} > ${t.windowFrom} and ${t.dataFreshAsOf} >= ${t.windowFrom}`,
    ),
    check(
      'merchant_demand_snapshots_market_check',
      sql`${t.market} = '' or ${t.market} ~ '^[A-Z]{2}$'`,
    ),
    check(
      'merchant_demand_snapshots_floor_check',
      sql`${t.aggregateFloor} >= 1 and ${t.productFloor} >= ${t.aggregateFloor}`,
    ),
    // The coverage counters must ADD UP — the `catalog_backfill_runs` vacuity
    // floor, applied to a report. A build that lost a product row somewhere
    // between counting and writing cannot store the row at all, so "we found
    // fewer" and "there were fewer" stop looking identical.
    check(
      'merchant_demand_snapshots_coverage_total_check',
      sql`${t.productRowsDisclosed} >= 0
          and ${t.productRowsSuppressed} >= 0
          and ${t.productsOffered} = ${t.productRowsDisclosed} + ${t.productRowsSuppressed}`,
    ),
    // Superseding travels whole or not at all.
    check(
      'merchant_demand_snapshots_superseded_check',
      sql`num_nonnulls(${t.supersededAt}, ${t.supersededById}) in (0, 2)
          and (${t.supersededById} is null or ${t.supersededById} <> ${t.id})`,
    ),
    // At most ONE live snapshot per (merchant, market, window). A partial
    // unique rather than a service check, because two operators rebuilding the
    // same window at the same time is exactly the race a read-then-write walks
    // past — and the loser reading the winner back is the correct outcome.
    uniqueIndex('merchant_demand_snapshots_live_key')
      .on(t.merchantId, t.market, t.windowFrom, t.windowTo)
      .where(sql`${t.supersededAt} is null`),
    index('merchant_demand_snapshots_merchant_idx').on(t.merchantId, t.createdAt.desc()),
    index('merchant_demand_snapshots_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * `merchant_demand_metrics` — one figure, one snapshot, one dimension tuple.
 *
 * ## There is no `value` column and there is no `total` column
 *
 * A count, an amount and a rate are three different shapes and each gets its
 * own columns, with CHECKs rendered from the shared-types tuples deciding which
 * may be present for which key. A single numeric `value` with a unit beside it
 * is how a currency ends up added to a click count, and #86's "keep affiliate
 * commission, external order value, native GMV and inferred demand as
 * separately labelled metrics" is exactly the instruction not to build that.
 *
 * `kind` is stored rather than looked up, for `analytics_rollups.source`'s
 * reason: "which of these numbers is money somebody else reported" has to be
 * answerable by a query, not by cross-referencing code.
 *
 * ## `unavailable_reason` is what stops a gap becoming a zero
 *
 * A metric that could not be measured is STORED, with a reason and no value.
 * Omitting the row entirely would make "we did not measure it" and "the metric
 * does not exist in this version" the same absence, and a dashboard would
 * render neither — which is how a chart comes to show a merchant nothing where
 * it should show them a stated gap.
 */
export const merchantDemandMetrics = pgTable(
  'merchant_demand_metrics',
  {
    id: generatedId(),
    snapshotId: text()
      .notNull()
      .references(() => merchantDemandSnapshots.id, { onDelete: 'cascade' }),
    metricKey: text().notNull(),
    /** The label that may never be merged with another. */
    kind: text({ enum: asEnumValues(MERCHANT_DEMAND_METRIC_KINDS) }).notNull(),
    /** `''` = not sliced by channel; otherwise `native` or `external`. */
    channel: text().notNull(),
    /** `''` = not sliced by storefront. No FK: a storefront may be retired. */
    storefrontId: text().notNull(),
    /** `''` = not sliced by catalogue source. No FK, for the same reason. */
    sourceId: text().notNull(),
    /** Present exactly for a `count`-unit key that was measured. */
    countValue: bigint({ mode: 'number' }),
    /** Present exactly for a `money`-unit key that was measured. */
    amountValue: bigint({ mode: 'number' }),
    amountCurrency: text(),
    /** Present exactly for a `rate`-unit key that was measured. */
    rateNumerator: bigint({ mode: 'number' }),
    rateDenominator: bigint({ mode: 'number' }),
    /**
     * For a product-composed figure, what population it covers.
     *
     * NULL for every metric that has no product breakdown beside it. Where one
     * exists, the aggregate and the rows are ONE partition and the difference
     * between them is a residual over the withheld products — publishable only
     * when at least `MERCHANT_DEMAND_RESIDUAL_MIN_CONTRIBUTORS` of them
     * contribute to it. When it is folded away the figure covers the disclosed
     * rows only, and this column is what says so rather than leaving a partial
     * total wearing the whole catalogue's name.
     */
    aggregateBasis: text({ enum: asEnumValues(MERCHANT_DEMAND_AGGREGATE_BASES) }),
    /** Set when the floor withheld the figure. Never stored WITH a value. */
    suppressedBelow: integer(),
    /** Set when there is no figure at all. Never stored WITH a value. */
    unavailableReason: text({ enum: asEnumValues(MERCHANT_DEMAND_UNAVAILABLE_REASONS) }),
    /** The issue that owes it, when the reason is `awaiting_seam`. */
    unavailableSeam: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('merchant_demand_metrics_bucket_key').on(
      t.snapshotId,
      t.metricKey,
      t.channel,
      t.storefrontId,
      t.sourceId,
    ),
    checkOneOf('merchant_demand_metrics_metric_key_check', t.metricKey, MERCHANT_DEMAND_METRIC_KEYS),
    checkOneOf('merchant_demand_metrics_kind_check', t.kind, MERCHANT_DEMAND_METRIC_KINDS),
    checkOneOf(
      'merchant_demand_metrics_aggregate_basis_check',
      t.aggregateBasis,
      MERCHANT_DEMAND_AGGREGATE_BASES,
    ),
    checkOneOf(
      'merchant_demand_metrics_unavailable_reason_check',
      t.unavailableReason,
      MERCHANT_DEMAND_UNAVAILABLE_REASONS,
    ),
    check(
      'merchant_demand_metrics_channel_check',
      sql`${t.channel} = '' or ${t.channel} in (${sql.raw(inList(MERCHANT_DEMAND_CHANNELS))})`,
    ),
    // Exactly ONE of the three states, and the shape follows the state.
    check(
      'merchant_demand_metrics_state_check',
      sql`num_nonnulls(${t.suppressedBelow}, ${t.unavailableReason}) <= 1
          and (
            (${t.suppressedBelow} is null and ${t.unavailableReason} is null)
            or num_nonnulls(${t.countValue}, ${t.amountValue}, ${t.rateNumerator}) = 0
          )`,
    ),
    // A money key carries an amount AND a currency, or neither. A count key can
    // never carry one, and neither can a rate key — rendered from the same
    // tuples the registry derives, so the CHECK cannot drift from the units.
    check(
      'merchant_demand_metrics_money_shape_check',
      sql`num_nonnulls(${t.amountValue}, ${t.amountCurrency}) in (0, 2)
          and (${t.amountValue} is null
               or ${t.metricKey} in (${sql.raw(inList(MERCHANT_DEMAND_MONEY_METRIC_KEYS))}))`,
    ),
    check(
      'merchant_demand_metrics_rate_shape_check',
      sql`num_nonnulls(${t.rateNumerator}, ${t.rateDenominator}) in (0, 2)
          and (${t.rateNumerator} is null
               or ${t.metricKey} in (${sql.raw(inList(MERCHANT_DEMAND_RATE_METRIC_KEYS))}))
          and (${t.rateDenominator} is null or ${t.rateDenominator} >= 0)
          and (${t.rateNumerator} is null or ${t.rateNumerator} <= ${t.rateDenominator})`,
    ),
    check(
      'merchant_demand_metrics_count_shape_check',
      sql`(${t.countValue} is null or ${t.countValue} >= 0)
          and (${t.countValue} is null
               or ${t.metricKey} not in (${sql.raw(inList(MERCHANT_DEMAND_MONEY_METRIC_KEYS))}))
          and (${t.countValue} is null
               or ${t.metricKey} not in (${sql.raw(inList(MERCHANT_DEMAND_RATE_METRIC_KEYS))}))`,
    ),
    // A basis describes a figure, so a row with no figure cannot carry one:
    // "these are the disclosed rows only" says nothing about a suppressed or
    // unavailable metric, and storing it there would suggest a number exists.
    check(
      'merchant_demand_metrics_basis_shape_check',
      sql`${t.aggregateBasis} is null
          or (${t.suppressedBelow} is null and ${t.unavailableReason} is null)`,
    ),
    // A seam name is only meaningful beside a reason. It is NOT restricted to
    // `awaiting_seam`: the two REFUSALS cite an issue too, and that citation is
    // the difference between "#79 has not built it" and "#79 decided nobody may
    // ask" — a reader needs to be able to open the argument either way.
    check(
      'merchant_demand_metrics_seam_check',
      sql`${t.unavailableSeam} is null or ${t.unavailableReason} is not null`,
    ),
    ...currencyChecks('merchant_demand_metrics', [t.amountCurrency]),
    index('merchant_demand_metrics_snapshot_idx').on(t.snapshotId, t.metricKey),
  ],
);

/**
 * `merchant_demand_products` — the product-level rows the floor admitted.
 *
 * A row EXISTS only above `merchant_demand_snapshots.product_floor`, which is
 * #86 privacy 1 held by the writer rather than by a filter at read: a suppressed
 * product that was stored and filtered later is a suppressed product one query
 * away from being read. The snapshot's `product_rows_suppressed` counter is how
 * many were withheld, and the CHECK above makes the two add up to the products
 * the merchant offers, so a report cannot quietly lose rows.
 *
 * There is no per-product money column and there is no per-product buyer,
 * session or actor column. A product row answers "how much interest did this
 * product attract and can you sell it here", which is the question a merchant
 * acts on.
 */
export const merchantDemandProducts = pgTable(
  'merchant_demand_products',
  {
    id: generatedId(),
    snapshotId: text()
      .notNull()
      .references(() => merchantDemandSnapshots.id, { onDelete: 'cascade' }),
    canonicalProductId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'cascade' }),
    productPageViews: bigint({ mode: 'number' }).notNull(),
    offerImpressions: bigint({ mode: 'number' }).notNull(),
    /** Whether the merchant has an active NATIVE offer on this product. */
    hasNativeOffer: boolean().notNull(),
    /** #68's verdict for the merchant's freshest offer on the product. */
    offerFreshness: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('merchant_demand_products_key').on(t.snapshotId, t.canonicalProductId),
    check(
      'merchant_demand_products_counts_check',
      sql`${t.productPageViews} >= 0 and ${t.offerImpressions} >= 0`,
    ),
    checkOneOf('merchant_demand_products_freshness_check', t.offerFreshness, [
      'current',
      'warning',
      'expired',
      'unavailable',
      'unknown',
    ]),
    index('merchant_demand_products_snapshot_idx').on(t.snapshotId, t.productPageViews.desc()),
  ],
);

/**
 * `merchant_acquisition_candidates` — one merchant Mercaria might approach.
 *
 * One row per merchant (a plain unique, not a partial one: a candidate is not a
 * lifecycle with several live instances, it is a merchant's standing in one
 * pipeline). Excluding a merchant does not delete the row — the whole point of
 * `do_not_contact` is that it must survive somebody re-running the scorer.
 *
 * `score_bps` is a CACHE of `scoreMerchantAcquisition` over facts drawn from a
 * snapshot, and `snapshot_id` names the snapshot it was drawn from. That makes
 * a score auditable — an operator can open the evidence — and it is why there is
 * no "set the score" action: rescoring rebuilds the facts and re-runs the pure
 * function.
 *
 * `contributing_inputs` and `unmeasured_inputs` are stored beside it because a
 * score of 3,200 built from two inputs and one built from six mean different
 * things, and a bare number cannot say which it is.
 */
export const merchantAcquisitionCandidates = pgTable(
  'merchant_acquisition_candidates',
  {
    id: generatedId(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    state: text({ enum: asEnumValues(MERCHANT_ACQUISITION_STATES) }).notNull(),
    /** 0–10000 basis points. A CACHE of the pure scorer; `snapshot_id` is the evidence. */
    scoreBps: integer().notNull().default(0),
    scoreVersion: text().notNull(),
    scoredAt: timestamptz(),
    /** The snapshot the score was computed from. RESTRICT would block the sweep. */
    snapshotId: text().references(() => merchantDemandSnapshots.id, { onDelete: 'set null' }),
    contributingInputs: text().array().notNull().default(sql`'{}'::text[]`),
    unmeasuredInputs: text().array().notNull().default(sql`'{}'::text[]`),
    /** An Oxy account id — no FK; Oxy owns identity. */
    assignedToOxyUserId: text(),
    /** A bounded next step, in the operator's own words. */
    nextAction: text(),
    nextActionDueAt: timestamptz(),
    /**
     * The merchant asked not to be contacted, or Mercaria decided not to.
     *
     * A BOOLEAN beside the state rather than a state value, deliberately: a
     * do-not-contact request must survive a candidate being re-queued by
     * somebody who did not read the state, and a value in the same column
     * cannot do that.
     */
    doNotContact: boolean().notNull().default(false),
    doNotContactRecordedAt: timestamptz(),
    exclusionReason: text({ enum: asEnumValues(MERCHANT_ACQUISITION_EXCLUSION_REASONS) }),
    excludedAt: timestamptz(),
    excludedByOxyUserId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('merchant_acquisition_candidates_merchant_key').on(t.merchantId),
    checkOneOf('merchant_acquisition_candidates_state_check', t.state, MERCHANT_ACQUISITION_STATES),
    checkOneOf(
      'merchant_acquisition_candidates_exclusion_check',
      t.exclusionReason,
      MERCHANT_ACQUISITION_EXCLUSION_REASONS,
    ),
    checkEveryElementOf(
      'merchant_acquisition_candidates_contributing_check',
      t.contributingInputs,
      MERCHANT_ACQUISITION_SCORE_INPUTS,
    ),
    checkEveryElementOf(
      'merchant_acquisition_candidates_unmeasured_check',
      t.unmeasuredInputs,
      MERCHANT_ACQUISITION_SCORE_INPUTS,
    ),
    check(
      'merchant_acquisition_candidates_score_check',
      sql`${t.scoreBps} between 0 and 10000
          and (${t.scoredAt} is null) = (${t.snapshotId} is null)`,
    ),
    // Exclusion travels whole: a reason with no instant names no decision, and
    // an instant with no reason names no decision either.
    check(
      'merchant_acquisition_candidates_exclusion_shape_check',
      sql`num_nonnulls(${t.exclusionReason}, ${t.excludedAt}, ${t.excludedByOxyUserId}) in (0, 3)
          and (${t.state} = 'excluded') = (${t.excludedAt} is not null)`,
    ),
    // A do-not-contact flag says WHEN it was recorded, or it is not a record.
    check(
      'merchant_acquisition_candidates_dnc_check',
      sql`${t.doNotContact} = (${t.doNotContactRecordedAt} is not null)`,
    ),
    // A next action names a deadline. An action nobody is due to take is a note.
    check(
      'merchant_acquisition_candidates_next_action_check',
      sql`num_nonnulls(${t.nextAction}, ${t.nextActionDueAt}) in (0, 2)
          and (${t.nextAction} is null or length(${t.nextAction}) between 1 and 500)`,
    ),
    index('merchant_acquisition_candidates_queue_idx')
      .on(t.state, t.scoreBps.desc())
      .where(sql`${t.state} in (${sql.raw(inList(MERCHANT_ACQUISITION_OPEN_STATES))})`),
    index('merchant_acquisition_candidates_assignee_idx')
      .on(t.assignedToOxyUserId, t.nextActionDueAt)
      .where(sql`${t.assignedToOxyUserId} is not null`),
  ],
);

/**
 * `merchant_acquisition_contact_sources` — WHERE a public business contact is
 * published. Never the contact.
 *
 * See the file docblock. `source_url` is a page an operator opens; `locator_note`
 * says where on it to look, in the operator's own words, bounded and CHECKed so
 * it cannot become a place to paste the address it exists to point at. A digit
 * run and an at-sign are both refused, which is the one shape-level defence
 * available against a note that quietly becomes a value.
 *
 * Append-only against UPDATE by trigger. A provenance record that can be edited
 * is a provenance record that can be made to describe a source it did not come
 * from.
 */
export const merchantAcquisitionContactSources = pgTable(
  'merchant_acquisition_contact_sources',
  {
    id: generatedId(),
    candidateId: text()
      .notNull()
      .references(() => merchantAcquisitionCandidates.id, { onDelete: 'cascade' }),
    kind: text({ enum: asEnumValues(MERCHANT_ACQUISITION_CONTACT_SOURCE_KINDS) }).notNull(),
    /** An https URL to a page the merchant or a registry published. */
    sourceUrl: text().notNull(),
    /** Where on that page. Bounded, and shape-CHECKed against carrying a value. */
    locatorNote: text().notNull(),
    /** When the operator saw it there. */
    observedAt: timestamptz().notNull(),
    /** An Oxy account id — no FK; Oxy owns identity. */
    recordedByOxyUserId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'merchant_acquisition_contact_sources_kind_check',
      t.kind,
      MERCHANT_ACQUISITION_CONTACT_SOURCE_KINDS,
    ),
    // The same source recorded twice converges rather than accumulating.
    uniqueIndex('merchant_acquisition_contact_sources_key').on(t.candidateId, t.kind, t.sourceUrl),
    // The length bound is a `length()` call and NOT a `{3,500}` repetition:
    // PostgreSQL caps a regex repetition count at 255 and answers
    // `invalid repetition count(s)` when the CHECK is COMPILED, which is at
    // INSERT time — so the obvious spelling generates cleanly, applies cleanly
    // and then refuses every row with an error about a regex. Found on the
    // first real-server run of this table.
    check(
      'merchant_acquisition_contact_sources_url_check',
      sql`length(${t.sourceUrl}) between 12 and 500
          and ${t.sourceUrl} ~ '^https://[^[:space:]]+$'`,
    ),
    // A locator says where to look. An at-sign or a run of five digits is a
    // contact wearing a note's clothes, and this is the one place a shape check
    // can refuse it — the column would otherwise be the hole the whole "no
    // contact values" decision has to be argued around.
    check(
      'merchant_acquisition_contact_sources_locator_check',
      sql`length(${t.locatorNote}) between 1 and 200
          and ${t.locatorNote} !~ '@'
          and ${t.locatorNote} !~ '[0-9]{5}'`,
    ),
    index('merchant_acquisition_contact_sources_candidate_idx').on(t.candidateId, t.observedAt),
  ],
);

/**
 * `merchant_acquisition_outreach` — the prior-outreach log (#86 acquisition 3).
 *
 * A record of what a PERSON did, written after they did it. Nothing in this
 * repository sends an email, a message or a notification to a merchant on the
 * strength of a row here, and #86 acquisition 8 ("no automatic email or
 * messaging in this issue") is held by that absence plus a scanned gate: no
 * module in the domain may import a transport, a mailer or a notification
 * service.
 *
 * Append-only against UPDATE *and* DELETE by trigger. "Who contacted this
 * merchant, when, and what came of it" is exactly the kind of record whose value
 * is that it cannot be tidied.
 */
export const merchantAcquisitionOutreach = pgTable(
  'merchant_acquisition_outreach',
  {
    id: generatedId(),
    candidateId: text()
      .notNull()
      .references(() => merchantAcquisitionCandidates.id, { onDelete: 'restrict' }),
    channel: text({ enum: asEnumValues(MERCHANT_ACQUISITION_OUTREACH_CHANNELS) }).notNull(),
    outcome: text({ enum: asEnumValues(MERCHANT_ACQUISITION_OUTREACH_OUTCOMES) }).notNull(),
    occurredAt: timestamptz().notNull(),
    /** An Oxy account id — no FK; Oxy owns identity. */
    actorOxyUserId: text().notNull(),
    /** Which recorded public source the operator used, when they used one. */
    contactSourceId: text().references(() => merchantAcquisitionContactSources.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'merchant_acquisition_outreach_channel_check',
      t.channel,
      MERCHANT_ACQUISITION_OUTREACH_CHANNELS,
    ),
    checkOneOf(
      'merchant_acquisition_outreach_outcome_check',
      t.outcome,
      MERCHANT_ACQUISITION_OUTREACH_OUTCOMES,
    ),
    index('merchant_acquisition_outreach_candidate_idx').on(t.candidateId, t.occurredAt.desc()),
  ],
);

/**
 * `merchant_acquisition_audits` — every operator ATTEMPT, refusals included.
 *
 * `payment_repairs` is the shape and the reason is the same: a surface whose
 * audit records only what succeeded cannot answer the question an incident
 * review asks, which is who tried. `outcome` is a string discriminant
 * (`granted | refused`), never a boolean — this backend compiles without
 * `strictNullChecks` and does not narrow a union on a boolean-literal
 * discriminant.
 *
 * Append-only against UPDATE *and* DELETE by trigger, and NOT swept: an audit
 * with a retention clock is an audit that disappears exactly when somebody
 * starts looking for it.
 */
export const merchantAcquisitionAudits = pgTable(
  'merchant_acquisition_audits',
  {
    id: generatedId(),
    /** The merchant the attempt was about. No FK: an audit outlives a merge. */
    merchantId: text(),
    action: text({ enum: asEnumValues(MERCHANT_ACQUISITION_ACTIONS) }).notNull(),
    outcome: text({ enum: asEnumValues(['granted', 'refused']) }).notNull(),
    /** Bounded, so a refusal cannot become a place to write prose about a person. */
    refusalCode: text(),
    /** An Oxy account id — no FK; Oxy owns identity. */
    actorOxyUserId: text().notNull(),
    occurredAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('merchant_acquisition_audits_action_check', t.action, MERCHANT_ACQUISITION_ACTIONS),
    checkOneOf('merchant_acquisition_audits_outcome_check', t.outcome, ['granted', 'refused']),
    check(
      'merchant_acquisition_audits_refusal_check',
      sql`(${t.outcome} = 'refused') = (${t.refusalCode} is not null)
          and (${t.refusalCode} is null or ${t.refusalCode} ~ '^[a-z_]{3,64}$')`,
    ),
    index('merchant_acquisition_audits_actor_idx').on(t.actorOxyUserId, t.occurredAt.desc()),
    index('merchant_acquisition_audits_merchant_idx')
      .on(t.merchantId, t.occurredAt.desc())
      .where(sql`${t.merchantId} is not null`),
  ],
);

/** A row of {@link merchantDemandSnapshots}. */
export type MerchantDemandSnapshotRow = typeof merchantDemandSnapshots.$inferSelect;

/** A row of {@link merchantDemandMetrics}. */
export type MerchantDemandMetricStoredRow = typeof merchantDemandMetrics.$inferSelect;

/** A row of {@link merchantDemandProducts}. */
export type MerchantDemandProductStoredRow = typeof merchantDemandProducts.$inferSelect;

/** A row of {@link merchantAcquisitionCandidates}. */
export type MerchantAcquisitionCandidateRow = typeof merchantAcquisitionCandidates.$inferSelect;

/** A row of {@link merchantAcquisitionContactSources}. */
export type MerchantAcquisitionContactSourceRow =
  typeof merchantAcquisitionContactSources.$inferSelect;

/** A row of {@link merchantAcquisitionOutreach}. */
export type MerchantAcquisitionOutreachRow = typeof merchantAcquisitionOutreach.$inferSelect;

/** A row of {@link merchantAcquisitionAudits}. */
export type MerchantAcquisitionAuditRow = typeof merchantAcquisitionAudits.$inferSelect;
