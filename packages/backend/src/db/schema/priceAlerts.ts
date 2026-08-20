/**
 * Product and variant price alerts — issue #79: `price_alerts`,
 * `price_alert_evaluations`, `price_alert_triggers`,
 * `price_alert_trigger_quotes`, `price_alert_notifications`.
 *
 * #78 records what a source SAID about an offer's terms; #74 decides which
 * offers a shopper may be shown and in what order. This is the table that lets
 * one buyer say "tell me when it goes under this" and the machinery that makes
 * telling them happen exactly once.
 *
 * ## The four properties this file makes STRUCTURAL rather than conventional
 *
 * 1. **One notification per qualifying OBSERVATION.**
 *    `price_alert_triggers_identity_key` is
 *    `(alert_id, offer_id, observed_price_version, alert_policy_version)` —
 *    exactly the four facts `priceAlertTriggerKey` names, and nothing else. A
 *    duplicate source event, a re-scan, an FX re-check and two concurrent
 *    workers all converge on ONE row, and the delivery job hangs off that row
 *    rather than off the evaluation, so a retried send can never mint a second
 *    trigger (acceptance 6).
 * 2. **A converted amount cannot exist without its quote.**
 *    `price_alert_trigger_quotes` is one row per component actually converted,
 *    `UNIQUE(trigger_id, component)`, and `insertPriceAlertTrigger` is the SINGLE
 *    writer — it composes the trigger and its quotes in one transaction and
 *    refuses a mismatch before issuing SQL (the `insertRetailCostQuote` device,
 *    because "present exactly when the currencies differ" is CROSS-ROW and no
 *    CHECK can see it).
 * 3. **A repeat policy's own precondition is representable and required.**
 *    `reset_threshold` demands a threshold and `cooldown_better_low` demands a
 *    cooldown, both CHECKed, and both are FORBIDDEN on the other policies — so
 *    an alert cannot be stored claiming a repeat rule it has no input for.
 * 4. **A withheld notification leaves a row.** `suppressed` is a terminal state
 *    with a coded reason, never a delete and never a silent skip: issue
 *    operations 3 asks for stale-link suppression to be MONITORED, and a table
 *    of messages that were sent can never answer how many were not.
 *
 * ## What is deliberately NOT here
 *
 * - **No contact column of any kind.** Not an address, not a hash, not a push
 *   token. The transactional channel is Oxy's own notification service, which
 *   already holds the registrations; a copy here would be a second retention
 *   obligation with no owner and would put a buyer's inbox one join from a
 *   catalogue table.
 * - **No merchant-visible index.** There is no unique or index keyed on
 *   `canonical_product_id` ALONE that would make "who is watching this product"
 *   a cheap question, and no route asks it (issue abuse rule 6). The evaluation
 *   queue reads by product because it must; a merchant surface has no path to it.
 * - **No `armed` boolean.** Whether a `reset_threshold` alert may fire again is
 *   `rearmed_at > last_triggered_at`, two timestamps that each record a real
 *   event. A boolean beside them is a second representation of one fact.
 * - **No delivery-address, outbound URL or affiliate parameter.** A notification
 *   links to the canonical product and the qualifying offer INSIDE Mercaria
 *   (issue notification 3); a stored outbound destination is precisely the
 *   now-unvalidated link that rule forbids.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CONDITION_GROUPS,
  OFFER_KINDS,
  PRICE_ALERT_AVAILABILITY_REQUIREMENTS,
  PRICE_ALERT_BLOCK_REASONS,
  PRICE_ALERT_COMPARISON_BASES,
  PRICE_ALERT_COST_COMPONENTS,
  PRICE_ALERT_DELIVERY_FAILURES,
  PRICE_ALERT_MINUTES_PER_DAY,
  PRICE_ALERT_NOTIFICATION_CHANNELS,
  PRICE_ALERT_NOTIFICATION_STATES,
  PRICE_ALERT_PROXIMITY_SCOPES,
  PRICE_ALERT_REPEAT_POLICIES,
  PRICE_ALERT_RESOLUTION_STATES,
  PRICE_ALERT_SELLER_SCOPES,
  PRICE_ALERT_STATES,
  PRICE_ALERT_SUPPRESSION_REASONS,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf, currencyChecks, money } from './columns';
import { canonicalProducts, canonicalVariants } from './canonicalCatalog';
import { catalogSplitJobs } from './curation';
import { merchants, storefronts } from './merchants';
import { notifications } from './notifications';
import { offerPriceSnapshots } from './priceHistory';
import { offers } from './offers';

/**
 * The evaluation queue's own lifecycle — `offer_outboxes`', exactly.
 *
 * Local to the schema rather than in `@mercaria/shared-types` because no client
 * ever sees it: it is the state of a worker's claim, and #57's convergence queue
 * keeps its own for the same reason. There is no `failed` member — a failed
 * attempt goes back to `pending` with backoff, and only a caller's decision that
 * retrying is pointless produces the VISIBLE `dead_letter`.
 */
