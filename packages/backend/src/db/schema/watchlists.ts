/**
 * Private watchlists (#81): `watchlists`, `watchlist_items`,
 * `watchlist_snapshots`, `watchlist_snapshot_items`.
 *
 * `product_saves` (#80) is one account's standing interest in ONE canonical
 * product and stays exactly where it is. What #81 adds is a GROUPING with a
 * purpose — a PC build, a nursery, a kitchen restock — plus the bounded,
 * reproducible record of what that group cost at the moments it was evaluated.
 * A watchlist is never a second answer to "did this buyer save this product":
 * nothing here writes, reads or derives a save, a save counter or a save
 * aggregate, and `watchlist-isolation.test.ts` fails the build if it starts to.
 *
 * ## The six properties this file makes STRUCTURAL rather than conventional
 *
 * 1. **One entry per product per list.**
 *    `watchlist_items_watchlist_id_canonical_product_id_key` is what makes an
 *    add idempotent under a double tap, and it is what a product MERGE converges
 *    on: the rehoming is `repoint_if_absent` guarded on `watchlist_id`, exactly
 *    #80's device, so a list holding both sides of a merge keeps the loser-side
 *    row on the tombstone rather than violating the unique — and the read
 *    reports it as `product_merged_into_existing_item` so the buyer can remove
 *    it, instead of the basket counting one product twice.
 * 2. **A split cannot silently pick a child.**
 *    `watchlist_items_ambiguity_check` is #80's biconditional one domain over:
 *    an ambiguous item NAMES the split job that made it so — which is what makes
 *    the two candidates recoverable — and a resolved one cannot carry a stale
 *    job id a later reader would resurface as an unanswered question.
 * 3. **A snapshot's counters cannot lie about its own rows.**
 *    `watchlist_snapshots_item_counts_check` forces
 *    `item_count = priced_item_count + unresolved_item_count` (equality, never
 *    `<=`) — #60's `catalog_backfill_runs_counters_total_check`, for its reason:
 *    a page that swallowed an item produces the output of a clean run, and the
 *    only way to tell the two apart is to make the arithmetic a constraint.
 *    `insertWatchlistSnapshot` is the single writer and additionally refuses a
 *    header whose counters disagree with the lines it was handed.
 * 4. **A converted amount carries its quote, or it is not stored.** Five FX
 *    columns per converted amount, present EXACTLY when the source currency
 *    differs from the display currency (a biconditional CHECK, #120's device).
 *    A stored price nobody can attribute to a rate is not reproducible, and
 *    reproducibility is the whole of #81 snapshot rule 3.
 * 5. **A snapshot is APPEND-ONLY against UPDATE and DELETE is PERMITTED.** The
 *    inverse of the ledger and the same posture as `analytics_events` and
 *    `offer_price_snapshots`: erasure on a schedule is the retention policy, so
 *    a trigger refusing DELETE would make the shared expiry sweep fail SILENTLY
 *    on every row it was meant to remove. Rewriting one, by contrast, is how a
 *    price history stops being evidence.
 * 6. **A private note never travels.** `watchlist_items.note` is registered in
 *    `PROTECTED_COLUMNS`, so the evaluation — which reads items WHOLE and writes
 *    snapshot rows from them — cannot carry one into a durable table, an
 *    analytics row or any projection that did not name it explicitly. #81
 *    privacy rules 2 and 4.
 *
 * ## What is deliberately NOT here
 *
 * - **No sharing.** No share token, no follower column, no public visibility:
 *   `visibility` is CHECKed against a ONE-member tuple. #81 privacy rule 1
 *   keeps lists private "unless a later explicit sharing feature is built", and
 *   building one is a migration plus a widened tuple plus a privacy review.
 * - **No demand aggregate.** #81 privacy rule 2 bounds what a merchant may
 *   receive; the enforcement here is that there is no aggregate to receive.
 *   Counting how many private lists hold a product is the question
 *   `product_save_aggregates` already answers at a different grain, with a
 *   disclosure floor; a second counter would be a second answer and a second
 *   floor to keep in step.
 * - **No price-alert foreign key.** #79 owns alerts and has not shipped, so
 *   there is no table for a column to reference. `target_amount` is the half
 *   that is representable today and the alert is a named seam in the DTO.
 * - **No `last_total` on the list.** The latest snapshot IS that fact, and a
 *   column beside it is a second representation that goes stale the first time a
 *   snapshot is swept.
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
  ALL_CURRENCY_CODES,
  CONDITION_GROUPS,
  OFFER_AVAILABILITY_STATES,
  MAX_MONEY_MINOR_UNITS,
  WATCHLIST_BASKET_BASES,
  WATCHLIST_BASKET_COMPLETENESS,
  WATCHLIST_ITEM_RESOLUTION_STATES,
  WATCHLIST_ITEM_UNRESOLVED_REASONS,
  WATCHLIST_MAX_DESCRIPTION_LENGTH,
  WATCHLIST_MAX_ICON_LENGTH,
  WATCHLIST_MAX_ITEM_QUANTITY,
  WATCHLIST_MAX_NAME_LENGTH,
  WATCHLIST_MAX_NOTE_LENGTH,
  WATCHLIST_SNAPSHOT_CHANGE_KINDS,
  WATCHLIST_TEMPLATE_KEYS,
  WATCHLIST_VISIBILITIES,
  type WatchlistSnapshotChangeKind,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf, currencyChecks } from './columns';
import { canonicalProducts, canonicalVariants } from './canonicalCatalog';
import { catalogSplitJobs } from './curation';
import { merchants } from './merchants';

/**
 * `watchlists` — one Oxy account's purposeful, private grouping.
 *
 * ## `version` is the optimistic-concurrency token, and the LIST is the unit
 *
 * #81 model rule 11 and acceptance 4. Every mutation of the list OR of one of
 * its items is a compare-and-swap on this column, so a client editing a stale
 * copy is REFUSED rather than silently overwriting an edit it never saw. The
 * unit is the list rather than the item because a client holds and renders a
 * whole list: a per-item version would let a reorder computed against one
 * membership be applied to another, which is the case a concurrency token exists
 * to catch and the one a per-item token cannot see.
 *
 * ## `display_currency` is NOT NULL and `market` is nullable
 *
 * A basket total has to name a currency (#81 basket rule 1), so a list without
 * one could not be evaluated at all. A market is a NARROWING — absent means "do
 * not restrict offers by market", which is what #74's comparison does with no
 * market — so absence is a real, useful state rather than a missing setting.
 *
 * ## `last_evaluated_at` records a SNAPSHOT, not an evaluation
 *
 * Opening the basket evaluates and writes nothing; recording a snapshot is an
 * explicit act. Stamping this on every read would make a GET a write, and would
 * make "when was this list last measured" answer "whenever somebody last looked
 * at it", which is not the question a history page is asking.
 */
