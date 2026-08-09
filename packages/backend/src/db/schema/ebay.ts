/**
 * The eBay Browse catalog source's own tables — issue #65:
 * `ebay_call_budgets`, `ebay_discovery_queries`, `ebay_reconciliation_samples`.
 *
 * #62 forbids an adapter forking the framework's schema and #65 does not: not
 * one column here describes an observation, an offer, a match or a rights
 * policy, and nothing in this file is read by any pipeline stage. What it
 * carries is the three things eBay's own contract demands that no
 * provider-neutral framework could have anticipated.
 *
 * ## 1. A quota is a property of the APPLICATION, not of a source
 *
 * eBay meters 5,000 calls per day against the KEYSET, and Mercaria configures
 * one `catalog_sources` row per marketplace — five of them at the launch set.
 * A budget keyed on the source would let each of the five spend the whole
 * allowance, so the fleet would draw 25,000 calls against a 5,000-call
 * agreement and eBay would start refusing at breakfast. `ebay_call_budgets` is
 * therefore keyed on the CREDENTIAL and the UTC day, and the reservation is one
 * conditional `UPDATE`, which is what makes the bound exact across every ECS
 * task rather than per process.
 *
 * ## 2. eBay publishes no catalogue, so the catalogue is a list of QUERIES
 *
 * The Browse API grants search-driven discovery and nothing else. An eBay
 * marketplace's "catalogue" inside Mercaria is exactly the union of the queries
 * an operator configured, and `ebay_discovery_queries` is that list. It is a
 * table rather than an environment variable because it is the ROLLOUT COHORT
 * issue #65 acceptance 7 asks for — a bounded category set an operator widens
 * one row at a time, with the evidence of what each sweep returned beside it.
 *
 * ## 3. Reconciliation needs somewhere to disagree
 *
 * `ebay_reconciliation_samples` records what a live re-read of a representative
 * sample said, beside what Mercaria was serving. It repairs nothing — the
 * `payment_discrepancies` posture, for the same reason: a stale price is fixed
 * by a refresh that already exists, and a row that quietly corrected itself
 * would destroy the only evidence that the cadence is too slow.
 *
 * ## What is deliberately NOT here
 *
 * - **No token, in any column, on any table.** An eBay client-credentials token
 *   is minted per process, held in memory and never written down — see
 *   `services/ebay/token.ts`. A `credential_ref` locator is the most this domain
 *   ever holds and it lives on `catalog_source_configs`, where #62 put it.
 * - **No item payload.** eBay content is stored exactly once, in
 *   `source_records.payload`, under #62's allow-list and its `may_store` right.
 *   A second copy here would be a second retention clock for data whose
 *   deletion obligation is contractual.
 * - **No merchant, offer or canonical id.** Reconciliation names an EXTERNAL
 *   id, because its subject is what eBay says, and joining it to the graph is
 *   the reader's job.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  EBAY_DISCOVERY_QUERY_KINDS,
  EBAY_MARKETPLACE_IDS,
  EBAY_RECONCILIATION_FINDINGS,
  EBAY_SEARCH_MAX_OFFSET,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { catalogSources } from './provenance';

/** Bound on any stored note or provider detail in this domain. */
export const EBAY_MAX_TEXT_LENGTH = 2_000;

/**
 * `ebay_call_budgets` — one row per application keyset per UTC day.
 *
 * ### The reservation is a conditional UPDATE, and that is the whole mechanism
 *
 * `update … set calls_used = calls_used + $n where calls_used + $n <= daily_limit
 * returning` either grants the whole reservation or grants nothing, in one
 * statement, under the row lock Postgres takes anyway. N tasks racing produce N
 * serialized updates and the sum can never pass `daily_limit` — where a counter
 * in each process would bound each process and nothing else. That is issue #65
 * reliability 1, and it is the reason this is a table rather than a Redis
 * counter: Redis is optional in this deployment, and a quota that silently
 * stops bounding when a cache is absent is worse than none, because nobody
 * notices until the provider does.
 *
 * ### `application_key` is a DIGEST of the credential locator
 *
 * Not of the credential — `catalog_source_configs.credential_ref` is a locator
 * (`env:EBAY_CLIENT_ID`), never a secret, and #62 says so. The digest is here
 * for a duller reason: it is fixed-width, so the unique index is bounded
 * whatever an operator types, and two sources sharing one keyset collapse onto
 * one row by construction rather than by string equality on a value somebody
 * might write two ways.
 *
 * ### The day is a DATE in UTC, because eBay's is
 *
 * A rolling window would be kinder to a bursty crawler and would not be the
 * agreement. eBay resets at midnight UTC; a budget on any other clock is a
 * budget that disagrees with the one being enforced, in the direction that gets
 * an application throttled.
 */
