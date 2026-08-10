/**
 * The BOUNDED RETAIL PILOT (#125 "Pilot cohort", "Stop thresholds", "Provider
 * funding"): `retail_pilot_cohorts`, `retail_pilot_skus`,
 * `retail_pilot_stop_thresholds`, `retail_pilot_stops`,
 * `supplier_funding_observations`.
 *
 * Five tables answering one question none of #120–#124 asks: **how much of this
 * is Mercaria willing to do at all, today.** #121 answers whether an item may
 * lawfully be sold, #120 what it costs, #122 what the supplier says and #124
 * how the order is placed — and a deployment where all four answer "yes" is
 * exactly the state #125 exists to bound.
 *
 * ## Why a versioned cohort rather than environment variables
 *
 * Every bound here could have been a `RETAIL_PILOT_*` variable, and that is the
 * design this schema rejects. Three reasons, in the order they bite:
 *
 *  1. **A bound has to be attributable.** "Why was the order ceiling €150" is a
 *     question with an answer — a person, a date, a note — and an environment
 *     variable has none of those. `published_by_oxy_user_id` is NOT NULL.
 *  2. **A bound has to be stable across a deploy.** A variable changes when
 *     somebody edits a task definition, which is not an event anybody reviews;
 *     a cohort version is immutable once active (a trigger) and a change is a
 *     NEW version, so the bounds a pilot ran under are still readable after it
 *     is widened. That is #125's "expansion requires a measured review"
 *     (acceptance 8) made structural rather than aspirational.
 *  3. **A SKU allow-list is a table.** Twenty-five SKUs in a comma-separated
 *     variable is a list nobody can review, nobody can attribute a line of, and
 *     which silently admits everything on a typo.
 *
 * The one thing that IS a variable is `MERCARIA_RETAIL_ENABLED` (#123), and it
 * stays one: a kill switch has to be flippable without a migration.
 *
 * ## What a stop pauses, and what it deliberately does not
 *
 * A breach halts ENTRY and nothing else. `assertRetailPilotAdmits` is called
 * from checkout and from nowhere else, so a live stop refuses new retail
 * checkouts while every placed purchase order keeps being submitted, polled,
 * cancelled, refunded and reconciled. That is the whole content of #125's
 * "preserves existing-order operations", and it is a property of the CALL GRAPH
 * rather than a rule in a handler: there is no scope value that could pause
 * fulfilment, because fulfilment never asks.
 *
 * ## The funding table records an OBSERVATION, never a balance
 *
 * `supplier_funding_observations` is append-only and every row names its source
 * and its instant. There is deliberately no `supplier_accounts.balance` column
 * beside it: a single mutable figure is one stale write away from admitting a
 * checkout against money that is not there, and the whole point of the
 * prefunded model (ADR 0004 D6) is that Mercaria knows what it has. The
 * derivation reads the LATEST observation and applies the cohort's floor, so a
 * stale observation ages out of usefulness rather than silently staying true.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  RETAIL_PILOT_AUDIENCES,
  RETAIL_PILOT_COHORT_STATUSES,
  RETAIL_PILOT_STOP_METRICS,
  RETAIL_PILOT_STOP_ORIGINS,
  RETAIL_PILOT_STOP_SCOPES,
  RETAIL_PILOT_THRESHOLD_UNITS,
  SUPPLIER_FUNDING_SOURCES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, CURRENCY_CODE_VALUES, currencyChecks, money } from './columns';
import { procurementOffers, supplierAccounts, suppliers } from './procurement';

/**
 * `retail_pilot_cohorts` — one immutable statement of what the pilot may do.
 *
 * One ACTIVE version per `cohort_key` (a partial unique), frozen once active (a
 * trigger) — the `fee_schedules` mechanism, chosen because it is the shape this
 * codebase already uses for "a policy somebody published and orders were placed
 * under". A widening is a new version with its own author and date, which is
 * what makes the review acceptance 8 asks for something a reader can find.
 *
 * ONE supplier account and ONE market, both NOT NULL, because #125's pilot
 * cohort items 1–3 are singular and a nullable column would make "unrestricted"
 * representable. The cohort names Mercaria's own seller entity implicitly: a
 * `mercaria_retail` order carries no owner columns at all (#123), so there is
 * nothing to scope and nothing that could name a second seller.
 */