export const watchlists = pgTable(
  'watchlists',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. Oxy owns identity. */
    oxyUserId: text().notNull(),
    name: text().notNull(),
    description: text(),
    /** An emoji or short token the owner picked. Copy, never a file reference. */
    icon: text(),
    /** #81 privacy rule 1. One member; see the file header. */
    visibility: text({ enum: asEnumValues(WATCHLIST_VISIBILITIES) }).notNull().default('private'),
    /** #81 model rule 4 — what every amount on this list is expressed in. */
    displayCurrency: text({ enum: asEnumValues(ALL_CURRENCY_CODES) }).notNull(),
    /** ISO 3166-1 alpha-2, uppercase. NULL means "do not narrow by market". */
    market: text(),
    /**
     * Which template the list was created from (#81 UX rule 8).
     *
     * A CODE constant's value, not a foreign key into a templates table: a
     * template supplies a name, an icon and a description, and a table would let
     * somebody publish one whose defaults nobody shipped (#60's
     * `CATALOG_BACKFILL_MAPPING_VERSION`, same reasoning). NULL on every list
     * somebody named themselves.
     */
    templateKey: text({ enum: asEnumValues(WATCHLIST_TEMPLATE_KEYS) }),
    /** #81 model rule 11. See the doc above. */
    version: integer().notNull().default(1),
    /** When an evaluation was last RECORDED. See the doc above. */
    lastEvaluatedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('watchlists_oxy_user_id_check', sql`btrim(${t.oxyUserId}) <> ''`),
    check(
      'watchlists_name_check',
      sql`btrim(${t.name}) <> '' and length(${t.name}) <= ${sql.raw(String(WATCHLIST_MAX_NAME_LENGTH))}`,
    ),
    check(
      'watchlists_description_check',
      sql`${t.description} is null
          or (btrim(${t.description}) <> ''
              and length(${t.description}) <= ${sql.raw(String(WATCHLIST_MAX_DESCRIPTION_LENGTH))})`,
    ),
    check(
      'watchlists_icon_check',
      sql`${t.icon} is null
          or (btrim(${t.icon}) <> ''
              and length(${t.icon}) <= ${sql.raw(String(WATCHLIST_MAX_ICON_LENGTH))})`,
    ),
    checkOneOf('watchlists_visibility_check', t.visibility, WATCHLIST_VISIBILITIES),
    checkOneOf('watchlists_template_key_check', t.templateKey, WATCHLIST_TEMPLATE_KEYS),
    ...currencyChecks('watchlists', [t.displayCurrency]),
    /**
     * A market is two upper-case letters or it is absent. A length check alone
     * would admit `es` and `E5`, and `#74`'s comparison upper-cases what it is
     * given — so a lower-case value stored here would narrow nothing while
     * looking like a restriction that was applied.
     */
    check('watchlists_market_check', sql`${t.market} is null or ${t.market} ~ '^[A-Z]{2}$'`),
    check('watchlists_version_check', sql`${t.version} >= 1`),
    /** The owner's own list of lists, ordered exactly as it is read. */
    index('watchlists_oxy_user_id_created_at_id_idx').on(
      t.oxyUserId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  ],
);