const PRICE_ALERT_EVALUATION_STATES = ['pending', 'processing', 'done', 'dead_letter'] as const;

/**
 * `price_alerts` — one buyer's price condition on one canonical product.
 *
 * ## Why there is no unique on (buyer, product)
 *
 * A buyer legitimately wants "under 500 new" AND "under 300 used" on one phone,
 * and a unique would force the second to overwrite the first. #80's saved
 * PRODUCT is one interest per buyer per product and is unique for that reason;
 * an alert is a CONDITION, and two conditions on one thing are two alerts. The
 * consequence for a merge is stated in `merge-plan.ts`: nothing is unique here,
 * so a rehome is an unconditional `repoint` with no absence guard to get wrong.
 *
 * ## `oxy_user_id` carries no foreign key
 *
 * Oxy owns identity (`CONVENTIONS.md` §"there is no `users` table"), so this is
 * the whole of what the domain stores about a person and erasure is one scoped
 * DELETE — the `product_saves` posture exactly.
 */
export const priceAlerts = pgTable(
  'price_alerts',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. See the table docblock. */
    oxyUserId: text().notNull(),
    /**
     * RESTRICT, not CASCADE: a canonical product is never hard-deleted (a merge
     * leaves a tombstone), and if one ever were, a buyer's alert vanishing with
     * it is a change to their list nobody asked for. `merge-plan.ts` carries the
     * rehoming decision instead.
     */
    canonicalProductId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    /** One exact configuration, or NULL for "any variant of this product". */
    canonicalVariantId: text().references(() => canonicalVariants.id, { onDelete: 'restrict' }),

    // ── The condition (issue model fields 3, 4, 5, 6, 7, 8) ──────────────────
    ...money('target'),
    basis: text({ enum: asEnumValues(PRICE_ALERT_COMPARISON_BASES) }).notNull(),
    /**
     * The condition SEGMENTS that count. EMPTY means every segment.
     *
     * #90's `ConditionGroup` and never a key: "tell me when a used one drops"
     * is a statement about a segment, and an alert keyed on `used_good` would
     * silently exclude `used_like_new`, which is a better copy of the same
     * thing. Empty rather than nullable, so "any" is one value and not two.
     */
    conditionGroups: text({ enum: asEnumValues(CONDITION_GROUPS) })
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** ISO 3166-1 alpha-2, or NULL for every market this thing is offered in. */
    market: text(),
    sellerScope: text({ enum: asEnumValues(PRICE_ALERT_SELLER_SCOPES) })
      .notNull()
      .default('any'),
    /**
     * `nearby_pickup` is representable and refused at the API — see the
     * `PriceAlertProximityScope` docblock. The column exists so the CHECK, the
     * evaluator's `proximity_scope_unsupported` block reason and #93's eventual
     * switch-on all have somewhere to be.
     */
    proximityScope: text({ enum: asEnumValues(PRICE_ALERT_PROXIMITY_SCOPES) })
      .notNull()
      .default('any'),
    /** RESTRICT: a merchant scope naming a deleted merchant would silently widen. */
    merchantId: text().references(() => merchants.id, { onDelete: 'restrict' }),
    storefrontId: text().references(() => storefronts.id, { onDelete: 'restrict' }),
    availabilityRequirement: text({ enum: asEnumValues(PRICE_ALERT_AVAILABILITY_REQUIREMENTS) })
      .notNull()
      .default('any'),
    /** Unknown quantity never satisfies a minimum — the evaluator, not a CHECK. */
    minimumAvailableQuantity: integer(),
    requirePickupAvailable: boolean().notNull().default(false),

    // ── Lifecycle and repeat policy (issue model fields 9, 10) ───────────────
    state: text({ enum: asEnumValues(PRICE_ALERT_STATES) }).notNull().default('enabled'),
    repeatPolicy: text({ enum: asEnumValues(PRICE_ALERT_REPEAT_POLICIES) })
      .notNull()
      .default('once'),
    /** Required by `reset_threshold` and forbidden otherwise (a CHECK). */
    resetThresholdAmount: bigint({ mode: 'number' }),
    cooldownSeconds: integer(),
    /**
     * When an evaluation last SAW the best in-scope amount above the reset
     * threshold. Compared against `last_triggered_at` — see the file docblock on
     * why there is no `armed` boolean.
     */
    rearmedAt: timestamptz(),

    // ── Quiet hours and locale (issue notification 7) ────────────────────────
    quietHoursStartMinute: integer(),
    quietHoursEndMinute: integer(),
    /** An IANA zone name. Validated by `Intl` at the API, never a stored list. */
    quietHoursTimeZone: text(),
    /** BCP-47, as the buyer's own client stated it. */
    locale: text(),
    /**
     * Issue notification 2 — email only through an EXPLICIT preference.
     *
     * Storable and unsendable: Mercaria has no outbound mail transport, so a
     * queued email notification fails `transport_unconfigured` visibly with the
     * row intact (#108's decision, same reasoning). The column is what makes
     * turning it on a registration rather than a schema change.
     */
    emailOptIn: boolean().notNull().default(false),

    // ── Merge and migration state (issue model field 12) ─────────────────────
    resolutionState: text({ enum: asEnumValues(PRICE_ALERT_RESOLUTION_STATES) })
      .notNull()
      .default('resolved'),
    /** The split that made this alert ambiguous. CASCADE would erase the question. */
    splitJobId: text().references(() => catalogSplitJobs.id, { onDelete: 'restrict' }),
    splitTargetCanonicalProductId: text().references(() => canonicalProducts.id, {
      onDelete: 'restrict',
    }),
    /** The product a MERGE moved this alert off, so the buyer can see it moved. */
    rehomedFromCanonicalProductId: text(),
    rehomedAt: timestamptz(),

    // ── Timestamps (issue model field 11) ────────────────────────────────────
    lastEvaluatedAt: timestamptz(),
    /**
     * Why the LAST evaluation did not produce a trigger (#752).
     *
     * Written by the SAME statement that stamps `last_evaluated_at`, which is
     * the point: before #752 `qualifyAlert` composed a real verdict and
     * `evaluation.service` dropped it with a bare `continue`, so the vocabulary
     * had no reader at all and an operator asking "why did my alert not fire"
     * got silence for every member.
     *
     * EMPTY means the last evaluation qualified — not "we did not record one".
     * That distinction is carried by `last_evaluated_at` being NULL, which is
     * already how "never evaluated" is told apart from "evaluated and did not
     * qualify".
     *
     * One row per alert, overwritten each evaluation, rather than a history
     * table — see `PriceAlertLastEvaluation` for why write volume decides that.
     */
    lastBlockReasons: text({ enum: asEnumValues(PRICE_ALERT_BLOCK_REASONS) })
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Present exactly when `last_block_reasons` is non-empty (a CHECK). */
    lastBlockedAt: timestamptz(),
    lastTriggeredAt: timestamptz(),
    lastDeliveredAt: timestamptz(),
    /** The amount that fired last time — `cooldown_better_low`'s comparison basis. */
    lastTriggeredAmount: bigint({ mode: 'number' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...currencyChecks('price_alerts', [t.targetCurrency]),
    checkOneOf('price_alerts_basis_check', t.basis, PRICE_ALERT_COMPARISON_BASES),
    checkEveryElementOf(
      'price_alerts_condition_groups_check',
      t.conditionGroups,
      CONDITION_GROUPS,
    ),
    checkEveryElementOf(
      'price_alerts_last_block_reasons_check',
      t.lastBlockReasons,
      PRICE_ALERT_BLOCK_REASONS,
    ),
    /**
     * The two halves of one evaluation outcome cannot disagree (#752).
     *
     * `cardinality`, never `array_length(col, 1)` — the latter is NULL on an
     * empty array and a CHECK rejects only FALSE, so the obvious spelling would
     * ADMIT the empty-reasons-with-a-timestamp row this exists to refuse. The
     * finding is recorded twice in `offerFreshness.ts` and once in
     * `guestPortal.ts`; this is the same trap, so it is spelled the same way.
     */
    check(
      'price_alerts_last_block_shape_check',
      sql`(cardinality(${t.lastBlockReasons}) > 0) = (${t.lastBlockedAt} is not null)`,
    ),
    /**
     * A blocked verdict implies the evaluation happened. The converse is NOT
     * asserted: an evaluation that QUALIFIED stamps `last_evaluated_at` and
     * leaves the reasons empty, which is the ordinary success state.
     */
    check(
      'price_alerts_last_block_evaluated_check',
      sql`${t.lastBlockedAt} is null or ${t.lastEvaluatedAt} is not null`,
    ),
    checkOneOf('price_alerts_seller_scope_check', t.sellerScope, PRICE_ALERT_SELLER_SCOPES),
    checkOneOf('price_alerts_proximity_scope_check', t.proximityScope, PRICE_ALERT_PROXIMITY_SCOPES),
    checkOneOf(
      'price_alerts_availability_requirement_check',
      t.availabilityRequirement,
      PRICE_ALERT_AVAILABILITY_REQUIREMENTS,
    ),
    checkOneOf('price_alerts_state_check', t.state, PRICE_ALERT_STATES),
    checkOneOf('price_alerts_repeat_policy_check', t.repeatPolicy, PRICE_ALERT_REPEAT_POLICIES),
    checkOneOf(
      'price_alerts_resolution_state_check',
      t.resolutionState,
      PRICE_ALERT_RESOLUTION_STATES,
    ),
    check('price_alerts_market_check', sql`${t.market} ~ '^[A-Z]{2}$'`),
    check('price_alerts_target_amount_check', sql`${t.targetAmount} > 0`),
    check(
      'price_alerts_minimum_quantity_check',
      sql`${t.minimumAvailableQuantity} is null or ${t.minimumAvailableQuantity} >= 1`,
    ),
    /**
     * A repeat policy carries EXACTLY the input it needs and none it does not.
     *
     * Both directions matter. Without the "required" half an alert could be
     * stored claiming `reset_threshold` with nothing to re-arm against, which
     * would make it a `once` alert wearing another name; without the
     * "forbidden" half a threshold could sit on an `always` alert and read, to
     * whoever looked next, as a rule that was being applied.
     */
    check(
      'price_alerts_reset_threshold_check',
      sql`(${t.repeatPolicy} = 'reset_threshold') = (${t.resetThresholdAmount} is not null)`,
    ),
    check(
      'price_alerts_cooldown_check',
      sql`(${t.repeatPolicy} = 'cooldown_better_low') = (${t.cooldownSeconds} is not null)`,
    ),
    check(
      'price_alerts_cooldown_seconds_positive_check',
      sql`${t.cooldownSeconds} is null or ${t.cooldownSeconds} > 0`,
    ),
    /**
     * A reset threshold is a price the market must climb back ABOVE before the
     * alert re-arms, so a threshold at or below the target could never be
     * crossed by a price that was under the target — the alert would fire once
     * and never again, which is `once` under a different name.
     */
    check(
      'price_alerts_reset_above_target_check',
      sql`${t.resetThresholdAmount} is null or ${t.resetThresholdAmount} > ${t.targetAmount}`,
    ),
    /**
     * Quiet hours are three facts or none.
     *
     * A window with no zone is a window in the server's time, which is not a
     * fact about the buyer's night; a zone with no window says nothing at all.
     */
    check(
      'price_alerts_quiet_hours_shape_check',
      sql`(${t.quietHoursStartMinute} is null) = (${t.quietHoursEndMinute} is null)
          and (${t.quietHoursStartMinute} is null) = (${t.quietHoursTimeZone} is null)`,
    ),
    check(
      'price_alerts_quiet_hours_range_check',
      sql`(${t.quietHoursStartMinute} is null
             or (${t.quietHoursStartMinute} >= 0
                 and ${t.quietHoursStartMinute} < ${sql.raw(String(PRICE_ALERT_MINUTES_PER_DAY))}))
          and (${t.quietHoursEndMinute} is null
             or (${t.quietHoursEndMinute} >= 0
                 and ${t.quietHoursEndMinute} < ${sql.raw(String(PRICE_ALERT_MINUTES_PER_DAY))}))`,
    ),
    /**
     * An ambiguous alert names its split job and is PAUSED.
     *
     * The pause is the buyer-visible half and the resolution state is the
     * reason; they are not two representations of one fact, because an alert can
     * be paused for reasons that have nothing to do with a split. What this
     * refuses is the other direction: an ambiguity that leaves the alert live,
     * which would keep notifying about a product the buyer may not have meant.
     */
    check(
      'price_alerts_ambiguity_shape_check',
      sql`(${t.resolutionState} = 'ambiguous_after_split')
            = (${t.splitJobId} is not null)`,
    ),
    check(
      'price_alerts_ambiguity_paused_check',
      sql`${t.resolutionState} <> 'ambiguous_after_split' or ${t.state} = 'paused'`,
    ),
    check(
      'price_alerts_rehomed_shape_check',
      sql`(${t.rehomedFromCanonicalProductId} is null) = (${t.rehomedAt} is null)`,
    ),
    /**
     * An amount that fired IMPLIES an instant it fired at, and not the reverse.
     *
     * A one-way implication rather than a biconditional, deliberately: a trigger
     * always records both, but a future path that records a notification
     * without an amount is a legitimate shape and a biconditional would refuse
     * it. Written as `A is null or B is not null` and NOT as a comparison of two
     * boolean expressions — `(a is null) >= (b is not null)` reads like an
     * implication and evaluates to the opposite one, which is how the first
     * version of this constraint rejected every trigger the domain wrote. Caught
     * by the real-server suite on its first run; `tsc` and every mocked insert
     * accepted it.
     */
    check(
      'price_alerts_last_triggered_shape_check',
      sql`${t.lastTriggeredAmount} is null or ${t.lastTriggeredAt} is not null`,
    ),
    /**
     * A buyer's own list, newest first, and the cap `countActiveAlerts` reads.
     * PARTIAL, because a deleted alert is never listed and never counted.
     */
    index('price_alerts_owner_idx')
      .on(t.oxyUserId, t.createdAt.desc())
      .where(sql`${t.state} <> 'deleted'`),
    /**
     * The evaluator's own read: every alert still worth evaluating on one
     * product. PARTIAL on the evaluable state, so the index is the size of the
     * live set rather than of every alert ever created — and deliberately
     * COMPOSITE with the state, so it cannot serve a bare "who watches this
     * product" question on its own.
     */
    index('price_alerts_subject_idx')
      .on(t.canonicalProductId, t.state)
      .where(sql`${t.state} = 'enabled'`),
    index('price_alerts_split_job_idx')
      .on(t.splitJobId)
      .where(sql`${t.splitJobId} is not null`),
  ],
);

/**
 * `price_alert_evaluations` — the durable evaluation queue, ONE row per
 * canonical product (issue evaluation 1, abuse rule 2).
 *
 * ### The row IS the job, and it CONVERGES
 *
 * `offer_outboxes`' shape and not the moderation outbox's: an evaluation
 * delivers a FIXED POINT rather than a message, so forty offer writes on one
 * popular product in a second owe ONE evaluation. That is issue abuse rule 2
 * ("batch fan-out for popular products") expressed as an enqueue rather than as
 * a batching layer — and the `requested_revision` / `claimed_revision` pair is
 * what stops a write that lands mid-run being swallowed by the completion that
 * follows it.
 *
 * ### Why the queue is keyed on the PRODUCT and not on the alert
 *
 * One claim then evaluates every alert on that product against ONE comparison
 * read per distinct (currency, market, segment) combination. Keyed on the alert
 * it would be one comparison per buyer, which is the fan-out this exists to
 * avoid; keyed on the offer it would be one row per changed offer and the
 * product-wide alerts would each be evaluated once per variant.
 *
 * ### The counters are the last run's, not a total
 *
 * `last_evaluated_alerts` and `last_qualified_alerts` are what makes a VACUOUS
 * evaluation visible: a subject with forty alerts reporting zero evaluated is a
 * broken read, and a table of triggers can only ever show the runs that
 * produced one. They are a snapshot rather than a running total because the row
 * survives its own completion and a total would need a second writer.
 */
export const priceAlertEvaluations = pgTable(
  'price_alert_evaluations',
  {
    id: generatedId(),
    /**
     * CASCADE, and it is the one place this domain gives ground: a queue row is
     * a request to look at a product, and a product that no longer exists has
     * nothing to look at. The ALERTS are `RESTRICT` — those are a person's.
     */
    canonicalProductId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'cascade' }),
    state: text({ enum: PRICE_ALERT_EVALUATION_STATES })
      .notNull()
      .default('pending'),
    /** Bumped by every enqueue. See the table docblock. */
    requestedRevision: integer().notNull().default(1),
    /** The revision a worker took responsibility for when it claimed. */
    claimedRevision: integer(),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    /** An opaque worker identity — no foreign key. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    /** A BOUNDED code, never an exception message. */
    lastFailure: text(),
    lastEvaluatedAt: timestamptz(),
    lastEvaluatedAlerts: integer(),
    lastQualifiedAlerts: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('price_alert_evaluations_state_check', t.state, PRICE_ALERT_EVALUATION_STATES),
    check('price_alert_evaluations_attempts_check', sql`${t.attempts} >= 0`),
    check('price_alert_evaluations_revision_check', sql`${t.requestedRevision} >= 1`),
    check(
      'price_alert_evaluations_claimed_revision_check',
      sql`${t.claimedRevision} is null or ${t.claimedRevision} <= ${t.requestedRevision}`,
    ),
    check(
      'price_alert_evaluations_counters_check',
      sql`(${t.lastEvaluatedAlerts} is null or ${t.lastEvaluatedAlerts} >= 0)
          and (${t.lastQualifiedAlerts} is null or ${t.lastQualifiedAlerts} >= 0)
          and coalesce(${t.lastQualifiedAlerts}, 0) <= coalesce(${t.lastEvaluatedAlerts}, 0)`,
    ),
    /** One row per subject — what makes the enqueue a convergence. */
    uniqueIndex('price_alert_evaluations_subject_key').on(t.canonicalProductId),
    index('price_alert_evaluations_pending_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.state} = 'pending'`),
    index('price_alert_evaluations_reclaim_idx')
      .on(t.leaseUntil)
      .where(sql`${t.state} = 'processing'`),
  ],
);

