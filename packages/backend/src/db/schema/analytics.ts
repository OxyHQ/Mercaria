/**
 * The discovery-analytics domain (#77) — seven Postgres-born tables.
 *
 * `analytics_events` (the versioned envelope), `analytics_search_queries` (the
 * query record, kept structurally apart from identity),
 * `analytics_query_aggregates` (the thresholded reporting surface),
 * `analytics_rollups` (metric buckets, so raw events can be deleted without
 * losing the numbers), `analytics_experiments` +
 * `analytics_experiment_exposures`, and `analytics_pseudonym_salts` (the
 * rotating secret the pseudonymous session id is derived under).
 *
 * ## The shape of the whole domain is an ALLOW-LIST
 *
 * Every property an event may carry is a real, typed, nullable COLUMN. There is
 * no `properties jsonb` anywhere in this file and none may be added — the
 * payments domain's `services/payments/redact.ts` is the precedent and the
 * reasoning is stronger here. A provider's payload arrives shaped by somebody
 * else and has to be reduced; an analytics property is composed by OUR OWN
 * code, so an open bag is not a defence against a third party, it is an
 * invitation to whoever is in a hurry. A postal address, an order note or a
 * page payload reaches production through exactly one mechanism, and this file
 * removes it.
 *
 * The columns that are ABSENT are the enforcement of #77's identity rules, and
 * each absence answers a named rule: no `email`, no `email_hash`, no `phone`,
 * no `card_fingerprint`, no `provider_customer_id`, no `wallet_identity`, no
 * `ip_address`, no `user_agent`, no `device_fingerprint`, no `token`, no
 * `order_note`. `analytics-forbidden-columns.test.ts` scans every column of
 * every table here against that shape, with a vacuity floor and a mutation
 * self-test, so a future column named `buyer_email` fails the build.
 *
 * ## Two identity fields, mutually exclusive, and neither is a person
 *
 * `oxy_user_id` is present only when the actor was a verified Oxy account AND
 * consent permitted (envelope field 3). `pseudonymous_session_id` is a one-way
 * hash of a session handle under a salt this deployment holds and ROTATES —
 * `analytics_pseudonym_salts`, swept on its own retention, so an expired epoch
 * cannot be recomputed by anyone including Mercaria. A CHECK holds that at most
 * one of the two is set, which is "a pseudonymous pre-purchase session is not
 * an Oxy user" (identity rule 1) as a constraint rather than a convention.
 *
 * ## The commerce correlation is RESTRICTED by a CHECK, not by a habit
 *
 * `checkout_group_id` and `order_id` may appear only on the event types
 * `ANALYTICS_COMMERCE_CORRELATED_EVENT_TYPES` names — every one of them at or
 * after checkout begins. A `product_page_view` carrying a checkout group is
 * refused by the database. That is envelope field 5's "only for documented
 * commerce metrics after checkout begins", rendered from the shared-types
 * tuple so the list cannot drift from the one the metric registry reads.
 *
 * ## Retention is per event CLASS and the raw text has its own clock
 *
 * `analytics_events.expires_at` and `analytics_search_queries.expires_at` are
 * both registered in `db/expiryTargets.ts`; `analytics_search_queries` carries
 * a SECOND deadline, `text_expires_at`, after which the redacted text is nulled
 * and the normalized tokens survive alone. Rollups are computed BEFORE either
 * sweep runs, so deleting raw events costs a report nothing (data-lifecycle
 * rule 2).
 */