/**
 * `watchlist_items` — one product, one quantity, one buyer's narrowing.
 *
 * ## `position` is NOT unique, deliberately
 *
 * Ordering is `(position asc, added_at asc, id asc)` — a TOTAL order, so ties
 * are broken deterministically and the list never reorders itself between two
 * reads. A unique on `(watchlist_id, position)` would turn every reorder into a
 * constraint dance (renumber to temporary values, then renumber again) or into a
 * DEFERRABLE unique, which leaves the list unreadable to a concurrent
 * transaction mid-reorder. The reorder endpoint assigns a contiguous 0..n-1
 * anyway; the absence of a unique is what keeps a partially applied reorder from
 * aborting rather than simply looking odd until the next one.
 *
 * ## The foreign keys are RESTRICT, and the note is PROTECTED
 *
 * `canonical_product_id`, `preferred_canonical_variant_id` and
 * `preferred_merchant_id` all RESTRICT: a canonical entity is never hard-deleted
 * (a merge stamps a tombstone, a suppression hides), so RESTRICT costs nothing
 * and states the fact that a person's list is not something to take along
 * silently. `watchlist_id` CASCADEs, because an item exists only to be in a list.
 */
export const watchlistItems = pgTable(
  'watchlist_items',
  {
    id: generatedId(),
    watchlistId: text()
      .notNull()
      .references(() => watchlists.id, { onDelete: 'cascade' }),
    canonicalProductId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    /** #81 model rule 6. NULL means "any configuration". */
    preferredCanonicalVariantId: text().references(() => canonicalVariants.id, {
      onDelete: 'restrict',
    }),
    /**
     * #81 model rule 7, a preferred condition SEGMENT.
     *
     * A GROUP and not one of #90's nine keys, for #80's reason: "I want a
     * refurbished one" is a filter over a segment, and pinning
     * `refurbished_seller` would silently exclude `refurbished_manufacturer`
     * from a buyer who meant both.
     */
    preferredConditionGroup: text({ enum: asEnumValues(CONDITION_GROUPS) }),
    /** #81 model rule 7 — a preferred seller of record. */
    preferredMerchantId: text().references(() => merchants.id, { onDelete: 'restrict' }),
    quantity: integer().notNull().default(1),
    /** See the doc above — a total order, not a unique. */
    position: integer().notNull(),
    /**
     * #81 model rule 8. The two columns move together (`num_nonnulls in (0, 2)`)
     * because an amount with no currency is not a target.
     *
     * The currency is the TARGET's own and may differ from the list's display
     * currency; the comparison is then simply not made (`not_comparable`).
     * Converting it would make "you reached your target" depend on a rate
     * movement rather than on a price — #80's reference-price rule, applied to a
     * threshold instead of an observation.
     */
    targetAmount: bigint({ mode: 'number' }),
    targetCurrency: text({ enum: asEnumValues(ALL_CURRENCY_CODES) }),
    /** #81 model rule 9. PROTECTED — see the file header. */
    note: text(),
    /** #81 model rule 10, the stored half. See {@link WatchlistItemResolutionState}. */
    resolutionState: text({ enum: asEnumValues(WATCHLIST_ITEM_RESOLUTION_STATES) })
      .notNull()
      .default('resolved'),
    /**
     * The split that made this item ambiguous. RESTRICT: the job is the only
     * record of what the two candidates were, so it must outlive the ambiguity
     * it created.
     */
    ambiguousSplitJobId: text().references(() => catalogSplitJobs.id, { onDelete: 'restrict' }),
    addedAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'watchlist_items_quantity_check',
      sql`${t.quantity} >= 1 and ${t.quantity} <= ${sql.raw(String(WATCHLIST_MAX_ITEM_QUANTITY))}`,
    ),
    check('watchlist_items_position_check', sql`${t.position} >= 0`),
    checkOneOf(
      'watchlist_items_preferred_condition_group_check',
      t.preferredConditionGroup,
      CONDITION_GROUPS,
    ),
    checkOneOf(
      'watchlist_items_resolution_state_check',
      t.resolutionState,
      WATCHLIST_ITEM_RESOLUTION_STATES,
    ),
    /** #80's biconditional, one domain over. See the file header. */
    check(
      'watchlist_items_ambiguity_check',
      sql`(${t.resolutionState} = 'ambiguous_after_split') = (${t.ambiguousSplitJobId} is not null)`,
    ),
    check(
      'watchlist_items_target_shape_check',
      sql`num_nonnulls(${t.targetAmount}, ${t.targetCurrency}) in (0, 2)`,
    ),
    check(
      'watchlist_items_target_range_check',
      sql`${t.targetAmount} is null
          or (${t.targetAmount} >= 0
              and ${t.targetAmount} <= ${sql.raw(String(MAX_MONEY_MINOR_UNITS))})`,
    ),
    ...currencyChecks('watchlist_items', [t.targetCurrency]),
    check(
      'watchlist_items_note_check',
      sql`${t.note} is null
          or (btrim(${t.note}) <> ''
              and length(${t.note}) <= ${sql.raw(String(WATCHLIST_MAX_NOTE_LENGTH))})`,
    ),
    /** One entry per product per list. See the file header. */
    uniqueIndex('watchlist_items_watchlist_id_canonical_product_id_key').on(
      t.watchlistId,
      t.canonicalProductId,
    ),
    /** The list read's exact order. */
    index('watchlist_items_watchlist_id_position_idx').on(
      t.watchlistId,
      t.position,
      t.addedAt,
      t.id,
    ),
    /** The merge's rehoming predicate and the split's marking predicate. */
    index('watchlist_items_canonical_product_id_idx').on(t.canonicalProductId),
    index('watchlist_items_preferred_canonical_variant_id_idx')
      .on(t.preferredCanonicalVariantId)
      .where(sql`${t.preferredCanonicalVariantId} is not null`),
    index('watchlist_items_preferred_merchant_id_idx')
      .on(t.preferredMerchantId)
      .where(sql`${t.preferredMerchantId} is not null`),
    /** "Which of my items are waiting on me" — the buyer's own inbox of one. */
    index('watchlist_items_ambiguous_idx')
      .on(t.watchlistId, t.addedAt)
      .where(sql`${t.resolutionState} = 'ambiguous_after_split'`),
  ],
);