/**
 * `price_alert_triggers` — one qualifying OBSERVATION, once.
 *
 * The unique index below is the whole of issue §"Trigger identity", and each of
 * its four columns earns its place:
 *
 * - `alert_id` — two buyers watching one price are two notifications.
 * - `offer_id` — two sellers crossing one target are two things worth saying.
 * - `observed_price_version` — the immutable `offer_price_snapshots` row behind
 *   the price. Without it a repeated evaluation of one unchanged price has no
 *   way to recognise itself; with a TIMESTAMP instead, every sweep would be a
 *   new identity, which is the same bug pointed the other way.
 * - `alert_policy_version` — a change to what "qualifies" means is a genuinely
 *   new question, and a buyer is entitled to one answer to it.
 *
 * `observed_price_version` is NOT NULL, which is why the evaluator BLOCKS with
 * `no_observed_price_version` rather than triggering when no observation stands
 * behind a price: the alternative is a NULL in a unique key, which Postgres
 * treats as distinct, so every evaluation would insert another row.
 */
export const priceAlertTriggers = pgTable(
  'price_alert_triggers',
  {
    id: generatedId(),
    /** CASCADE: a buyer's deleted alert takes its own history with it (erasure). */
    alertId: text()
      .notNull()
      .references(() => priceAlerts.id, { onDelete: 'cascade' }),
    /** RESTRICT: the trigger is the record of an offer having crossed a target. */
    offerId: text()
      .notNull()
      .references(() => offers.id, { onDelete: 'cascade' }),
    /**
     * The immutable observation behind the price.
     *
     * CASCADE, matching `offer_price_points.snapshot_id`: #78's retention sweep
     * may lawfully remove an observation, and a trigger that outlived its
     * evidence would be a claim about a price with nothing behind it. The
     * consequence is stated rather than hidden — a buyer's very old trigger
     * history thins out with the source data it was derived from.
     */
    observedPriceVersion: text()
      .notNull()
      .references(() => offerPriceSnapshots.id, { onDelete: 'cascade' }),
    alertPolicyVersion: text().notNull(),

    /** Denormalized from the alert so a trace does not need it to still exist. */
    canonicalProductId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    /** Issue evaluation 7 — WHICH variant qualified, stated rather than implied. */
    canonicalVariantId: text()
      .notNull()
      .references(() => canonicalVariants.id, { onDelete: 'restrict' }),

    basis: text({ enum: asEnumValues(PRICE_ALERT_COMPARISON_BASES) }).notNull(),
    /** What was compared, in the ALERT's currency. */
    ...money('amount'),
    /** What it was compared AGAINST, snapshotted so an edit cannot rewrite history. */
    ...money('target'),
    /**
     * The offer's own price in the offer's own currency — the OPEN shape check,
     * #57's documented exception, because an external platform trades in
     * whatever it trades in.
     */
    nativeItemAmount: bigint({ mode: 'number' }).notNull(),
    nativeItemCurrency: text().notNull(),
    /** Present only for a `known_total` whose source PUBLISHED a delivery cost. */
    nativeDeliveryAmount: bigint({ mode: 'number' }),
    nativeDeliveryCurrency: text(),

    conditionGroup: text({ enum: asEnumValues(CONDITION_GROUPS) }),
    merchantId: text().references(() => merchants.id, { onDelete: 'restrict' }),
    offerKind: text({ enum: asEnumValues(OFFER_KINDS) }).notNull(),
    /** Issue notification 5 — native purchase and external navigation differ. */
    nativeCheckoutEligible: boolean().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    ...currencyChecks('price_alert_triggers', [t.amountCurrency, t.targetCurrency]),
    checkOneOf('price_alert_triggers_basis_check', t.basis, PRICE_ALERT_COMPARISON_BASES),
    checkOneOf('price_alert_triggers_condition_group_check', t.conditionGroup, CONDITION_GROUPS),
    checkOneOf('price_alert_triggers_offer_kind_check', t.offerKind, OFFER_KINDS),
    check(
      'price_alert_triggers_native_currency_check',
      sql`${t.nativeItemCurrency} ~ '^[A-Z]{3,4}$'`,
    ),
    check(
      'price_alert_triggers_delivery_paired_check',
      sql`(${t.nativeDeliveryAmount} is null) = (${t.nativeDeliveryCurrency} is null)`,
    ),
    check(
      'price_alert_triggers_delivery_currency_check',
      sql`${t.nativeDeliveryCurrency} is null or ${t.nativeDeliveryCurrency} ~ '^[A-Z]{3,4}$'`,
    ),
    /**
     * An `item_price` trigger cannot carry a delivery cost.
     *
     * Not tidiness: the amount is what the target was compared against, and a
     * delivery figure sitting beside an item-price comparison is exactly the
     * shape somebody later reads as "the total was this", which is the
     * unknown-shipping confusion acceptance 2 exists to keep apart.
     */
    check(
      'price_alert_triggers_basis_shape_check',
      sql`${t.basis} = 'known_total' or ${t.nativeDeliveryAmount} is null`,
    ),
    check(
      'price_alert_triggers_amounts_check',
      sql`${t.amountAmount} >= 0 and ${t.nativeItemAmount} >= 0
          and coalesce(${t.nativeDeliveryAmount}, 0) >= 0`,
    ),
    /** The amount that fired must actually satisfy the target it names. */
    check(
      'price_alert_triggers_satisfies_target_check',
      sql`${t.amountCurrency} = ${t.targetCurrency} and ${t.amountAmount} <= ${t.targetAmount}`,
    ),
    /** Issue §"Trigger identity", the whole of it. See the table docblock. */
    uniqueIndex('price_alert_triggers_identity_key').on(
      t.alertId,
      t.offerId,
      t.observedPriceVersion,
      t.alertPolicyVersion,
    ),
    index('price_alert_triggers_alert_idx').on(t.alertId, t.createdAt.desc()),
    index('price_alert_triggers_offer_idx').on(t.offerId, t.createdAt.desc()),
  ],
);