import { sql } from 'drizzle-orm';
import { check, date, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  ANALYTICS_ACTOR_KINDS,
  ANALYTICS_BUYER_ORIGINS,
  ANALYTICS_BUYER_ORIGIN_EVENT_TYPES,
  ANALYTICS_PAYMENT_METHOD_EVENT_TYPES,
  GUEST_PAYMENT_METHOD_CATEGORIES,
  ANALYTICS_CLIENT_SURFACES,
  ANALYTICS_COLLECTION_MODES,
  ANALYTICS_COMMERCE_CORRELATED_EVENT_TYPES,
  ANALYTICS_CONSENT_STATES,
  ANALYTICS_EVENT_CLASSES,
  ANALYTICS_EVENT_TYPES,
  ANALYTICS_EXPERIMENT_ASSIGNMENT_UNITS,
  ANALYTICS_EXPERIMENT_STATUSES,
  ANALYTICS_EXPERIMENT_STOP_CONDITIONS,
  ANALYTICS_EXPERIMENT_TREATMENT_KINDS,
  ANALYTICS_METRIC_KEYS,
  ANALYTICS_METRIC_SOURCES,
  ANALYTICS_QUERY_REDACTION_KINDS,
  ANALYTICS_REASON_CODES,
  ANALYTICS_TRAFFIC_CLASSES,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';
import { inList } from '@oxyhq/db';

/**
 * `analytics_events` — one row per event, the versioned envelope in columns.
 *
 * The id is `generatedId()` (uuid v7) and NOT caller-supplied, unlike the
 * outbox tables: an outbox id is deterministic because a retry must converge on
 * one row, and an analytics event is an observation — two observations of the
 * same moment are two facts, and collapsing them would silently under-count.
 */
export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: generatedId(),
    /** The envelope contract version this row was written under. */
    envelopeVersion: text().notNull(),
    eventType: text({ enum: asEnumValues(ANALYTICS_EVENT_TYPES) }).notNull(),
    /** The retention class. Stored, not derived, so a reclass is a migration. */
    eventClass: text({ enum: asEnumValues(ANALYTICS_EVENT_CLASSES) }).notNull(),
    /** When it happened, as the emitter observed it. */
    occurredAt: timestamptz().notNull(),
    /** When Mercaria received it. Server clock, never client-supplied. */
    receivedAt: timestamptz().notNull(),
    actorKind: text({ enum: asEnumValues(ANALYTICS_ACTOR_KINDS) }).notNull(),
    /** An Oxy account id — no FK (Oxy owns identity). Consent-gated. */
    oxyUserId: text(),
    /** A rotating one-way hash. NOT a guest session id and not reversible. */
    pseudonymousSessionId: text(),
    /** Which `analytics_pseudonym_salts` epoch produced the hash above. */
    pseudonymEpoch: integer(),
    /** RESTRICTED correlation — see the table docblock and the CHECK below. */
    checkoutGroupId: text(),
    /** RESTRICTED correlation, the order half. */
    orderId: text(),
    clientSurface: text({ enum: asEnumValues(ANALYTICS_CLIENT_SURFACES) }).notNull(),
    /** A bounded version string, shape-CHECKed so it cannot become free text. */
    appVersion: text(),
    /** ISO 3166-1 alpha-2. */
    market: text(),
    // -- Entity ids (envelope field 7). Correlation only; no foreign keys, for
    // -- the reason `referral_touches` carries none: these rows are swept on
    // -- their own retention clock and every entity they name outlives them.
    /** The search this event descends from. Joins a click back to its query. */
    queryEventId: text(),
    listingId: text(),
    productVariantId: text(),
    canonicalProductId: text(),
    canonicalVariantId: text(),
    offerId: text(),
    merchantId: text(),
    storefrontId: text(),
    /** A category slug or id, as the surface addressed it. */
    categoryId: text(),
    /** The native store — the scope merchant analytics reads. */
    storeId: text(),
    /** The search policy version in force (#74's seam). */
    searchPolicyVersion: text(),
    /** The ranking policy version in force (#74's seam). */
    rankingPolicyVersion: text(),
    experimentKey: text(),
    experimentVersion: integer(),
    experimentVariant: text(),
    trafficClass: text({ enum: asEnumValues(ANALYTICS_TRAFFIC_CLASSES) }).notNull(),
    consentState: text({ enum: asEnumValues(ANALYTICS_CONSENT_STATES) }).notNull(),
    collectionMode: text({ enum: asEnumValues(ANALYTICS_COLLECTION_MODES) }).notNull(),
    buyerOrigin: text({ enum: asEnumValues(ANALYTICS_BUYER_ORIGINS) }),
    /**
     * The bounded payment-method category (#111 analytics measure 5).
     *
     * A real column and not a measure, because it is a CATEGORY rather than a
     * number, and not a reuse of `reason_code`, because a method and a refusal
     * are different facts — one column holding both would make "how many people
     * were shown Apple Pay" unanswerable without knowing which of its values
     * are methods.
     */
    paymentMethodCategory: text({ enum: asEnumValues(GUEST_PAYMENT_METHOD_CATEGORIES) }),
    reasonCode: text({ enum: asEnumValues(ANALYTICS_REASON_CODES) }),
    // -- The typed measures allow-list. Five, and a sixth is a migration.
    position: integer(),
    resultCount: integer(),
    latencyMs: integer(),
    quantity: integer(),
    itemCount: integer(),
    createdAt: createdAt(),
    /** The retention deadline, stamped per event class. Swept, never archived. */
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    checkOneOf('analytics_events_event_type_check', t.eventType, ANALYTICS_EVENT_TYPES),
    checkOneOf('analytics_events_event_class_check', t.eventClass, ANALYTICS_EVENT_CLASSES),
    checkOneOf('analytics_events_actor_kind_check', t.actorKind, ANALYTICS_ACTOR_KINDS),
    checkOneOf('analytics_events_client_surface_check', t.clientSurface, ANALYTICS_CLIENT_SURFACES),
    checkOneOf('analytics_events_traffic_class_check', t.trafficClass, ANALYTICS_TRAFFIC_CLASSES),
    checkOneOf('analytics_events_consent_state_check', t.consentState, ANALYTICS_CONSENT_STATES),
    checkOneOf(
      'analytics_events_collection_mode_check',
      t.collectionMode,
      ANALYTICS_COLLECTION_MODES,
    ),
    checkOneOf('analytics_events_buyer_origin_check', t.buyerOrigin, ANALYTICS_BUYER_ORIGINS),
    checkOneOf('analytics_events_reason_code_check', t.reasonCode, ANALYTICS_REASON_CODES),
    checkOneOf(
      'analytics_events_payment_method_category_check',
      t.paymentMethodCategory,
      GUEST_PAYMENT_METHOD_CATEGORIES,
    ),

    // Identity rule 1, as a constraint: the two identity fields are mutually
    // exclusive, an Oxy id belongs only to an Oxy actor, and a pseudonym never
    // does. A row carrying both would be the join this domain exists to refuse.
    check(
      'analytics_events_identity_exclusivity_check',
      sql`num_nonnulls(${t.oxyUserId}, ${t.pseudonymousSessionId}) <= 1
          and (${t.oxyUserId} is null or ${t.actorKind} = 'oxy')
          and (${t.pseudonymousSessionId} is null or ${t.actorKind} <> 'oxy')`,
    ),
    // A pseudonym is meaningless without the epoch that produced it: the salt is
    // deleted on rotation retention, and a hash whose epoch is unknown could
    // never be told apart from a hash under a salt that still exists.
    check(
      'analytics_events_pseudonym_epoch_check',
      sql`num_nonnulls(${t.pseudonymousSessionId}, ${t.pseudonymEpoch}) in (0, 2)`,
    ),
    // Envelope field 3's "and permitted": a denied-consent event can never carry
    // an account id, whatever the caller passed.
    check(
      'analytics_events_consent_identity_check',
      sql`${t.oxyUserId} is null or ${t.consentState} <> 'denied'`,
    ),
    // `off` is the mode in which nothing is collected, so a stored row claiming
    // it is a contradiction — and the one a misconfigured deployment would
    // produce, which is exactly when it must fail loudly.
    check('analytics_events_collection_mode_stored_check', sql`${t.collectionMode} <> 'off'`),
    // Envelope field 5 — the RESTRICTED correlation, rendered from the tuple the
    // metric registry reads so the two cannot drift.
    check(
      'analytics_events_commerce_correlation_check',
      sql`(${t.checkoutGroupId} is null and ${t.orderId} is null)
          or ${t.eventType} in (${sql.raw(inList(ANALYTICS_COMMERCE_CORRELATED_EVENT_TYPES))})`,
    ),
    // Envelope field 12 — buyer origin only where a metric genuinely compares
    // the two flows.
    check(
      'analytics_events_buyer_origin_scope_check',
      sql`${t.buyerOrigin} is null
          or ${t.eventType} in (${sql.raw(inList(ANALYTICS_BUYER_ORIGIN_EVENT_TYPES))})`,
    ),
    // The payment-method dimension, scoped exactly as buyer origin is and for
    // the same reason: a discovery event carrying one would let a merchant
    // report be sliced by how somebody paid.
    check(
      'analytics_events_payment_method_scope_check',
      sql`${t.paymentMethodCategory} is null
          or ${t.eventType} in (${sql.raw(inList(ANALYTICS_PAYMENT_METHOD_EVENT_TYPES))})`,
    ),
    // An experiment assignment travels whole or not at all: a variant with no
    // experiment cannot be attributed and an experiment with no variant cannot
    // be analysed.
    check(
      'analytics_events_experiment_check',
      sql`num_nonnulls(${t.experimentKey}, ${t.experimentVersion}, ${t.experimentVariant}) in (0, 3)`,
    ),
    // Bounded shapes on the two free-ish strings, so neither can carry prose.
    // `app_version` is a build identifier and `market` is a country code; a
    // sentence in either is the shape a payload smuggled into a dimension takes.
    check('analytics_events_market_check', sql`${t.market} is null or ${t.market} ~ '^[A-Z]{2}$'`),
    check(
      'analytics_events_app_version_check',
      sql`${t.appVersion} is null or ${t.appVersion} ~ '^[A-Za-z0-9._+-]{1,64}$'`,
    ),
    // Measures are counts and durations; a negative one is a bug, never a fact.
    check(
      'analytics_events_measures_check',
      sql`coalesce(${t.position}, 0) >= 0
          and coalesce(${t.resultCount}, 0) >= 0
          and coalesce(${t.latencyMs}, 0) >= 0
          and coalesce(${t.quantity}, 0) >= 0
          and coalesce(${t.itemCount}, 0) >= 0`,
    ),

    // The rollup's own scan: everything it aggregates is "events of this type in
    // this window", and the leading type keeps a single metric's pass off the
    // whole table.
    index('analytics_events_type_occurred_at_idx').on(t.eventType, t.occurredAt),
    // The funnel join — a click back to its search, an eligibility refusal back
    // to its checkout. Partial, because most rows carry neither.
    index('analytics_events_query_event_id_idx')
      .on(t.queryEventId, t.occurredAt)
      .where(sql`${t.queryEventId} is not null`),
    index('analytics_events_checkout_group_id_idx')
      .on(t.checkoutGroupId)
      .where(sql`${t.checkoutGroupId} is not null`),
    // Merchant analytics scope. Partial for the same reason.
    index('analytics_events_store_id_idx')
      .on(t.storeId, t.occurredAt)
      .where(sql`${t.storeId} is not null`),
    index('analytics_events_merchant_id_idx')
      .on(t.merchantId, t.occurredAt)
      .where(sql`${t.merchantId} is not null`),
    // The retention sweep's leading btree — `findUnsupportedExpiryColumns`
    // checks this against the real catalogue, since a later migration dropping
    // it would turn every sweep into a full scan with nothing to notice.
    index('analytics_events_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * `analytics_search_queries` — what was searched for, with NO actor column.
 *
 * ## The separation is the privacy control, and it is structural
 *
 * Privacy rule 3 asks for normalized tokens kept apart from identity. A
 * nullable `actor` column with a rule about when to populate it would be a
 * rule; a table with no such column is a fact. Nothing here can be joined to a
 * person: `query_event_id` correlates to `analytics_events`, and that row is
 * where the (pseudonymous) actor lives, behind the operator allow-list and an
 * audited trace. A merchant-facing query report reads THIS table and
 * `analytics_query_aggregates`, and has nothing to join identity by.
 *
 * ## Raw query text is never retained — only the redacted form, and briefly
 *
 * The decision privacy rule 1 asks for: `redacted_text` holds the string AFTER
 * `services/analytics/redact-query.ts` has replaced everything that looked like
 * an email, a phone number, a postal address, a card number, an IBAN or a
 * secret; `redaction_kinds` records WHAT was found, which is an operational
 * fact worth aggregating and is storable without the thing itself. At
 * `text_expires_at` (30 days) the text is nulled and the normalized tokens
 * survive alone; at `expires_at` the row goes.
 *
 * There is deliberately no foreign key to `analytics_events` in either
 * direction: the two tables are swept on independent clocks (a query record
 * outlives the discovery events derived from it, so latency and zero-result
 * history survive a shorter discovery retention), and a constraint would make
 * one sweep's success depend on the other's order.
 */
export const analyticsSearchQueries = pgTable(
  'analytics_search_queries',
  {
    id: generatedId(),
    /** The correlation handle every derived event carries. Unique — one per search. */
    queryEventId: text().notNull(),
    /** Redacted, never raw. NULL after `text_expires_at` or when fully redacted. */
    redactedText: text(),
    /** Bounded codes for what the redaction pass found. Never the values. */
    redactionKinds: text().array().notNull().default(sql`'{}'::text[]`),
    /** Stemmed, lower-cased tokens. The aggregate unit; outlives the text. */
    normalizedTokens: text().array().notNull().default(sql`'{}'::text[]`),
    /** How many rows came back. Zero IS the zero-result fact. */
    resultCount: integer().notNull(),
    /**
     * Rows on the page whose canonical product repeats an earlier row — the
     * duplicate-product-rate numerator, computed at query time because it is a
     * property of the page that was served and cannot be re-derived later.
     */
    duplicateResultCount: integer().notNull().default(0),
    /** Server-side duration. Not what the shopper waited. */
    latencyMs: integer().notNull(),
    /** ISO 3166-1 alpha-2, when known. */
    market: text(),
    /** The category filter in force, when there was one. */
    categoryId: text(),
    searchPolicyVersion: text(),
    rankingPolicyVersion: text(),
    /** So bot traffic can be excluded from every query report. */
    trafficClass: text({ enum: asEnumValues(ANALYTICS_TRAFFIC_CLASSES) }).notNull(),
    createdAt: createdAt(),
    /** When `redacted_text` must be nulled, leaving the tokens. */
    textExpiresAt: timestamptz().notNull(),
    /** When the row itself must go. */
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    // One record per search. The unique is what lets a derived event's
    // `query_event_id` be trusted as a key rather than a hint.
    uniqueIndex('analytics_search_queries_query_event_id_key').on(t.queryEventId),
    checkOneOf(
      'analytics_search_queries_traffic_class_check',
      t.trafficClass,
      ANALYTICS_TRAFFIC_CLASSES,
    ),
    checkEveryElementOf(
      'analytics_search_queries_redaction_kinds_check',
      t.redactionKinds,
      ANALYTICS_QUERY_REDACTION_KINDS,
    ),
    check(
      'analytics_search_queries_counts_check',
      sql`${t.resultCount} >= 0
          and ${t.duplicateResultCount} >= 0
          and ${t.duplicateResultCount} <= ${t.resultCount}
          and ${t.latencyMs} >= 0`,
    ),
    check(
      'analytics_search_queries_market_check',
      sql`${t.market} is null or ${t.market} ~ '^[A-Z]{2}$'`,
    ),
    // The text deadline must not outlive the row's, or the nulling sweep would
    // have a window in which it can never run.
    check(
      'analytics_search_queries_retention_order_check',
      sql`${t.textExpiresAt} <= ${t.expiresAt}`,
    ),
    // The two sweeps' leading btrees.
    index('analytics_search_queries_text_expires_at_idx').on(t.textExpiresAt),
    index('analytics_search_queries_expires_at_idx').on(t.expiresAt),
    // The aggregation pass.
    index('analytics_search_queries_created_at_idx').on(t.createdAt),
  ],
);

/**
 * `analytics_query_aggregates` — the ONLY surface any query report reads.
 *
 * One row per (bucket day, market, normalized query). Written by the rollup
 * BEFORE the raw query rows are swept, which is data-lifecycle rule 2
 * ("aggregate before deleting raw events where appropriate") in the one place
 * it genuinely applies: a top-queries report must survive the text it was
 * derived from.
 *
 * The minimum-count threshold (privacy rules 4 and 5) is applied by
 * `db/analytics/queryAggregateRepository.ts` on every read, and there is
 * deliberately no second accessor — an operator who needs a specific
 * low-frequency query uses the audited trace by id, not a report.
 */
export const analyticsQueryAggregates = pgTable(
  'analytics_query_aggregates',
  {
    id: generatedId(),
    /** The UTC calendar day. */
    bucketDate: date({ mode: 'string' }).notNull(),
    /**
     * `''` for "no market recorded" — a real bucket, not a missing one.
     *
     * NOT NULL with NO DEFAULT, deliberately. A NULLable dimension would break
     * the bucket unique outright (Postgres treats NULLs as distinct, so two
     * rows with identical non-null columns and NULL here would both be
     * admitted — the `commerce_relationships.endpoint_key` problem), and a
     * `DEFAULT ''` is the convention violation `CONVENTIONS.md` refuses. With
     * neither, every writer must state which bucket it means.
     */
    market: text().notNull(),
    /** The normalized token sequence, joined by a single space. */
    normalizedQuery: text().notNull(),
    occurrences: integer().notNull().default(0),
    zeroResultOccurrences: integer().notNull().default(0),
    clickOccurrences: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Aggregates outlive their raw rows; they still expire. */
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    // The rollup is idempotent on this key: a replayed page recomputes the same
    // bucket and overwrites it, rather than adding to it. Counting UP from a
    // partial page would double a number a resumed sweep re-read.
    uniqueIndex('analytics_query_aggregates_bucket_key').on(
      t.bucketDate,
      t.market,
      t.normalizedQuery,
    ),
    check(
      'analytics_query_aggregates_counts_check',
      sql`${t.occurrences} >= 0
          and ${t.zeroResultOccurrences} >= 0
          and ${t.clickOccurrences} >= 0
          and ${t.zeroResultOccurrences} <= ${t.occurrences}`,
    ),
    check(
      'analytics_query_aggregates_market_check',
      sql`${t.market} = '' or ${t.market} ~ '^[A-Z]{2}$'`,
    ),
    // The thresholded report's own scan: "the top queries of this day in this
    // market, above the floor".
    index('analytics_query_aggregates_report_idx').on(t.bucketDate, t.market, t.occurrences),
    index('analytics_query_aggregates_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * `analytics_rollups` — one metric, one day, one dimension tuple.
 *
 * Numerator and denominator are stored SEPARATELY and the ratio is never
 * stored: two rollup rows can be added, two ratios cannot, and a dashboard that
 * sums a week has to add the parts. `denominator = 0` is a real, storable
 * state and reads as `null` rather than as zero — a metric with nothing
 * underneath it has no value, and rendering 0% for "nobody searched" is the
 * single most common way a dashboard lies.
 *
 * `source` is copied from the metric definition onto the row on purpose,
 * unlike a `schedule_key` snapshot: it makes "which of these numbers came from
 * the payment rail" answerable by a query rather than by cross-referencing
 * code, which is what identity rule 8 needs to be auditable.
 */
export const analyticsRollups = pgTable(
  'analytics_rollups',
  {
    id: generatedId(),
    metricKey: text().notNull(),
    /** The UTC calendar day the bucket covers. */
    bucketDate: date({ mode: 'string' }).notNull(),
    /**
     * `''` means "not sliced by this dimension" — a real bucket, not a NULL.
     *
     * All six are NOT NULL with NO DEFAULT, for the two reasons
     * `analytics_query_aggregates.market` states: a NULLable dimension would
     * break the bucket unique (Postgres treats NULLs as distinct), and a
     * `DEFAULT ''` is the convention violation `CONVENTIONS.md` refuses. The
     * rollup names every dimension on every write, which is also what makes an
     * accidentally-unsliced bucket visible in review rather than defaulted into
     * existence.
     */
    market: text().notNull(),
    clientSurface: text().notNull(),
    actorKind: text().notNull(),
    buyerOrigin: text().notNull(),
    storeId: text().notNull(),
    merchantId: text().notNull(),
    numerator: integer().notNull().default(0),
    denominator: integer().notNull().default(0),
    /** Where this figure came from — the metric definition's own `source`. */
    source: text({ enum: asEnumValues(ANALYTICS_METRIC_SOURCES) }).notNull(),
    /** When the rollup ran. Rendered beside the value, per acceptance 6. */
    computedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    // Idempotency: recomputing a bucket OVERWRITES it. A resumed sweep that
    // re-reads a page must converge, and an increment would not.
    uniqueIndex('analytics_rollups_bucket_key').on(
      t.metricKey,
      t.bucketDate,
      t.market,
      t.clientSurface,
      t.actorKind,
      t.buyerOrigin,
      t.storeId,
      t.merchantId,
    ),
    // The metric key is CHECKed against the registry so a rollup can never be
    // written for a metric no definition explains — which is acceptance 6 from
    // the storage side: a dashboard cannot find a number whose definition is
    // absent, because the number could not be stored.
    checkOneOf('analytics_rollups_metric_key_check', t.metricKey, ANALYTICS_METRIC_KEYS),
    checkOneOf('analytics_rollups_source_check', t.source, ANALYTICS_METRIC_SOURCES),
    check(
      'analytics_rollups_counts_check',
      sql`${t.numerator} >= 0 and ${t.denominator} >= 0`,
    ),
    index('analytics_rollups_metric_bucket_idx').on(t.metricKey, t.bucketDate),
    index('analytics_rollups_store_idx')
      .on(t.storeId, t.metricKey, t.bucketDate)
      .where(sql`${t.storeId} <> ''`),
    index('analytics_rollups_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * `analytics_experiments` — one immutable VERSION of one experiment.
 *
 * The `fee_schedules` shape, for the same reason: an experiment whose
 * hypothesis, primary metric or guardrails can be edited while it runs is an
 * experiment whose result cannot be trusted. A trigger freezes every field once
 * the row leaves `draft`; a policy change is a NEW version.
 *
 * Experimentation rules 3, 5 and 9 are enforced by the TREATMENT KIND
 * vocabulary rather than here — `ANALYTICS_EXPERIMENT_TREATMENT_KINDS` has no
 * member that could mean "hide Continue as guest", "auto-create an account",
 * "preselect marketing consent" or "sell organic rank", so an experiment has
 * nothing to declare that would do any of them. This table's job is to make the
 * declaration immutable and the stop conditions stated in advance.
 */
export const analyticsExperiments = pgTable(
  'analytics_experiments',
  {
    id: generatedId(),
    /** The stable grouping token across versions (the `program_id` shape). */
    experimentKey: text().notNull(),
    version: integer().notNull(),
    status: text({ enum: asEnumValues(ANALYTICS_EXPERIMENT_STATUSES) }).notNull(),
    treatmentKind: text({ enum: asEnumValues(ANALYTICS_EXPERIMENT_TREATMENT_KINDS) }).notNull(),
    /** What this version claims. Frozen with the rest at activation. */
    hypothesis: text().notNull(),
    /** The one metric the decision rests on. */
    primaryMetricKey: text().notNull(),
    /** The metrics that can stop it regardless of the primary. */
    guardrailMetricKeys: text().array().notNull().default(sql`'{}'::text[]`),
    /** Declared in advance, so nobody has to invent one under pressure. */
    stopConditions: text().array().notNull().default(sql`'{}'::text[]`),
    /** What assignment is keyed on — never contact or payment identity. */
    assignmentUnit: text({
      enum: asEnumValues(ANALYTICS_EXPERIMENT_ASSIGNMENT_UNITS),
    }).notNull(),
    /**
     * The per-experiment hash salt. Public in the sense that it is not a
     * credential — it exists so two experiments do not bucket the same unit
     * identically, which would confound them.
     */
    assignmentSalt: text().notNull(),
    /** The variant names, `control` first by convention. */
    variants: text().array().notNull(),
    /** How much traffic is in the test, in basis points of 10,000 buckets. */
    trafficAllocationBps: integer().notNull(),
    /** The #74 ranking policy version this arm records, when it has one. */
    rankingPolicyVersion: text(),
    activatedAt: timestamptz(),
    stoppedAt: timestamptz(),
    stopReason: text({ enum: asEnumValues(ANALYTICS_EXPERIMENT_STOP_CONDITIONS) }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('analytics_experiments_key_version_key').on(t.experimentKey, t.version),
    // Exactly ONE live version per experiment. A partial unique rather than a
    // service check, because two operators activating two versions at once is
    // precisely the race a read-then-write walks past.
    uniqueIndex('analytics_experiments_active_key')
      .on(t.experimentKey)
      .where(sql`${t.status} = 'active'`),
    checkOneOf('analytics_experiments_status_check', t.status, ANALYTICS_EXPERIMENT_STATUSES),
    checkOneOf(
      'analytics_experiments_treatment_kind_check',
      t.treatmentKind,
      ANALYTICS_EXPERIMENT_TREATMENT_KINDS,
    ),
    checkOneOf(
      'analytics_experiments_assignment_unit_check',
      t.assignmentUnit,
      ANALYTICS_EXPERIMENT_ASSIGNMENT_UNITS,
    ),
    checkOneOf(
      'analytics_experiments_primary_metric_check',
      t.primaryMetricKey,
      ANALYTICS_METRIC_KEYS,
    ),
    checkEveryElementOf(
      'analytics_experiments_guardrails_check',
      t.guardrailMetricKeys,
      ANALYTICS_METRIC_KEYS,
    ),
    checkEveryElementOf(
      'analytics_experiments_stop_conditions_check',
      t.stopConditions,
      ANALYTICS_EXPERIMENT_STOP_CONDITIONS,
    ),
    checkOneOf(
      'analytics_experiments_stop_reason_check',
      t.stopReason,
      ANALYTICS_EXPERIMENT_STOP_CONDITIONS,
    ),
    check(
      'analytics_experiments_version_check',
      sql`${t.version} >= 1 and ${t.trafficAllocationBps} between 0 and 10000`,
    ),
    // At least two arms and at least one guardrail. An experiment with one arm
    // is a rollout wearing an experiment's clothes, and one with no guardrail
    // has no stop condition anybody is watching (rule 6).
    //
    // `coalesce(array_length(…), 0)` is load-bearing and is NOT defensive
    // spelling: `array_length` returns NULL for an EMPTY array, a CHECK that
    // evaluates to NULL is SATISFIED, and an empty guardrail list is exactly
    // the input this constraint exists to refuse. Written the obvious way, the
    // check would admit the one row it was written for and refuse only the
    // near-misses. Measured, not assumed — the realdb case fails on the naive
    // form.
    check(
      'analytics_experiments_shape_check',
      sql`coalesce(array_length(${t.variants}, 1), 0) >= 2
          and coalesce(array_length(${t.guardrailMetricKeys}, 1), 0) >= 1
          and coalesce(array_length(${t.stopConditions}, 1), 0) >= 1`,
    ),
    // A stopped version says when and why; a running one says neither.
    check(
      'analytics_experiments_stopped_check',
      sql`(${t.status} in ('stopped', 'completed')) = (${t.stoppedAt} is not null)
          and (${t.stopReason} is null or ${t.stoppedAt} is not null)`,
    ),
    // Only a draft has never been activated.
    check(
      'analytics_experiments_activated_check',
      sql`(${t.status} = 'draft') = (${t.activatedAt} is null)`,
    ),
  ],
);

/**
 * `analytics_experiment_exposures` — that a unit was actually SHOWN an arm.
 *
 * Assignment is a pure function (`services/analytics/experiments.ts`), so it
 * needs no storage; exposure is an observation and does. The pair is the
 * standard shape and the reason for it is worth stating: an experiment analysed
 * over ASSIGNED units includes everyone the hash touched, most of whom never
 * reached the surface under test, which dilutes every effect toward zero.
 *
 * `assignment_unit_ref` is either an Oxy user id or a pseudonymous session id —
 * and for a guest that means exposure continuity ENDS at each salt rotation, so
 * a long test sees one person as several units. That is the privacy decision
 * winning over the analytic one, deliberately; the metric registry says so in
 * `saved_intent_return_rate`'s attribution limit, and an experiment that needs
 * more continuity than that must run on `oxy_user`.
 */
export const analyticsExperimentExposures = pgTable(
  'analytics_experiment_exposures',
  {
    id: generatedId(),
    experimentKey: text().notNull(),
    experimentVersion: integer().notNull(),
    /** An Oxy id or a rotating pseudonym — never contact or payment identity. */
    assignmentUnitRef: text().notNull(),
    assignmentUnit: text({
      enum: asEnumValues(ANALYTICS_EXPERIMENT_ASSIGNMENT_UNITS),
    }).notNull(),
    variant: text().notNull(),
    firstExposedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    // First exposure only. A repeat converges on the existing row (the
    // moderation-event claim shape) rather than counting a second unit.
    uniqueIndex('analytics_experiment_exposures_unit_key').on(
      t.experimentKey,
      t.experimentVersion,
      t.assignmentUnitRef,
    ),
    checkOneOf(
      'analytics_experiment_exposures_assignment_unit_check',
      t.assignmentUnit,
      ANALYTICS_EXPERIMENT_ASSIGNMENT_UNITS,
    ),
    index('analytics_experiment_exposures_experiment_idx').on(
      t.experimentKey,
      t.experimentVersion,
      t.firstExposedAt,
    ),
    index('analytics_experiment_exposures_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * `analytics_pseudonym_salts` — the rotating secret every pseudonymous session
 * id is derived under.
 *
 * ## Why the rotation is the privacy mechanism and not a hygiene habit
 *
 * A pseudonymous id derived under a FIXED salt is a stable identifier for as
 * long as the salt lives — which is to say, a person. Rotating it on a schedule
 * (data-lifecycle rule 7) bounds how long any pre-purchase identifier can link
 * activity, and DELETING the retired salt is what makes that bound real: after
 * the sweep, nobody — including Mercaria, including a subpoena — can recompute
 * an old epoch's hash from a session handle, so two epochs cannot be joined
 * even in principle.
 *
 * `salt` is in `PROTECTED_COLUMNS`: it is a live secret, and a whole-row read
 * anywhere would hand out the ability to re-derive every pseudonym of the
 * current epoch.
 *
 * The row also carries `expires_at` and is registered in `db/expiryTargets.ts`,
 * so the deletion is the SAME mechanism every other retention uses rather than
 * a bespoke job somebody has to remember to schedule.
 */
export const analyticsPseudonymSalts = pgTable(
  'analytics_pseudonym_salts',
  {
    id: generatedId(),
    /** Monotonic. Stored on every event, so a hash names the salt that made it. */
    epoch: integer().notNull(),
    /** A live secret. Read only by the derivation; never leaves the process. */
    salt: text().notNull(),
    activeFrom: timestamptz().notNull(),
    /** NULL while this is the current epoch. */
    activeUntil: timestamptz(),
    createdAt: createdAt(),
    /**
     * When the salt is DELETED — deliberately sooner than the events derived
     * under it expire. After this the hashes are permanently unlinkable to any
     * session handle, which is the property the rotation exists to create.
     */
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    uniqueIndex('analytics_pseudonym_salts_epoch_key').on(t.epoch),
    // At most one CURRENT epoch. The derivation reads it on every request, so
    // two would silently split one session across two pseudonyms.
    uniqueIndex('analytics_pseudonym_salts_current_key')
      .on(t.activeUntil)
      .where(sql`${t.activeUntil} is null`),
    check('analytics_pseudonym_salts_epoch_check', sql`${t.epoch} >= 1`),
    check(
      'analytics_pseudonym_salts_window_check',
      sql`${t.activeUntil} is null or ${t.activeUntil} > ${t.activeFrom}`,
    ),
    index('analytics_pseudonym_salts_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * `analytics_rollup_cursors` — the lease and resume point for the rollup and
 * retention sweeps.
 *
 * The `reconciliation_cursors` shape, one domain over: bounded (one bucket per
 * tick), resumable (the cursor moves only after a bucket is fully written) and
 * idempotent (every write is an upsert on the bucket key). It runs on EVERY
 * task with a `FOR UPDATE SKIP LOCKED` claim, so N tasks share the work and a
 * dead task's lease is reclaimed — a leader election would be a second
 * coordination mechanism to get wrong for no property this does not already
 * have.
 */
export const analyticsRollupCursors = pgTable(
  'analytics_rollup_cursors',
  {
    /** The job name. Caller-supplied, so there is exactly one row per job. */
    id: text().primaryKey(),
    /** The last UTC day fully rolled up. The next tick starts after it. */
    lastCompletedDate: date({ mode: 'string' }),
    leaseOwner: text(),
    leaseExpiresAt: timestamptz(),
    lastRunAt: timestamptz(),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A lease is a pair: an owner with no deadline can never be reclaimed, and a
    // deadline with no owner names nobody.
    check(
      'analytics_rollup_cursors_lease_check',
      sql`num_nonnulls(${t.leaseOwner}, ${t.leaseExpiresAt}) in (0, 2)`,
    ),
  ],
);

/** A row of {@link analyticsEvents}, as drizzle returns it. */
export type AnalyticsEventRow = typeof analyticsEvents.$inferSelect;

/** A row of {@link analyticsSearchQueries}. */
export type AnalyticsSearchQueryRow = typeof analyticsSearchQueries.$inferSelect;

/** A row of {@link analyticsExperiments}. */
export type AnalyticsExperimentRow = typeof analyticsExperiments.$inferSelect;

/** A row of {@link analyticsPseudonymSalts}. */
export type AnalyticsPseudonymSaltRow = typeof analyticsPseudonymSalts.$inferSelect;

/** A row of {@link analyticsRollups}. */
export type AnalyticsRollupRow = typeof analyticsRollups.$inferSelect;

/** A row of {@link analyticsRollupCursors}. */
export type AnalyticsRollupCursorRow = typeof analyticsRollupCursors.$inferSelect;

/** A row of {@link analyticsExperimentExposures}. */
export type AnalyticsExperimentExposureRow = typeof analyticsExperimentExposures.$inferSelect;

/** A row of {@link analyticsQueryAggregates}. */
export type AnalyticsQueryAggregateRow = typeof analyticsQueryAggregates.$inferSelect;