/**
 * `watchlist_snapshots` — one bounded, reproducible evaluation of one list
 * (#81 snapshot rules 1–6).
 *
 * ## The counters are a VACUITY FLOOR, not bookkeeping
 *
 * `item_count = priced_item_count + unresolved_item_count`, by CHECK, with
 * equality rather than `<=`. #60's lesson applies exactly: a report that says it
 * went fine looks identical to one that swallowed half its work, and the only
 * difference a database can see is arithmetic that has to add up.
 *
 * ## The total's shape is a CHECK, not a convention
 *
 * `total_amount` is present EXACTLY when `completeness <> 'unknown'`, and
 * `basis` with it. A snapshot claiming an unknown total while carrying a number
 * — or claiming a complete one with nothing in it — is unrepresentable, which is
 * the same "completeness ⇔ presentation" constraint #120 writes for a retail
 * quote.
 *
 * ## `content_digest` is what deduplicates, and it is not unique
 *
 * A total that returns to a previous value weeks later is a NEW observation and
 * must be storable, so the digest is compared against the LATEST snapshot only,
 * under a `FOR UPDATE` lock on the list row. A unique on the digest would refuse
 * exactly the honest repeat and would make a list that oscillates between two
 * prices record only the first two of them.
 */
export const watchlistSnapshots = pgTable(
  'watchlist_snapshots',
  {
    id: generatedId(),
    watchlistId: text()
      .notNull()
      .references(() => watchlists.id, { onDelete: 'cascade' }),
    /** #81 snapshot rule 1 — the list version this measured. */
    listVersion: integer().notNull(),
    /**
     * #81 snapshot rule 1 — every #74 policy version that chose an offer here.
     *
     * An ARRAY rather than one value, because #74's canary is keyed on the
     * comparison SUBJECT: two items of one list can legitimately be ranked under
     * two versions, and a single column would have to pick one and misreport the
     * other. Two snapshots are comparable only when these sets are EQUAL — a
     * policy change can select a different offer at unchanged prices, so a diff
     * across one would blame items that did not move.
     */
    rankingPolicyVersions: text().array().notNull(),
    displayCurrency: text({ enum: asEnumValues(ALL_CURRENCY_CODES) }).notNull(),
    market: text(),
    completeness: text({ enum: asEnumValues(WATCHLIST_BASKET_COMPLETENESS) }).notNull(),
    basis: text({ enum: asEnumValues(WATCHLIST_BASKET_BASES) }),
    totalAmount: bigint({ mode: 'number' }),
    itemCount: integer().notNull(),
    pricedItemCount: integer().notNull(),
    unresolvedItemCount: integer().notNull(),
    /**
     * #81 snapshot rule 6. Never empty — the first one carries `first_snapshot`.
     *
     * `$type` narrows the element to the tuple the CHECK is rendered from, so a
     * reader gets the union rather than `string` and a writer cannot pass a kind
     * nobody declared. The CHECK is what enforces it in the database; this is
     * what enforces it in the editor, and they read from one tuple.
     */
    materialChanges: text().array().notNull().$type<WatchlistSnapshotChangeKind[]>(),
    /**
     * The snapshot this one was compared against. `set null`, not cascade: a
     * predecessor swept by retention must not take its successor with it, and a
     * dangling pointer would make the chain lie about what was compared.
     */
    previousSnapshotId: text().references((): AnyPgColumn => watchlistSnapshots.id, {
      onDelete: 'set null',
    }),
    /** What the digest of this evaluation was, so the next one can dedupe. */
    contentDigest: text().notNull(),
    evaluatedAt: timestamptz().notNull(),
    /** The retention deadline, stamped at write time. Swept by `expiryTargets`. */
    retentionExpiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('watchlist_snapshots_list_version_check', sql`${t.listVersion} >= 1`),
    ...currencyChecks('watchlist_snapshots', [t.displayCurrency]),
    check(
      'watchlist_snapshots_market_check',
      sql`${t.market} is null or ${t.market} ~ '^[A-Z]{2}$'`,
    ),
    checkOneOf(
      'watchlist_snapshots_completeness_check',
      t.completeness,
      WATCHLIST_BASKET_COMPLETENESS,
    ),
    checkOneOf('watchlist_snapshots_basis_check', t.basis, WATCHLIST_BASKET_BASES),
    /** See the doc above — completeness ⇔ a total with a basis. */
    check(
      'watchlist_snapshots_total_shape_check',
      sql`(${t.completeness} <> 'unknown')
          = (${t.totalAmount} is not null and ${t.basis} is not null)`,
    ),
    check(
      'watchlist_snapshots_total_range_check',
      sql`${t.totalAmount} is null
          or (${t.totalAmount} >= 0
              and ${t.totalAmount} <= ${sql.raw(String(MAX_MONEY_MINOR_UNITS))})`,
    ),
    /** The vacuity floor. Equality, never `<=`. See the doc above. */
    check(
      'watchlist_snapshots_item_counts_check',
      sql`${t.itemCount} = ${t.pricedItemCount} + ${t.unresolvedItemCount}
          and ${t.pricedItemCount} >= 0
          and ${t.unresolvedItemCount} >= 0`,
    ),
    /**
     * `cardinality`, never `array_length` — on an empty array the latter is NULL
     * and a CHECK reads NULL as SATISFIED, so the obvious spelling admits
     * exactly the row it exists to refuse. Measured twice already in this
     * schema (#68, #108); any future array-non-emptiness CHECK must read the
     * same way.
     */
    check(
      'watchlist_snapshots_material_changes_check',
      sql`cardinality(${t.materialChanges}) >= 1`,
    ),
    checkEveryElementOf(
      'watchlist_snapshots_material_changes_values_check',
      t.materialChanges,
      WATCHLIST_SNAPSHOT_CHANGE_KINDS,
    ),
    check('watchlist_snapshots_content_digest_check', sql`btrim(${t.contentDigest}) <> ''`),
    /** The history read, newest first, and the "latest snapshot" the dedupe reads. */
    index('watchlist_snapshots_watchlist_id_evaluated_at_id_idx').on(
      t.watchlistId,
      t.evaluatedAt.desc(),
      t.id.desc(),
    ),
    /** The expiry sweep's work list. */
    index('watchlist_snapshots_retention_expires_at_idx').on(t.retentionExpiresAt),
  ],
);