/**
 * `price_alert_trigger_quotes` — the FX quote behind each converted component
 * (issue evaluation 3, acceptance 3).
 *
 * A child table rather than ten columns on the trigger, because a `known_total`
 * legitimately converts TWO components from two source currencies and a fixed
 * column set would either hold one of them or hold both badly. `UNIQUE(trigger,
 * component)` is what makes a re-derivation unambiguous.
 *
 * "A quote exists exactly when a conversion happened" is CROSS-ROW and no CHECK
 * can see it, so `insertPriceAlertTrigger` is the SINGLE writer and refuses a
 * mismatch before issuing SQL — `insertRetailCostQuote`'s device, cited because
 * it is the same problem.
 */
export const priceAlertTriggerQuotes = pgTable(
  'price_alert_trigger_quotes',
  {
    id: generatedId(),
    triggerId: text()
      .notNull()
      .references(() => priceAlertTriggers.id, { onDelete: 'cascade' }),
    component: text({ enum: asEnumValues(PRICE_ALERT_COST_COMPONENTS) }).notNull(),
    fxFrom: text().notNull(),
    fxTo: text().notNull(),
    /** Units of `to` per ONE unit of `from` — a multiplier, not minor units. */
    fxRate: doublePrecision().notNull(),
    /** An FX provider id, a connector id, or `identity`. Free-form by contract. */
    fxProvider: text().notNull(),
    fxAsOf: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'price_alert_trigger_quotes_component_check',
      t.component,
      PRICE_ALERT_COST_COMPONENTS,
    ),
    ...currencyChecks('price_alert_trigger_quotes', [t.fxTo]),
    check('price_alert_trigger_quotes_from_check', sql`${t.fxFrom} ~ '^[A-Z]{3,4}$'`),
    check('price_alert_trigger_quotes_rate_check', sql`${t.fxRate} > 0`),
    /**
     * A quote whose two sides are the same currency converted nothing, so it is
     * not a record of a conversion — it is a row saying nothing happened, and
     * the writer refuses to create one. Stated as a CHECK too, because the
     * writer is code and this is the only thing that survives a `psql` session.
     */
    check('price_alert_trigger_quotes_distinct_check', sql`${t.fxFrom} <> ${t.fxTo}`),
    uniqueIndex('price_alert_trigger_quotes_component_key').on(t.triggerId, t.component),
  ],
);