export const retailPilotCohorts = pgTable(
  'retail_pilot_cohorts',
  {
    id: generatedId(),
    /**
     * Which pilot. A code CONSTANT today (`RETAIL_PILOT_COHORT_KEY`) and never a
     * variable, for `RETAIL_ELIGIBILITY_POLICY_KEY`'s reason: a deployment able
     * to point at a different key could run under bounds nobody published.
     */
    cohortKey: text().notNull(),
    version: integer().notNull(),
    status: text({ enum: asEnumValues(RETAIL_PILOT_COHORT_STATUSES) }).notNull().default('draft'),

    /** The single supplier and account #125 pilot cohort 2 permits. */
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'restrict' }),

    /** ISO-3166-1 alpha-2. ONE market (#125 pilot cohort 3). */
    marketCountry: text().notNull(),
    /** The single presentment currency the pilot prices in (#125 pilot cohort 3). */
    currency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),

    audience: text({ enum: asEnumValues(RETAIL_PILOT_AUDIENCES) }).notNull(),
    /**
     * Present EXACTLY when the audience is `percentage` — a CHECK, both
     * directions. A percentage with no number admits nobody or everybody
     * depending on who reads it; a number beside a non-percentage audience is a
     * bound nothing applies.
     */
    audiencePercentageBps: integer(),

    /** #125 pilot cohort 5: low maximum item and order value, and a floor. */
    ...money('maxItemTotal'),
    ...money('maxOrderTotal'),
    ...money('minOrderTotal'),
    maxLineQuantity: integer().notNull(),

    /**
     * #125 pilot cohort 6. EMPTY means NONE, not unrestricted — the
     * `supplier_agreements` grant semantics (#121), and the reason a freshly
     * drafted cohort permits nothing at all rather than everything.
     */
    permittedShippingServiceCodes: text().array().notNull().default([]),

    /**
     * The prefunded-wallet policy (ADR 0004 D6, #125 provider funding 3 and 5).
     *
     * `funding_floor` is the balance below which a customer payment must not
     * proceed; `funding_alert` is the higher figure that pages treasury BEFORE
     * exhaustion. Alert ≥ floor is a CHECK: an alert below the floor fires
     * after checkout has already stopped, which is a notification about an
     * outage rather than a warning before one.
     */
    ...money('fundingFloor'),
    ...money('fundingAlert'),
    /** #119 §10's ≤ €2,000/month cumulative supplier spend cap. */
    ...money('monthlySpendCap'),

    /**
     * How old a funding observation may be and still be read as current.
     *
     * Printful exposes no balance endpoint (`docs/suppliers/printful.md` §14),
     * so the freshest figure available is one an operator typed in. A staleness
     * bound is what stops last month's balance authorising today's purchases.
     */
    fundingObservationMaxAgeSeconds: integer().notNull(),

    publishedAt: timestamptz(),
    /** NOT NULL on an active row (a CHECK). A bound with no author is not a decision. */
    publishedByOxyUserId: text(),
    supersededAt: timestamptz(),
    /** Why these bounds. Free text, read by a person, never matched on. */
    rationale: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('retail_pilot_cohorts_status_check', t.status, RETAIL_PILOT_COHORT_STATUSES),
    checkOneOf('retail_pilot_cohorts_audience_check', t.audience, RETAIL_PILOT_AUDIENCES),
    ...currencyChecks('retail_pilot_cohorts', [
      t.currency,
      t.maxItemTotalCurrency,
      t.maxOrderTotalCurrency,
      t.minOrderTotalCurrency,
      t.fundingFloorCurrency,
      t.fundingAlertCurrency,
      t.monthlySpendCapCurrency,
    ]),
    check('retail_pilot_cohorts_version_check', sql`${t.version} >= 1`),
    check(
      'retail_pilot_cohorts_market_check',
      sql`${t.marketCountry} ~ '^[A-Z]{2}$'`,
    ),
    // The audience biconditional.
    check(
      'retail_pilot_cohorts_audience_percentage_check',
      sql`(${t.audience} = 'percentage') = (${t.audiencePercentageBps} is not null)
          and (${t.audiencePercentageBps} is null
               or (${t.audiencePercentageBps} > 0 and ${t.audiencePercentageBps} <= 10000))`,
    ),
    check(
      'retail_pilot_cohorts_value_bounds_check',
      sql`${t.maxItemTotalAmount} > 0 and ${t.maxOrderTotalAmount} > 0
          and ${t.minOrderTotalAmount} >= 0
          and ${t.minOrderTotalAmount} <= ${t.maxOrderTotalAmount}
          and ${t.maxItemTotalAmount} <= ${t.maxOrderTotalAmount}
          and ${t.maxLineQuantity} >= 1`,
    ),
    check(
      'retail_pilot_cohorts_funding_check',
      sql`${t.fundingFloorAmount} >= 0
          and ${t.fundingAlertAmount} >= ${t.fundingFloorAmount}
          and ${t.monthlySpendCapAmount} > 0
          and ${t.fundingObservationMaxAgeSeconds} >= 60`,
    ),
    // An ACTIVE cohort is a published one, with a publisher and a date. A draft
    // may have neither; a superseded one keeps both.
    check(
      'retail_pilot_cohorts_publication_check',
      sql`(${t.status} = 'draft')
          or (${t.publishedAt} is not null and ${t.publishedByOxyUserId} is not null)`,
    ),
    check(
      'retail_pilot_cohorts_superseded_check',
      sql`(${t.status} = 'superseded') = (${t.supersededAt} is not null)`,
    ),
    // `cardinality`, never `array_length`: the latter is NULL on `{}` and a
    // CHECK reads NULL as SATISFIED, so the obvious spelling admits exactly the
    // empty list it exists to refuse. An ACTIVE cohort with no permitted
    // shipping service could never sell anything, which is a bound nobody
    // meant to publish.
    check(
      'retail_pilot_cohorts_shipping_services_check',
      sql`${t.status} <> 'active' or coalesce(cardinality(${t.permittedShippingServiceCodes}), 0) >= 1`,
    ),
    uniqueIndex('retail_pilot_cohorts_key_version_key').on(t.cohortKey, t.version),
    // ONE active version per pilot — the `fee_schedules` partial unique.
    uniqueIndex('retail_pilot_cohorts_active_key')
      .on(t.cohortKey)
      .where(sql`${t.status} = 'active'`),
    index('retail_pilot_cohorts_supplier_idx').on(t.supplierAccountId, t.status),
  ],
);