/**
 * `watchlist_snapshot_items` — what ONE item cost in ONE evaluation, and the
 * offer and quote it came from (#81 snapshot rule 3, correction rule 5).
 *
 * ## `selected_offer_id` carries NO foreign key, and that is the requirement
 *
 * #81 correction rule 5: "list history retains the offer used at the time."
 * `offers` CASCADEs from `listings` (#57's decision, so a seller deleting their
 * listing is never blocked), so a real foreign key here would DELETE the history
 * the rule exists to keep — quietly, and exactly when the offer that made a
 * price interesting went away. The id is recorded as inert text beside the
 * amounts, so the row stays a complete account of the evaluation with or without
 * the offer row. Registered in `ID_COLUMNS_WITHOUT_FOREIGN_KEY`.
 *
 * ## The item pointer is `set null`, and the product pointer is not
 *
 * An item removed from a list must not erase what it once cost — that IS the
 * history — so `watchlist_item_id` goes NULL and the row stands.
 * `canonical_product_id` is RESTRICT like everywhere else in this schema, so a
 * snapshot line always says WHAT was priced even after the item is gone.
 *
 * ## The five FX columns are a biconditional
 *
 * Present EXACTLY when `native_currency <> display_currency`. A same-currency
 * line has nothing to attribute and a converted one without a quote is not
 * reproducible; #120's `fx_*` shape, for its reason.
 */