export const ebayCallBudgets = pgTable(
  'ebay_call_budgets',
  {
    id: generatedId(),
    /** sha-256 hex of the credential LOCATOR — see the docblock. */
    applicationKey: text().notNull(),
    /** The UTC day this allowance belongs to. */
    budgetDate: date().notNull(),
    /**
     * The allowance this day was measured against.
     *
     * Stored per day rather than read from configuration at report time,
     * because the application growth check really does raise it: a run refused
     * against 5,000 stays refused against 5,000 in the evidence even after the
     * limit becomes 25,000, which is what makes "we were throttled on the 9th"
     * answerable a month later.
     */
    dailyLimit: integer().notNull(),
    /** Calls RESERVED today. Never decremented — a spent call is spent. */
    callsUsed: integer().notNull().default(0),
    /**
     * Reservations the budget REFUSED.
     *
     * The other half of the vacuity floor: `calls_used` alone cannot tell a
     * quiet day from a day the budget spent hours refusing everything, and
     * those need opposite responses (leave it alone; file a growth check).
     */
    callsRefused: integer().notNull().default(0),
    lastCallAt: timestamptz(),
    lastRefusedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('ebay_call_budgets_application_key_check', sql`${t.applicationKey} ~ '^[0-9a-f]{64}$'`),
    check('ebay_call_budgets_daily_limit_check', sql`${t.dailyLimit} > 0`),
    check('ebay_call_budgets_calls_used_check', sql`${t.callsUsed} >= 0`),
    check('ebay_call_budgets_calls_refused_check', sql`${t.callsRefused} >= 0`),
    /**
     * The ceiling as a CHECK as well as a predicate.
     *
     * The conditional UPDATE is what enforces the bound in the ordinary path;
     * this is what enforces it against a replay, a repair somebody types during
     * an incident, and a future writer that forgets the predicate. Two spellings
     * of one rule are exactly what this repo distrusts, and the resolution here
     * is that neither is a SECOND source of truth: the CHECK cannot grant, and
     * the predicate cannot exceed it.
     */
    check('ebay_call_budgets_within_limit_check', sql`${t.callsUsed} <= ${t.dailyLimit}`),
    uniqueIndex('ebay_call_budgets_application_key_budget_date_key').on(
      t.applicationKey,
      t.budgetDate,
    ),
    index('ebay_call_budgets_budget_date_idx').on(t.budgetDate.desc()),
  ],
);

/**
 * `ebay_discovery_queries` — the bounded cohort one source discovers through.
 *
 * ### `max_offset` exists because eBay's paging has a hard floor under it
 *
 * `search` refuses an `offset` beyond 10,000, so no query can ever enumerate
 * more than that many items whatever cadence it runs at. The column bounds a
 * query BELOW eBay's ceiling — a category worth 10,000 items on every sweep is
 * a category that never gets past its own first page of newly-listed stock —
 * and the CHECK against `EBAY_SEARCH_MAX_OFFSET` is what stops an operator
 * configuring a depth the provider will answer with an error.
 *
 * This is also the single most important reason a discovery sweep may NEVER
 * report a complete enumeration: the provider states, in an error code, that
 * you have not seen everything.
 *
 * ### The checkpoint is a RESULT, not a cursor
 *
 * `last_completed_at` and `last_item_count` say what the previous sweep of this
 * query found. They are evidence, and the resumption cursor is the run's own
 * (`catalog_source_runs.cursor`, #62's) — one place, so a query enabled
 * mid-run cannot rewind a pass that is already in flight.
 */
export const ebayDiscoveryQueries = pgTable(
  'ebay_discovery_queries',
  {
    id: generatedId(),
    /**
     * The source this query discovers for. RESTRICT, like every other reference
     * to the provenance registry: nothing deletes a `catalog_sources` row.
     */
    sourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    marketplaceId: text({ enum: asEnumValues(EBAY_MARKETPLACE_IDS) }).notNull(),
    queryKind: text({ enum: asEnumValues(EBAY_DISCOVERY_QUERY_KINDS) }).notNull(),
    /** A category id for `category`, a search phrase for `keyword`. */
    queryValue: text().notNull(),
    /**
     * Where this query sits in the sweep order.
     *
     * A run walks the queries in a TOTAL order so its cursor means the same
     * thing on the retry as it did on the attempt. Ordering on `created_at`
     * would reorder the moment two rows shared a millisecond — the uuid v7
     * finding in `~/Oxy/AGENTS.md`, one domain over — so the order is a column
     * an operator sets.
     */
    position: integer().notNull().default(0),
    /**
     * Whether the sweep visits it. Disabling is the per-COHORT rollout lever
     * (#65 acceptance 7); it never deletes the row, so re-enabling restores the
     * evidence of what the query used to return.
     */
    enabled: boolean().notNull().default(true),
    /** How deep this query may page. Bounded below eBay's own ceiling. */
    maxOffset: integer().notNull().default(1_000),
    lastCompletedAt: timestamptz(),
    /** How many records the last completed sweep of this query produced. */
    lastItemCount: integer(),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    createdByOxyUserId: text(),
    note: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('ebay_discovery_queries_marketplace_id_check', t.marketplaceId, EBAY_MARKETPLACE_IDS),
    checkOneOf('ebay_discovery_queries_query_kind_check', t.queryKind, EBAY_DISCOVERY_QUERY_KINDS),
    check(
      'ebay_discovery_queries_query_value_check',
      sql`length(btrim(${t.queryValue})) between 1 and 200`,
    ),
    check('ebay_discovery_queries_position_check', sql`${t.position} >= 0`),
    // `sql.raw`, never interpolation: a constant bound into a schema CHECK is
    // written into the generated migration as a `$1` placeholder, and DDL
    // cannot carry a parameter — it generates cleanly and fails at APPLY time
    // (`~/Oxy/AGENTS.md`, the drizzle `sql`-template traps).
    check(
      'ebay_discovery_queries_max_offset_check',
      sql.raw(`"max_offset" > 0 and "max_offset" <= ${EBAY_SEARCH_MAX_OFFSET}`),
    ),
    check('ebay_discovery_queries_last_item_count_check', sql`${t.lastItemCount} >= 0`),
    check(
      'ebay_discovery_queries_note_length_check',
      sql.raw(`"note" is null or length("note") <= ${EBAY_MAX_TEXT_LENGTH}`),
    ),
    // One row per (source, marketplace, kind, value): re-adding a query an
    // operator already configured converges rather than sweeping it twice.
    uniqueIndex('ebay_discovery_queries_source_marketplace_kind_value_key').on(
      t.sourceId,
      t.marketplaceId,
      t.queryKind,
      t.queryValue,
    ),
    // The sweep order, which is also the operator listing order.
    index('ebay_discovery_queries_source_id_position_idx').on(t.sourceId, t.position, t.id),
  ],
);