/**
 * `retail_pilot_skus` — the explicit allow-list (#125 pilot cohort 4).
 *
 * Per COHORT VERSION and cascading from it, so widening the SKU set is the same
 * act as publishing a new cohort: there is no way to add a SKU to a pilot that
 * is already running, which is exactly the "no automatic expansion" rule at the
 * grain it actually gets violated.
 *
 * `procurement_offer_id` is nullable and RESTRICT. Nullable because an operator
 * allow-lists a supplier SKU before the catalogue ingestion has necessarily
 * produced its procurement offer, and demanding one would make the pilot's
 * bounds depend on a sweep having run; RESTRICT because once it is set, the
 * offer is what the checkout gate matched on and deleting it would silently
 * widen the list.
 */
export const retailPilotSkus = pgTable(
  'retail_pilot_skus',
  {
    id: generatedId(),
    cohortId: text()
      .notNull()
      .references(() => retailPilotCohorts.id, { onDelete: 'cascade' }),
    /** The supplier's own SKU, exactly as the procurement offer stores it. */
    supplierSku: text().notNull(),
    procurementOfferId: text().references(() => procurementOffers.id, { onDelete: 'restrict' }),
    /** Who put this SKU in the pilot. Mandatory: an allow-list entry is a decision. */
    addedByOxyUserId: text().notNull(),
    /** Design-IP screening, EU availability, category — the evidence, in words. */
    note: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('retail_pilot_skus_sku_check', sql`length(${t.supplierSku}) > 0`),
    uniqueIndex('retail_pilot_skus_cohort_sku_key').on(t.cohortId, t.supplierSku),
  ],
);