export const watchlistSnapshotItems = pgTable(
  'watchlist_snapshot_items',
  {
    id: generatedId(),
    snapshotId: text()
      .notNull()
      .references(() => watchlistSnapshots.id, { onDelete: 'cascade' }),
    /** NULL once the item was removed from the list. See the doc above. */
    watchlistItemId: text().references(() => watchlistItems.id, { onDelete: 'set null' }),
    canonicalProductId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    preferredCanonicalVariantId: text().references(() => canonicalVariants.id, {
      onDelete: 'restrict',
    }),
    quantity: integer().notNull(),
    position: integer().notNull(),
    /** `priced` or `unresolved` — the two states a line can be in. */
    state: text({ enum: ['priced', 'unresolved'] }).notNull(),
    unresolvedReason: text({ enum: asEnumValues(WATCHLIST_ITEM_UNRESOLVED_REASONS) }),
    /** Inert text. See the doc above. */
    selectedOfferId: text(),
    selectedCanonicalVariantId: text(),
    /**
     * What the source said about availability at the moment of the evaluation
     * (#81 snapshot rule 3).
     *
     * Recorded rather than re-read: an offer that was in stock the day a buyer's
     * basket was measured was in stock that day, whatever it says now, and a
     * history that re-read it would rewrite itself every time somebody opened
     * it. `unknown` is a real member of #57's tuple and is what most feeds
     * publish.
     */
    selectedAvailability: text({ enum: asEnumValues(OFFER_AVAILABILITY_STATES) }),
    /** #74's policy version that chose this offer. */
    rankingPolicyVersion: text(),
    /** The unit item price in the SNAPSHOT's display currency. */
    unitItemPriceAmount: bigint({ mode: 'number' }),
    unitItemPriceCurrency: text({ enum: asEnumValues(ALL_CURRENCY_CODES) }),
    /** `unit × quantity`, stored so a history read needs no arithmetic to trust. */
    lineItemPriceAmount: bigint({ mode: 'number' }),
    /** Absent when the source published no delivery cost — never zero. */
    unitDeliveryAmount: bigint({ mode: 'number' }),
    lineDeliveryAmount: bigint({ mode: 'number' }),
    /** The offer's OWN currency, before conversion. */
    nativeCurrency: text({ enum: asEnumValues(ALL_CURRENCY_CODES) }),
    /** A conversion rate, genuinely fractional — #78's `doublePrecision` shape. */
    fxRate: doublePrecision(),
    fxFrom: text({ enum: asEnumValues(ALL_CURRENCY_CODES) }),
    fxTo: text({ enum: asEnumValues(ALL_CURRENCY_CODES) }),
    /**
     * What quoted the rate. Free `text`, deliberately NOT a closed set: the
     * sources are deployment configuration (`orders.fx_rate_provider`'s
     * reasoning), and a CHECK here would make adding an FX provider a migration.
     */
    fxProvider: text(),
    fxAsOf: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    check('watchlist_snapshot_items_quantity_check', sql`${t.quantity} >= 1`),
    check('watchlist_snapshot_items_position_check', sql`${t.position} >= 0`),
    checkOneOf('watchlist_snapshot_items_state_check', t.state, ['priced', 'unresolved']),
    checkOneOf(
      'watchlist_snapshot_items_unresolved_reason_check',
      t.unresolvedReason,
      WATCHLIST_ITEM_UNRESOLVED_REASONS,
    ),
    ...currencyChecks('watchlist_snapshot_items', [
      t.unitItemPriceCurrency,
      t.nativeCurrency,
      t.fxFrom,
      t.fxTo,
    ]),
    /**
     * A `priced` line carries an offer, a policy version, a price and a native
     * currency; an `unresolved` one carries a reason and NONE of them. Written
     * as TWO biconditionals rather than one over their conjunction: the single
     * form is satisfied when both sides are false, which admits exactly the row
     * this constraint exists to forbid (#126's finding, and it was measured).
     */
    checkOneOf(
      'watchlist_snapshot_items_availability_check',
      t.selectedAvailability,
      OFFER_AVAILABILITY_STATES,
    ),
    check(
      'watchlist_snapshot_items_priced_shape_check',
      sql`(${t.state} = 'priced')
          = (${t.selectedOfferId} is not null
             and ${t.selectedAvailability} is not null
             and ${t.rankingPolicyVersion} is not null
             and ${t.unitItemPriceAmount} is not null
             and ${t.unitItemPriceCurrency} is not null
             and ${t.lineItemPriceAmount} is not null
             and ${t.nativeCurrency} is not null)`,
    ),
    check(
      'watchlist_snapshot_items_unresolved_shape_check',
      sql`(${t.state} = 'unresolved') = (${t.unresolvedReason} is not null)`,
    ),
    /**
     * An unresolved line carries NO money, NO offer and NO quote.
     *
     * The `priced` biconditional above does not imply this and the realdb suite
     * is what proved it: a line with `state = 'unresolved'`, a price and no
     * offer satisfies BOTH sides of that CHECK as false, so the obvious pair of
     * constraints admits exactly the row #81 item rule 7 exists to forbid — an
     * item reported as contributing nothing while carrying an amount somebody
     * could later sum. Enumerated with `num_nonnulls` rather than a chain of
     * `is null`s so a column added later has to be added here too.
     */
    check(
      'watchlist_snapshot_items_unresolved_empty_check',
      sql`${t.state} <> 'unresolved'
          or num_nonnulls(${t.selectedOfferId}, ${t.selectedCanonicalVariantId},
                          ${t.selectedAvailability}, ${t.rankingPolicyVersion},
                          ${t.unitItemPriceAmount}, ${t.unitItemPriceCurrency},
                          ${t.lineItemPriceAmount}, ${t.unitDeliveryAmount},
                          ${t.lineDeliveryAmount}, ${t.nativeCurrency},
                          ${t.fxRate}, ${t.fxFrom}, ${t.fxTo}, ${t.fxProvider},
                          ${t.fxAsOf}) = 0`,
    ),
    /** Delivery is present in BOTH halves or neither — never a unit with no line. */
    check(
      'watchlist_snapshot_items_delivery_shape_check',
      sql`num_nonnulls(${t.unitDeliveryAmount}, ${t.lineDeliveryAmount}) in (0, 2)`,
    ),
    check(
      'watchlist_snapshot_items_amount_range_check',
      sql`(${t.unitItemPriceAmount} is null
           or (${t.unitItemPriceAmount} >= 0
               and ${t.unitItemPriceAmount} <= ${sql.raw(String(MAX_MONEY_MINOR_UNITS))}))
          and (${t.lineItemPriceAmount} is null
               or (${t.lineItemPriceAmount} >= 0
                   and ${t.lineItemPriceAmount} <= ${sql.raw(String(MAX_MONEY_MINOR_UNITS))}))
          and (${t.unitDeliveryAmount} is null
               or (${t.unitDeliveryAmount} >= 0
                   and ${t.unitDeliveryAmount} <= ${sql.raw(String(MAX_MONEY_MINOR_UNITS))}))
          and (${t.lineDeliveryAmount} is null
               or (${t.lineDeliveryAmount} >= 0
                   and ${t.lineDeliveryAmount} <= ${sql.raw(String(MAX_MONEY_MINOR_UNITS))}))`,
    ),
    /**
     * The quote is present EXACTLY when a conversion happened, and it names the
     * pair it converted. #78's `offer_price_points_fx_shape_check`, written as a
     * `case` for its reason: the five columns move together, and a rate with no
     * provider — a number nobody can attribute — is unrepresentable.
     *
     * A `priced` line in the display currency's own currency therefore has NO
     * quote, which is correct: nothing was converted, and `fx.convert` returns
     * the input object byte-identical on an equal pair.
     */
    check(
      'watchlist_snapshot_items_fx_shape_check',
      sql`case
        when ${t.fxRate} is null then
          ${t.fxFrom} is null and ${t.fxTo} is null
          and ${t.fxProvider} is null and ${t.fxAsOf} is null
          and (${t.nativeCurrency} is null
               or ${t.nativeCurrency} = ${t.unitItemPriceCurrency})
        else
          ${t.fxFrom} is not null and ${t.fxTo} is not null
          and ${t.fxProvider} is not null and ${t.fxAsOf} is not null
          and ${t.fxRate} > 0
          and ${t.fxFrom} = ${t.nativeCurrency}
          and ${t.fxTo} = ${t.unitItemPriceCurrency}
          and ${t.fxFrom} <> ${t.fxTo}
      end`,
    ),
    /** One line per item per snapshot — a replay of a write converges. */
    uniqueIndex('watchlist_snapshot_items_snapshot_id_position_key').on(t.snapshotId, t.position),
    index('watchlist_snapshot_items_watchlist_item_id_idx')
      .on(t.watchlistItemId)
      .where(sql`${t.watchlistItemId} is not null`),
    index('watchlist_snapshot_items_canonical_product_id_idx').on(t.canonicalProductId),
  ],
);