/**
 * `price_alert_notifications` — the durable DELIVERY job (issue evaluation 10,
 * acceptance 6).
 *
 * ### Separate from evaluation, deliberately
 *
 * "Evaluation and delivery use separate durable jobs so a notification failure
 * does not lose the qualifying event" is this table existing at all, and the
 * consequence that matters is the reverse one: a delivery retried a hundred
 * times re-reads THIS row and never the price, so acceptance 6's "delivery
 * retry never reruns price evaluation or creates duplicate triggers" is a
 * property of the call graph rather than a rule somebody follows.
 *
 * ### The id is DETERMINISTIC and there is no default
 *
 * `moderation_outboxes`' decision: derived from the trigger and the channel, so
 * a repeat converges on the same row rather than queueing a second message
 * about one piece of news. That determinism IS the idempotency — see
 * `CONVENTIONS.md` §"Primary keys".
 *
 * ### `opened` is not a state here
 *
 * Whether somebody read it is stored once, on `notifications.read_at`, and
 * `notification_id` is the join that answers it. A second column would be a
 * second representation of one fact.
 */
export const priceAlertNotifications = pgTable(
  'price_alert_notifications',
  {
    /** DETERMINISTIC, caller-supplied — deliberately no default. */
    id: text().primaryKey(),
    triggerId: text()
      .notNull()
      .references(() => priceAlertTriggers.id, { onDelete: 'cascade' }),
    /** Denormalized so the dispatcher's own reads never join to find the owner. */
    alertId: text()
      .notNull()
      .references(() => priceAlerts.id, { onDelete: 'cascade' }),
    channel: text({ enum: asEnumValues(PRICE_ALERT_NOTIFICATION_CHANNELS) }).notNull(),
    state: text({ enum: asEnumValues(PRICE_ALERT_NOTIFICATION_STATES) })
      .notNull()
      .default('queued'),
    /** A CLOSED reason, and the row is what makes a withholding measurable. */
    suppressionReason: text({ enum: asEnumValues(PRICE_ALERT_SUPPRESSION_REASONS) }),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    /** A BOUNDED code, never a transport's own message. */
    failureReason: text({ enum: asEnumValues(PRICE_ALERT_DELIVERY_FAILURES) }),
    deliveredAt: timestamptz(),
    /**
     * The `notifications` row this produced, and the ONLY way `openedAt` is
     * answered. SET NULL rather than CASCADE: the retention sweep reaps a
     * dismissed notification after ninety days and the delivery RECORD outlives
     * it — losing the delivery history to a retention rule about a feed entry
     * would make issue notification 6's outcomes unanswerable for old alerts.
     */
    notificationId: text().references(() => notifications.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'price_alert_notifications_channel_check',
      t.channel,
      PRICE_ALERT_NOTIFICATION_CHANNELS,
    ),
    checkOneOf('price_alert_notifications_state_check', t.state, PRICE_ALERT_NOTIFICATION_STATES),
    checkOneOf(
      'price_alert_notifications_suppression_reason_check',
      t.suppressionReason,
      PRICE_ALERT_SUPPRESSION_REASONS,
    ),
    checkOneOf(
      'price_alert_notifications_failure_reason_check',
      t.failureReason,
      PRICE_ALERT_DELIVERY_FAILURES,
    ),
    check('price_alert_notifications_attempts_check', sql`${t.attempts} >= 0`),
    /**
     * A delivered row has an instant and nothing else does — the
     * `guest_portal_messages` CHECK, for its reason: without it a dead-lettered
     * or suppressed notification could carry a delivery timestamp and the
     * operator trace would report a send that never happened.
     */
    check(
      'price_alert_notifications_delivered_at_check',
      sql`(${t.state} = 'delivered') = (${t.deliveredAt} is not null)`,
    ),
    check(
      'price_alert_notifications_suppression_check',
      sql`(${t.state} = 'suppressed') = (${t.suppressionReason} is not null)`,
    ),
    /** A notification row can only belong to a state that actually sent one. */
    check(
      'price_alert_notifications_notification_id_check',
      sql`${t.notificationId} is null or ${t.state} = 'delivered'`,
    ),
    index('price_alert_notifications_pending_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.state} in ('queued', 'failed')`),
    index('price_alert_notifications_reclaim_idx')
      .on(t.leaseUntil)
      .where(sql`${t.state} = 'delivering'`),
    index('price_alert_notifications_trigger_idx').on(t.triggerId),
    index('price_alert_notifications_alert_idx').on(t.alertId, t.createdAt.desc()),
  ],
);