/**
 * `ebay_reconciliation_samples` — what a live re-read said, beside what Mercaria
 * was serving (#65 reliability 7).
 *
 * One row per sampled item per check, append-only in practice and swept on its
 * own retention clock. `finding` is the verdict and the money columns are the
 * evidence for it; both are kept, because "price drift" without the two numbers
 * is a claim nobody can act on and the two numbers without a verdict is a
 * spreadsheet.
 *
 * The stored and provider prices carry SHAPE-checked currency columns rather
 * than the presentment tuple — the `offers.price_currency` exemption class, for
 * its reason: eBay trades in whatever it trades in, and refusing a sample over
 * a currency Mercaria does not present would break the observation rather than
 * the price.
 */
export const ebayReconciliationSamples = pgTable(
  'ebay_reconciliation_samples',
  {
    id: generatedId(),
    sourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    /** eBay's own item id. A foreign key space — ledgered, never a Mercaria key. */
    externalId: text().notNull(),
    finding: text({ enum: asEnumValues(EBAY_RECONCILIATION_FINDINGS) }).notNull(),
    checkedAt: timestamptz().notNull(),
    /** What Mercaria was serving, when it was serving one. */
    storedPriceAmount: integer(),
    storedPriceCurrency: text(),
    storedAvailability: text(),
    storedCondition: text(),
    /** What the provider said at `checked_at`. */
    providerPriceAmount: integer(),
    providerPriceCurrency: text(),
    providerAvailability: text(),
    providerCondition: text(),
    /**
     * Whether the live re-read carried an affiliate destination.
     *
     * NULL when attribution was not requested at all (no campaign id
     * configured), false when it was requested and eBay answered without one —
     * which is the ONLY signal that EPN approval or the campaign id has lapsed,
     * because an unattributed link is a working link and fails nowhere else.
     */
    providerAffiliateUrlPresent: boolean(),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('ebay_reconciliation_samples_finding_check', t.finding, EBAY_RECONCILIATION_FINDINGS),
    check(
      'ebay_reconciliation_samples_external_id_check',
      sql`length(btrim(${t.externalId})) between 1 and 128`,
    ),
    // The `offers` shape-check exemption class, both sides.
    check(
      'ebay_reconciliation_samples_stored_currency_check',
      sql`${t.storedPriceCurrency} is null or ${t.storedPriceCurrency} ~ '^[A-Z]{3,4}$'`,
    ),
    check(
      'ebay_reconciliation_samples_provider_currency_check',
      sql`${t.providerPriceCurrency} is null or ${t.providerPriceCurrency} ~ '^[A-Z]{3,4}$'`,
    ),
    // A half money pair states nothing — `offers_price_paired_check`'s rule,
    // applied to both sides of the comparison.
    check(
      'ebay_reconciliation_samples_stored_price_paired_check',
      sql`(${t.storedPriceAmount} is null) = (${t.storedPriceCurrency} is null)`,
    ),
    check(
      'ebay_reconciliation_samples_provider_price_paired_check',
      sql`(${t.providerPriceAmount} is null) = (${t.providerPriceCurrency} is null)`,
    ),
    check(
      'ebay_reconciliation_samples_note_length_check',
      sql.raw(`"note" is null or length("note") <= ${EBAY_MAX_TEXT_LENGTH}`),
    ),
    // The operator read: this source's findings, newest first.
    index('ebay_reconciliation_samples_source_id_checked_at_idx').on(
      t.sourceId,
      t.checkedAt.desc(),
    ),
    // The retention sweep, and the "has this item drifted before" trace.
    index('ebay_reconciliation_samples_source_id_external_id_idx').on(t.sourceId, t.externalId),
  ],
);