/**
 * `retail_pilot_stop_thresholds` — the twelve #125 names plus #119 §10's
 * non-EU-dispatch one, per cohort version.
 *
 * `UNIQUE(cohort_id, metric)` is what makes a threshold a single fact: two rows
 * for one metric would let a lenient one hide a strict one depending on which
 * the evaluator read first.
 *
 * The UNIT is stored beside the value because the thirteen do not share one —
 * "> 2% of orders", "> €50/week" and "one occurrence" are three different kinds
 * of number, and comparing them as if they were one is how a rate gets read as
 * a count and never fires.
 */
export const retailPilotStopThresholds = pgTable(
  'retail_pilot_stop_thresholds',
  {
    id: generatedId(),
    cohortId: text()
      .notNull()
      .references(() => retailPilotCohorts.id, { onDelete: 'cascade' }),
    metric: text({ enum: asEnumValues(RETAIL_PILOT_STOP_METRICS) }).notNull(),
    unit: text({ enum: asEnumValues(RETAIL_PILOT_THRESHOLD_UNITS) }).notNull(),
    /** A breach is `observed > threshold`. Strictly greater, so a threshold OF one occurrence fires ON the second — see `thresholdValue`'s note in `thresholds.ts`. */
    thresholdValue: bigint({ mode: 'number' }).notNull(),
    /** The trailing window a rate is measured over. `0` means "ever", for a one-occurrence stop. */
    windowHours: integer().notNull(),
    /** What a breach PAUSES. Per threshold, because the thirteen are not equally broad. */
    scope: text({ enum: asEnumValues(RETAIL_PILOT_STOP_SCOPES) }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('retail_pilot_stop_thresholds_metric_check', t.metric, RETAIL_PILOT_STOP_METRICS),
    checkOneOf('retail_pilot_stop_thresholds_unit_check', t.unit, RETAIL_PILOT_THRESHOLD_UNITS),
    checkOneOf('retail_pilot_stop_thresholds_scope_check', t.scope, RETAIL_PILOT_STOP_SCOPES),
    check(
      'retail_pilot_stop_thresholds_value_check',
      sql`${t.thresholdValue} >= 0 and ${t.windowHours} >= 0
          and (${t.unit} <> 'rate_bps' or ${t.thresholdValue} <= 10000)`,
    ),
    uniqueIndex('retail_pilot_stop_thresholds_cohort_metric_key').on(t.cohortId, t.metric),
  ],
);

/**
 * `retail_pilot_stops` — a threshold that was crossed, and the entry it paused.
 *
 * ONE live stop per (cohort, metric, scope, subject) by a partial unique, so two
 * evaluations of one breach converge on one row rather than paging twice — the
 * `retail_suppressions` device (#121).
 *
 * A LIFT keeps the row. Nothing here deletes: a pilot that stopped and was
 * restarted is the most important thing in its own history, and the review
 * acceptance 8 asks for is unreadable without it.
 */
export const retailPilotStops = pgTable(
  'retail_pilot_stops',
  {
    id: generatedId(),
    cohortId: text()
      .notNull()
      .references(() => retailPilotCohorts.id, { onDelete: 'restrict' }),
    metric: text({ enum: asEnumValues(RETAIL_PILOT_STOP_METRICS) }).notNull(),
    scope: text({ enum: asEnumValues(RETAIL_PILOT_STOP_SCOPES) }).notNull(),
    /**
     * WHICH supplier, market or SKU this stop covers — empty for a `pilot`-scoped
     * one, which covers everything. A plain text handle rather than a foreign
     * key, because the three scopes name three different kinds of thing and a
     * polymorphic pair would be three nullable columns nobody can index.
     */
    scopeRef: text().notNull(),
    origin: text({ enum: asEnumValues(RETAIL_PILOT_STOP_ORIGINS) }).notNull(),
    observedValue: bigint({ mode: 'number' }).notNull(),
    thresholdValue: bigint({ mode: 'number' }).notNull(),
    raisedAt: timestamptz().notNull(),
    /**
     * NULL for an `automatic` stop and NOT NULL for an `operator` one — a CHECK.
     * Attributing a threshold evaluation to a person makes the audit trail say
     * something false; leaving an operator's decision unattributed makes it say
     * nothing.
     */
    raisedByOxyUserId: text(),
    detail: text().notNull(),
    liftedAt: timestamptz(),
    liftedByOxyUserId: text(),
    liftReason: text(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('retail_pilot_stops_metric_check', t.metric, RETAIL_PILOT_STOP_METRICS),
    checkOneOf('retail_pilot_stops_scope_check', t.scope, RETAIL_PILOT_STOP_SCOPES),
    checkOneOf('retail_pilot_stops_origin_check', t.origin, RETAIL_PILOT_STOP_ORIGINS),
    check(
      'retail_pilot_stops_origin_raiser_check',
      sql`(${t.origin} = 'operator') = (${t.raisedByOxyUserId} is not null)`,
    ),
    // A lift is attributable, dated and explained, all three or none — the
    // `retail_suppressions` lift rule (#121).
    check(
      'retail_pilot_stops_lift_check',
      sql`num_nonnulls(${t.liftedAt}, ${t.liftedByOxyUserId}, ${t.liftReason}) in (0, 3)`,
    ),
    check(
      'retail_pilot_stops_scope_ref_check',
      sql`(${t.scope} = 'pilot') = (${t.scopeRef} = '')`,
    ),
    uniqueIndex('retail_pilot_stops_live_key')
      .on(t.cohortId, t.metric, t.scope, t.scopeRef)
      .where(sql`${t.liftedAt} is null`),
    index('retail_pilot_stops_cohort_idx').on(t.cohortId, t.raisedAt),
  ],
);

/**
 * `supplier_funding_observations` — what Mercaria's prefunded balance was, when,
 * and who says so (ADR 0004 D6, #125 provider funding 2).
 *
 * Append-only and per OBSERVATION. There is deliberately no mutable balance
 * column on `supplier_accounts`: a single figure is one stale write away from
 * admitting a checkout against money that is not there, and the prefunded model
 * exists precisely so Mercaria knows what it has.
 *
 * **No payment credential is stored here or anywhere else** (#125 provider
 * funding 1). A top-up is a treasury act performed in Printful's own dashboard
 * under D6.5 dual control; what Mercaria records is the RESULT. The columns
 * that could hold a card, an IBAN or a mandate do not exist, which is the same
 * defence the analytics domain uses — absence, not redaction.
 */
export const supplierFundingObservations = pgTable(
  'supplier_funding_observations',
  {
    id: generatedId(),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    ...money('balance'),
    source: text({ enum: asEnumValues(SUPPLIER_FUNDING_SOURCES) }).notNull(),
    /** The PROVIDER's clock where it states one, else the operator's reading. */
    observedAt: timestamptz().notNull(),
    /**
     * Who recorded it. NOT NULL for `operator_entry` (a CHECK) and null for a
     * provider reading: a figure a person typed and a figure an API returned are
     * different kinds of evidence and must not be told apart by guessing.
     */
    recordedByOxyUserId: text(),
    note: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('supplier_funding_observations_source_check', t.source, SUPPLIER_FUNDING_SOURCES),
    ...currencyChecks('supplier_funding_observations', [t.balanceCurrency]),
    check('supplier_funding_observations_balance_check', sql`${t.balanceAmount} >= 0`),
    check(
      'supplier_funding_observations_recorder_check',
      sql`(${t.source} = 'operator_entry') = (${t.recordedByOxyUserId} is not null)`,
    ),
    // "The latest observation for this account" is the only read this table has.
    index('supplier_funding_observations_latest_idx').on(t.supplierAccountId, t.observedAt),
  ],
);
