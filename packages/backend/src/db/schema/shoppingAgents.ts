/**
 * Saved shopping-agent jobs — issue #97: `shopping_agents`,
 * `shopping_agent_lines`, `shopping_agent_triggers`,
 * `shopping_agent_evaluations`, `shopping_agent_findings`,
 * `shopping_agent_finding_lines`, `shopping_agent_notifications`,
 * `shopping_agent_audits`.
 *
 * #79 lets one buyer say "tell me when it goes under this" about one price.
 * This is the same shape for a whole saved OBJECTIVE — a basket target, a used
 * copy appearing, an official channel opening, a materially better plan — with
 * #96's deterministic solver as the thing that decides and #74's ranked,
 * eligible offers as the only inputs it may read.
 *
 * ## The five properties this file makes STRUCTURAL rather than conventional
 *
 * 1. **An agent cannot buy anything.** `shopping_agents_kind_check` is rendered
 *    from `SHOPPING_AGENT_JOB_KINDS`, which is DISJOINT from
 *    `SHOPPING_AGENT_FORBIDDEN_ACTIONS` — so no member of that prohibition is a
 *    value this column can hold, whether the writer is a service, a migration
 *    or `psql`.
 *    Underneath that, the ABSENCE is the enforcement: there is no order,
 *    checkout-group, payment-method, card, cart, merchant-message or
 *    merchant-terms column anywhere in these eight tables, and
 *    `shopping-agent-isolation.test.ts` walks the real drizzle tables and fails
 *    the build if one appears.
 * 2. **A finding built on missing data cannot notify.**
 *    `shopping_agent_findings_outcome_shape_check` restricts the objective value
 *    to a `qualified` finding, and
 *    `mercaria_shopping_agent_notification_requires_qualified` — a TRIGGER,
 *    because the invariant is CROSS-ROW and no CHECK can see it — refuses a
 *    notification whose finding is not `qualified`. #97 acceptance 5 and
 *    evaluation 6, held by the database.
 * 3. **One qualifying observation is one finding.**
 *    `shopping_agent_findings_identity_key` is `(agent_id, evaluation_key)`, and
 *    the key names the agent, its REVISION, the deterministic INPUT DIGEST and
 *    the policy version — four facts and no clock. #79's hardest-won rule, one
 *    layer up: a key without the input version fires once and never again, and a
 *    key with a timestamp fires on every sweep.
 * 4. **History is appended and never rewritten.** Three append-only triggers.
 *    UPDATE is refused on findings (except the one `lifecycle` transition a
 *    correction performs), on finding lines and on audits. DELETE is
 *    deliberately PERMITTED on all three — the `analytics_events` and
 *    `offer_price_snapshots` posture — because erasure is the policy and a
 *    trigger refusing it would make a scoped deletion fail SILENTLY.
 * 5. **An ambiguous agent is BLOCKED.**
 *    `shopping_agents_ambiguity_blocked_check` refuses an
 *    `ambiguous_after_split` agent that is not `blocked`, so a catalogue split
 *    cannot leave a live agent notifying about a product its owner may not have
 *    meant.
 *
 * ## What is deliberately NOT here
 *
 * - **No contact column of any kind.** Not an address, not a hash, not a push
 *   token. `price_alerts`' decision, for its reason.
 * - **No merchant-visible index.** Nothing is keyed on `canonical_product_id`
 *   ALONE. The fan-out reads by product because it must; no route asks who is
 *   watching one (#97 privacy 3).
 * - **No jsonb property bag.** The one jsonb pair is `constraint_set` (#94's
 *   own bounded, validated document, re-validated against the live registry on
 *   every evaluation) and `record_refs` (#96's citation table, which is what
 *   makes a generated summary checkable). Everything else — the selection, the
 *   constraint outcomes, the versions — is a real column or a child table. See
 *   `CONVENTIONS.md`'s jsonb register.
 * - **No `notified` boolean on a finding.** Whether it was told is the
 *   notification ROW, and a second representation of one fact can disagree.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CONDITION_GROUPS,
  SHOPPING_AGENT_AMBIGUITY_STATES,
  SHOPPING_AGENT_AUDIT_ACTIONS,
  SHOPPING_AGENT_AUDIT_ACTORS,
  SHOPPING_AGENT_CHANNEL_POLICIES,
  SHOPPING_AGENT_DELIVERY_FAILURES,
  SHOPPING_AGENT_EVIDENCE_COMPLETENESS,
  SHOPPING_AGENT_FINDING_LIFECYCLES,
  SHOPPING_AGENT_FINDING_OUTCOMES,
  SHOPPING_AGENT_FRESHNESS,
  SHOPPING_AGENT_INCOMPLETE_REASONS,
  SHOPPING_AGENT_JOB_KINDS,
  SHOPPING_AGENT_MINUTES_PER_DAY,
  SHOPPING_AGENT_NOTIFICATION_CHANNELS,
  SHOPPING_AGENT_NOTIFICATION_STATES,
  SHOPPING_AGENT_OPTIMALITIES,
  SHOPPING_AGENT_PRICE_BASES,
  SHOPPING_AGENT_STATES,
  SHOPPING_AGENT_SUPPRESSION_REASONS,
  SHOPPING_AGENT_TRIGGER_SOURCES,
  type ConstraintSet,
  type ShoppingAgentRecordRef,
} from '@mercaria/shared-types';
import {
  asEnumValues,
  checkEveryElementOf,
  checkOneOf,
  currencyChecks,
  optionalMoney,
} from './columns';
import { canonicalProducts, canonicalVariants } from './canonicalCatalog';
import { catalogSplitJobs } from './curation';
import { merchants } from './merchants';
import { notifications } from './notifications';

/**
 * A worker's claim, for BOTH queues in this file.
 *
 * File-local rather than in `@mercaria/shared-types` because no client sees it:
 * it is the state of a lease, and #57's convergence queue keeps its own for the
 * same reason. There is no `failed` member — a failed attempt goes back to
 * `pending` with backoff, and only a decision that retrying is pointless
 * produces the VISIBLE `dead_letter`.
 */
const SHOPPING_AGENT_QUEUE_STATES = ['pending', 'processing', 'done', 'dead_letter'] as const;

/**
 * `shopping_agents` — one shopper's saved objective.
 *
 * ## Why there is no unique on (owner, product)
 *
 * A shopper legitimately wants "under 500 new" AND "tell me when a refurbished
 * one shows up" on one phone, and the two are different questions. #80's saved
 * PRODUCT is unique per buyer because it is one interest; an agent is an
 * INSTRUCTION, and two instructions about one thing are two agents. What bounds
 * them is `SHOPPING_AGENT_MAX_ACTIVE_PER_USER`, counted at the service.
 *
 * ## `oxy_user_id` carries no foreign key
 *
 * Oxy owns identity (`CONVENTIONS.md` §"there is no `users` table"), so this
 * column plus `description` is the whole of what the domain stores about a
 * person, and erasure is one scoped DELETE that cascades everything else here.
 */
export const shoppingAgents = pgTable(
  'shopping_agents',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. See the table docblock. */
    oxyUserId: text().notNull(),
    /**
     * WHICH of the six launch jobs. The CHECK is rendered from the same tuple
     * that is disjoint from the sixteen forbidden actions, so this column is
     * where "no agent may act" stops being a rule and becomes a value set.
     */
    kind: text({ enum: asEnumValues(SHOPPING_AGENT_JOB_KINDS) }).notNull(),
    name: text().notNull(),
    /** The shopper's own note. PROTECTED — it never reaches a model provider. */
    description: text(),
    state: text({ enum: asEnumValues(SHOPPING_AGENT_STATES) }).notNull().default('enabled'),
    /**
     * Bumped by every MATERIAL edit, and part of the evaluation key.
     *
     * So an edit is a genuinely new question: the answer to the old one cannot
     * silence the new one, and re-running an unchanged agent still converges.
     */
    revision: integer().notNull().default(1),

    // ── The objective (issue model 3–6) ──────────────────────────────────────
    displayCurrency: text().notNull(),
    priceBasis: text({ enum: asEnumValues(SHOPPING_AGENT_PRICE_BASES) })
      .notNull()
      .default('item_price'),
    channelPolicy: text({ enum: asEnumValues(SHOPPING_AGENT_CHANNEL_POLICIES) })
      .notNull()
      .default('mixed'),
    /** ISO 3166-1 alpha-2, or NULL for every market the thing is offered in. */
    market: text(),
    /**
     * The condition SEGMENTS that count. EMPTY means every segment.
     *
     * #90's `ConditionGroup` and never a key, for #79's reason: an agent keyed
     * on `used_good` would silently exclude `used_like_new`, which is a better
     * copy of the same thing.
     */
    conditionGroups: text({ enum: asEnumValues(CONDITION_GROUPS) })
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Merchant ids no plan may use. No FK — a merge repoints, a delete cannot. */
    excludedMerchantIds: text().array().notNull().default(sql`'{}'::text[]`),
    /** What the objective is compared against. Required by exactly two kinds. */
    ...optionalMoney('target'),

    /**
     * The AUTHORITATIVE stored input (#97 §"SavedShoppingAgent model", final
     * line): the validated constraint object, never free-form text.
     *
     * jsonb, and one of exactly two in this domain. It earns it: a
     * `ConstraintSet` is a bounded (32 constraints, 4 groups, 8 members each),
     * two-level, closed-vocabulary document that #94 already owns a validator
     * for — and it is RE-VALIDATED against the live registry on every
     * evaluation, so a definition retired since the agent was saved refuses the
     * evaluation rather than being read under new meaning. Flattening it into
     * columns would be a second, weaker copy of #94's language.
     *
     * No raw query TEXT is stored: #95 keeps none for #77's retention reasons
     * and this domain inherits that decision rather than reopening it.
     */
    constraintSet: jsonb().$type<ConstraintSet>().notNull(),
    /**
     * A hash over the canonical serialization of `constraint_set`.
     *
     * The client echoes back the digest of exactly what it RENDERED for
     * confirmation, and a mismatch refuses the write — which is how #97
     * privacy 1's "explicit confirmation of the interpreted constraints"
     * becomes a comparison rather than a checkbox.
     */
    constraintDigest: text().notNull(),

    // ── Triggers, notification policy (issue model 7, 8) ─────────────────────
    triggerSources: text({ enum: asEnumValues(SHOPPING_AGENT_TRIGGER_SOURCES) })
      .array()
      .notNull(),
    /** How often a `scheduled` agent re-evaluates. Required by that source alone. */
    scheduleIntervalSeconds: integer(),
    nextScheduledAt: timestamptz(),
    notificationChannels: text({ enum: asEnumValues(SHOPPING_AGENT_NOTIFICATION_CHANNELS) })
      .array()
      .notNull(),
    cooldownSeconds: integer().notNull(),
    quietHoursStartMinute: integer(),
    quietHoursEndMinute: integer(),
    /** An IANA zone name. Validated by `Intl` at the API, never a stored list. */
    quietHoursTimeZone: text(),
    /** BCP-47, as the shopper's own client stated it. */
    locale: text(),

    // ── Merge, split and ambiguity (issue model 13) ──────────────────────────
    ambiguityState: text({ enum: asEnumValues(SHOPPING_AGENT_AMBIGUITY_STATES) })
      .notNull()
      .default('resolved'),
    /** The split that made this agent ambiguous. CASCADE would erase the question. */
    splitJobId: text().references(() => catalogSplitJobs.id, { onDelete: 'restrict' }),
    splitTargetCanonicalProductId: text().references(() => canonicalProducts.id, {
      onDelete: 'restrict',
    }),
    /** The product a MERGE moved this agent off, so the owner can see it moved. */
    rehomedFromCanonicalProductId: text(),
    rehomedAt: timestamptz(),

    // ── Authorization (issue model 12, privacy 1 and 7) ──────────────────────
    authorizedAt: timestamptz().notNull(),
    /**
     * MERCARIA's own agent terms, and never a merchant's.
     *
     * Accepting a merchant's or a supplier's terms is a forbidden ACTION in
     * this domain's vocabulary; the distinction matters here because the two
     * would otherwise share a column name and a reader would not be able to
     * tell which this is.
     */
    termsVersion: text().notNull(),

    // ── The versions an evaluation is reproducible from (issue model 11) ─────
    agentPolicyVersion: text().notNull(),
    constraintEvaluationVersion: text().notNull(),
    normalizationRuleVersion: text().notNull(),
    comparisonPolicyVersion: text().notNull(),
    /** Present only when the constraints came from a #95 interpretation. */
    parserVersion: text(),

    // ── Timestamps (issue model 10) ──────────────────────────────────────────
    lastEvaluatedAt: timestamptz(),
    lastNotifiedAt: timestamptz(),
    /** What was notified last time — the material-improvement comparison basis. */
    lastNotifiedAmount: bigint({ mode: 'number' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...currencyChecks('shopping_agents', [t.displayCurrency, t.targetCurrency]),
    checkOneOf('shopping_agents_kind_check', t.kind, SHOPPING_AGENT_JOB_KINDS),
    checkOneOf('shopping_agents_state_check', t.state, SHOPPING_AGENT_STATES),
    checkOneOf('shopping_agents_price_basis_check', t.priceBasis, SHOPPING_AGENT_PRICE_BASES),
    checkOneOf(
      'shopping_agents_channel_policy_check',
      t.channelPolicy,
      SHOPPING_AGENT_CHANNEL_POLICIES,
    ),
    checkOneOf(
      'shopping_agents_ambiguity_state_check',
      t.ambiguityState,
      SHOPPING_AGENT_AMBIGUITY_STATES,
    ),
    checkEveryElementOf(
      'shopping_agents_condition_groups_check',
      t.conditionGroups,
      CONDITION_GROUPS,
    ),
    checkEveryElementOf(
      'shopping_agents_trigger_sources_check',
      t.triggerSources,
      SHOPPING_AGENT_TRIGGER_SOURCES,
    ),
    checkEveryElementOf(
      'shopping_agents_notification_channels_check',
      t.notificationChannels,
      SHOPPING_AGENT_NOTIFICATION_CHANNELS,
    ),
    /**
     * `cardinality`, NEVER `array_length(col, 1)`.
     *
     * On an empty array `array_length` is NULL, and a CHECK rejects only FALSE
     * — so the obvious spelling ADMITS exactly the row it exists to refuse.
     * Measured twice in this schema already (#68, #108); any future
     * array-non-emptiness CHECK here must be written the same way.
     */
    check('shopping_agents_trigger_sources_present_check', sql`cardinality(${t.triggerSources}) >= 1`),
    check(
      'shopping_agents_notification_channels_present_check',
      sql`cardinality(${t.notificationChannels}) >= 1`,
    ),
    check('shopping_agents_market_check', sql`${t.market} ~ '^[A-Z]{2}$'`),
    check('shopping_agents_revision_check', sql`${t.revision} >= 1`),
    check('shopping_agents_name_check', sql`length(btrim(${t.name})) between 1 and 120`),
    check(
      'shopping_agents_description_check',
      sql`${t.description} is null or length(${t.description}) <= 500`,
    ),
    check('shopping_agents_cooldown_check', sql`${t.cooldownSeconds} > 0`),
    /**
     * A target is present for EXACTLY the two kinds that compare against a
     * number, and forbidden on the other four.
     *
     * Both directions. Without the "required" half a price-threshold agent
     * could be stored with nothing to compare against and would evaluate
     * forever without ever qualifying; without the "forbidden" half a target
     * could sit on an official-channel agent and read, to whoever looked next,
     * as a rule that was being applied.
     */
    check(
      'shopping_agents_target_shape_check',
      sql`(${t.kind} in ('offer_price_threshold', 'basket_target_total'))
            = (${t.targetAmount} is not null)`,
    ),
    check(
      'shopping_agents_target_amount_check',
      sql`${t.targetAmount} is null or ${t.targetAmount} > 0`,
    ),
    /**
     * The `scheduled` source carries its own interval and nothing else does.
     *
     * A scheduled agent with no interval never runs; an interval on an agent
     * that is not scheduled is a cadence nobody applies, which reads as one
     * that is.
     */
    check(
      'shopping_agents_schedule_shape_check',
      sql`('scheduled' = any(${t.triggerSources})) = (${t.scheduleIntervalSeconds} is not null)`,
    ),
    check(
      'shopping_agents_schedule_interval_check',
      sql`${t.scheduleIntervalSeconds} is null or ${t.scheduleIntervalSeconds} >= 900`,
    ),
    check(
      'shopping_agents_quiet_hours_shape_check',
      sql`(${t.quietHoursStartMinute} is null) = (${t.quietHoursEndMinute} is null)
          and (${t.quietHoursStartMinute} is null) = (${t.quietHoursTimeZone} is null)`,
    ),
    check(
      'shopping_agents_quiet_hours_range_check',
      sql`(${t.quietHoursStartMinute} is null
             or (${t.quietHoursStartMinute} >= 0
                 and ${t.quietHoursStartMinute} < ${sql.raw(String(SHOPPING_AGENT_MINUTES_PER_DAY))}))
          and (${t.quietHoursEndMinute} is null
             or (${t.quietHoursEndMinute} >= 0
                 and ${t.quietHoursEndMinute} < ${sql.raw(String(SHOPPING_AGENT_MINUTES_PER_DAY))}))`,
    ),
    check(
      'shopping_agents_ambiguity_shape_check',
      sql`(${t.ambiguityState} = 'ambiguous_after_split') = (${t.splitJobId} is not null)`,
    ),
    /**
     * An ambiguous agent is BLOCKED, and this is the strongest form of #80's
     * and #79's refusal to pick a side. A save on the wrong side of a split
     * shows a shopper the wrong page; an alert on the wrong side notifies them
     * once; an agent on the wrong side goes on notifying them, on its own
     * schedule, for as long as nobody looks.
     */
    check(
      'shopping_agents_ambiguity_blocked_check',
      sql`${t.ambiguityState} <> 'ambiguous_after_split' or ${t.state} = 'blocked'`,
    ),
    check(
      'shopping_agents_rehomed_shape_check',
      sql`(${t.rehomedFromCanonicalProductId} is null) = (${t.rehomedAt} is null)`,
    ),
    /**
     * An amount that was notified IMPLIES an instant it was notified at.
     *
     * A one-way implication and NOT a biconditional: a qualifying observation
     * that carries no number (an official channel opening) legitimately
     * notifies with no amount. Written `A is null or B is not null` — the
     * `(a is null) >= (b is not null)` spelling reads like an implication and
     * evaluates to the opposite one, which is how #79's first version of this
     * constraint rejected every row the domain wrote.
     */
    check(
      'shopping_agents_last_notified_shape_check',
      sql`${t.lastNotifiedAmount} is null or ${t.lastNotifiedAt} is not null`,
    ),
    /** The owner's own list, newest first. PARTIAL — a deleted agent is never listed. */
    index('shopping_agents_owner_idx')
      .on(t.oxyUserId, t.createdAt.desc())
      .where(sql`${t.state} <> 'deleted'`),
    /** The scheduled sweep's own read. PARTIAL, so it is the size of the live set. */
    index('shopping_agents_schedule_idx')
      .on(t.nextScheduledAt)
      .where(sql`${t.state} = 'enabled' and ${t.nextScheduledAt} is not null`),
    index('shopping_agents_split_job_idx')
      .on(t.splitJobId)
      .where(sql`${t.splitJobId} is not null`),
  ],
);

/**
 * `shopping_agent_lines` — one thing the agent watches.
 *
 * Shaped to #96's `BasketRequestLine` so an agent becomes a basket request with
 * no translation layer that could reinterpret a preference. A single-product
 * agent has exactly one line with quantity one; there is deliberately no second
 * shape for it, because two shapes would be two evaluation paths and the
 * simpler one would drift.
 *
 * This is also the FAN-OUT index: a trigger claims one canonical product and
 * finds the agents watching it here. Composite with `agent_id` for #79's
 * reason — nothing is keyed on `canonical_product_id` alone, and no route,
 * repository function or operator handle takes a product and answers who is
 * watching it.
 */
export const shoppingAgentLines = pgTable(
  'shopping_agent_lines',
  {
    id: generatedId(),
    agentId: text()
      .notNull()
      .references(() => shoppingAgents.id, { onDelete: 'cascade' }),
    /**
     * RESTRICT, not CASCADE: a canonical product is never hard-deleted (a merge
     * leaves a tombstone), and if one ever were, a shopper's agent silently
     * losing a line is a change to their instruction nobody asked for.
     * `merge-plan.ts` carries the rehoming decision instead.
     */
    canonicalProductId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    /** One exact configuration, or NULL for "any variant of this product". */
    canonicalVariantId: text().references(() => canonicalVariants.id, { onDelete: 'restrict' }),
    quantity: integer().notNull().default(1),
    /** Narrower than the agent's own segments, or empty to inherit them. */
    conditionGroups: text({ enum: asEnumValues(CONDITION_GROUPS) })
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    merchantId: text().references(() => merchants.id, { onDelete: 'restrict' }),
    position: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkEveryElementOf(
      'shopping_agent_lines_condition_groups_check',
      t.conditionGroups,
      CONDITION_GROUPS,
    ),
    check('shopping_agent_lines_quantity_check', sql`${t.quantity} >= 1`),
    check('shopping_agent_lines_position_check', sql`${t.position} >= 0`),
    uniqueIndex('shopping_agent_lines_position_key').on(t.agentId, t.position),
    /** The fan-out. Composite, deliberately — see the table docblock. */
    index('shopping_agent_lines_subject_idx').on(t.canonicalProductId, t.agentId),
  ],
);

/**
 * `shopping_agent_triggers` — the durable TRIGGER job, ONE row per canonical
 * product (#97 evaluation 1, cost 2).
 *
 * ### Triggers and evaluations are separate durable jobs, and this is the first
 *
 * #97 evaluation 1 asks for exactly that, and the reason is cost rule 2: forty
 * offer writes on one popular product in a second owe ONE fan-out, and that
 * fan-out then owes one evaluation to each agent watching it. Keyed on the
 * AGENT instead, a popular product would write a row per watcher per write.
 *
 * ### The row IS the job, and it CONVERGES
 *
 * `offer_outboxes`' shape rather than the moderation outbox's: a trigger
 * delivers a FIXED POINT rather than a message. The
 * `requested_revision`/`claimed_revision` pair is what stops a write that lands
 * mid-run being swallowed by the completion that follows it.
 *
 * ### The counter is what makes a VACUOUS fan-out visible
 *
 * `last_fanned_out_agents` at zero on a product several agents watch is a
 * broken read, and a table of evaluations can only ever show the fan-outs that
 * produced one — #60's `scannedFromRecords` device at a smaller grain.
 */
export const shoppingAgentTriggers = pgTable(
  'shopping_agent_triggers',
  {
    id: generatedId(),
    /**
     * CASCADE, and it is the one place this domain gives ground: a queue row is
     * a request to look at a product, and a product that no longer exists has
     * nothing to look at. The AGENTS and their LINES are `RESTRICT` — those are
     * a person's.
     */
    canonicalProductId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'cascade' }),
    state: text({ enum: SHOPPING_AGENT_QUEUE_STATES }).notNull().default('pending'),
    requestedRevision: integer().notNull().default(1),
    claimedRevision: integer(),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    /** An opaque worker identity — no foreign key. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    /** A BOUNDED code, never an exception message. */
    lastFailure: text(),
    lastFannedOutAt: timestamptz(),
    lastFannedOutAgents: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('shopping_agent_triggers_state_check', t.state, SHOPPING_AGENT_QUEUE_STATES),
    check('shopping_agent_triggers_attempts_check', sql`${t.attempts} >= 0`),
    check('shopping_agent_triggers_revision_check', sql`${t.requestedRevision} >= 1`),
    check(
      'shopping_agent_triggers_claimed_revision_check',
      sql`${t.claimedRevision} is null or ${t.claimedRevision} <= ${t.requestedRevision}`,
    ),
    check(
      'shopping_agent_triggers_counter_check',
      sql`${t.lastFannedOutAgents} is null or ${t.lastFannedOutAgents} >= 0`,
    ),
    /** One row per subject — what makes the enqueue a convergence. */
    uniqueIndex('shopping_agent_triggers_subject_key').on(t.canonicalProductId),
    index('shopping_agent_triggers_pending_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.state} = 'pending'`),
    index('shopping_agent_triggers_reclaim_idx')
      .on(t.leaseUntil)
      .where(sql`${t.state} = 'processing'`),
  ],
);

/**
 * `shopping_agent_evaluations` — the durable EVALUATION job, ONE row per agent
 * (#97 evaluation 1, 2).
 *
 * The second of the two durable jobs, and the one a manual run and a scheduled
 * sweep also write. It converges for the same reason the trigger queue does:
 * three products of a five-line agent moving in one minute owe ONE evaluation,
 * because an evaluation reads the WHOLE objective and its answer is a fixed
 * point rather than a message.
 *
 * `trigger_source` is the source of the most recent REQUEST and is carried onto
 * the finding, so "why did this run" is answerable without a second table.
 */
export const shoppingAgentEvaluations = pgTable(
  'shopping_agent_evaluations',
  {
    id: generatedId(),
    agentId: text()
      .notNull()
      .references(() => shoppingAgents.id, { onDelete: 'cascade' }),
    triggerSource: text({ enum: asEnumValues(SHOPPING_AGENT_TRIGGER_SOURCES) })
      .notNull()
      .default('offer_change'),
    state: text({ enum: SHOPPING_AGENT_QUEUE_STATES }).notNull().default('pending'),
    requestedRevision: integer().notNull().default(1),
    claimedRevision: integer(),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastFailure: text(),
    lastEvaluatedAt: timestamptz(),
    /** The last run's verdict — a NULL means no run has completed yet. */
    lastOutcome: text({ enum: asEnumValues(SHOPPING_AGENT_FINDING_OUTCOMES) }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('shopping_agent_evaluations_state_check', t.state, SHOPPING_AGENT_QUEUE_STATES),
    checkOneOf(
      'shopping_agent_evaluations_trigger_source_check',
      t.triggerSource,
      SHOPPING_AGENT_TRIGGER_SOURCES,
    ),
    checkOneOf(
      'shopping_agent_evaluations_outcome_check',
      t.lastOutcome,
      SHOPPING_AGENT_FINDING_OUTCOMES,
    ),
    check('shopping_agent_evaluations_attempts_check', sql`${t.attempts} >= 0`),
    check('shopping_agent_evaluations_revision_check', sql`${t.requestedRevision} >= 1`),
    check(
      'shopping_agent_evaluations_claimed_revision_check',
      sql`${t.claimedRevision} is null or ${t.claimedRevision} <= ${t.requestedRevision}`,
    ),
    uniqueIndex('shopping_agent_evaluations_agent_key').on(t.agentId),
    index('shopping_agent_evaluations_pending_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.state} = 'pending'`),
    index('shopping_agent_evaluations_reclaim_idx')
      .on(t.leaseUntil)
      .where(sql`${t.state} = 'processing'`),
  ],
);

/**
 * `shopping_agent_findings` — one appended observation (#97 §"AgentFinding
 * model").
 *
 * `shopping_agent_findings_identity_key` is `(agent_id, evaluation_key)` and the
 * key is `shoppingAgentEvaluationKey`'s four facts: the agent, its REVISION,
 * the deterministic INPUT DIGEST and the policy version. No clock, deliberately
 * — #79 records what each direction costs, and #96's `BasketInputSnapshot.digest`
 * is the same "version of everything we read" one layer up.
 *
 * `input_digest` is NOT NULL, which is why an evaluation that could not reach
 * the solver at all still writes a digest over the inputs it DID read rather
 * than a NULL: Postgres treats NULLs as distinct in a unique index, so a NULL
 * there would mint a new row on every sweep — the same defect the missing
 * observed-price version is on #79's side.
 */
export const shoppingAgentFindings = pgTable(
  'shopping_agent_findings',
  {
    id: generatedId(),
    /** CASCADE: a shopper's deleted agent takes its own history with it. */
    agentId: text()
      .notNull()
      .references(() => shoppingAgents.id, { onDelete: 'cascade' }),
    evaluationKey: text().notNull(),
    /** The revision the key was built from, stored so a trace need not parse it. */
    agentRevision: integer().notNull(),
    triggerSource: text({ enum: asEnumValues(SHOPPING_AGENT_TRIGGER_SOURCES) }).notNull(),
    triggeredAt: timestamptz().notNull(),
    evaluatedAt: timestamptz().notNull(),

    outcome: text({ enum: asEnumValues(SHOPPING_AGENT_FINDING_OUTCOMES) }).notNull(),
    incompleteReasons: text({ enum: asEnumValues(SHOPPING_AGENT_INCOMPLETE_REASONS) })
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    completeness: text({ enum: asEnumValues(SHOPPING_AGENT_EVIDENCE_COMPLETENESS) }).notNull(),
    freshness: text({ enum: asEnumValues(SHOPPING_AGENT_FRESHNESS) }).notNull(),
    /** Absent when no plan was solved — a constraint-only evaluation, say. */
    optimality: text({ enum: asEnumValues(SHOPPING_AGENT_OPTIMALITIES) }),
    lifecycle: text({ enum: asEnumValues(SHOPPING_AGENT_FINDING_LIFECYCLES) })
      .notNull()
      .default('current'),

    /** #96's digest over the request, the candidates, their prices and the rates. */
    inputDigest: text().notNull(),
    agentPolicyVersion: text().notNull(),
    constraintEvaluationVersion: text().notNull(),
    normalizationRuleVersion: text().notNull(),
    comparisonPolicyVersion: text().notNull(),
    /**
     * Empty when no comparison ran, and NEVER NULL — "no comparison ran" is a
     * real state and a NULL would make it indistinguishable from a column
     * nobody filled.
     *
     * There is deliberately no DEFAULT: migration `0005` dropped every
     * empty-string default in this schema and `schema.realdb.test.ts` refuses a
     * new one, for the reason that matters here — a default makes a writer that
     * FORGOT the version indistinguishable from one that had none to give, and
     * this column is what makes a finding reproducible.
     */
    rankingPolicyVersion: text().notNull(),

    satisfiedConstraintIds: text().array().notNull().default(sql`'{}'::text[]`),
    failedConstraintIds: text().array().notNull().default(sql`'{}'::text[]`),
    unknownConstraintIds: text().array().notNull().default(sql`'{}'::text[]`),

    /** Present only on a `qualified` finding — a CHECK, not a convention. */
    ...optionalMoney('objective'),
    /** The move against the prior comparable finding. Negative is cheaper. */
    objectiveDeltaAmount: bigint({ mode: 'number' }),

    /**
     * #96's citation table for this finding, verbatim.
     *
     * The SECOND and last jsonb in the domain, and it earns it for one reason:
     * a generated summary may cite only refs THIS finding minted, so the
     * validator needs the exact set that was minted at evaluation time. A child
     * table would work and would cost a join on a read nobody paginates; the
     * deciding argument is that these are opaque per-finding handles rather than
     * entities, so nothing will ever query them by content.
     */
    recordRefs: jsonb().$type<readonly ShoppingAgentRecordRef[]>().notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    ...currencyChecks('shopping_agent_findings', [t.objectiveCurrency]),
    checkOneOf('shopping_agent_findings_outcome_check', t.outcome, SHOPPING_AGENT_FINDING_OUTCOMES),
    checkOneOf(
      'shopping_agent_findings_trigger_source_check',
      t.triggerSource,
      SHOPPING_AGENT_TRIGGER_SOURCES,
    ),
    checkOneOf(
      'shopping_agent_findings_completeness_check',
      t.completeness,
      SHOPPING_AGENT_EVIDENCE_COMPLETENESS,
    ),
    checkOneOf('shopping_agent_findings_freshness_check', t.freshness, SHOPPING_AGENT_FRESHNESS),
    checkOneOf('shopping_agent_findings_optimality_check', t.optimality, SHOPPING_AGENT_OPTIMALITIES),
    checkOneOf(
      'shopping_agent_findings_lifecycle_check',
      t.lifecycle,
      SHOPPING_AGENT_FINDING_LIFECYCLES,
    ),
    checkEveryElementOf(
      'shopping_agent_findings_incomplete_reasons_check',
      t.incompleteReasons,
      SHOPPING_AGENT_INCOMPLETE_REASONS,
    ),
    check('shopping_agent_findings_revision_check', sql`${t.agentRevision} >= 1`),
    check('shopping_agent_findings_digest_check', sql`length(${t.inputDigest}) >= 8`),
    /**
     * The three-valued outcome, made structural.
     *
     * `incomplete` carries at least one reason and NO objective value;
     * `qualified` carries a value and no reason. That is #97 evaluation 6
     * ("missing or stale data produces an incomplete result, not a positive
     * finding") and acceptance 5, at the row — so no service bug, replay or
     * `psql` session can store a positive finding built on a gap.
     */
    check(
      'shopping_agent_findings_incomplete_shape_check',
      sql`(${t.outcome} = 'incomplete') = (cardinality(${t.incompleteReasons}) >= 1)`,
    ),
    check(
      'shopping_agent_findings_objective_shape_check',
      sql`${t.outcome} = 'qualified' or ${t.objectiveAmount} is null`,
    ),
    /** A delta is a move of a value, so it cannot exist without one. */
    check(
      'shopping_agent_findings_delta_shape_check',
      sql`${t.objectiveDeltaAmount} is null or ${t.objectiveAmount} is not null`,
    ),
    /** An incomplete finding cannot claim complete evidence. */
    check(
      'shopping_agent_findings_evidence_shape_check',
      sql`${t.outcome} <> 'incomplete' or ${t.completeness} = 'partial'`,
    ),
    /** Issue evaluation 2, the whole of it. See the table docblock. */
    uniqueIndex('shopping_agent_findings_identity_key').on(t.agentId, t.evaluationKey),
    index('shopping_agent_findings_agent_idx').on(t.agentId, t.createdAt.desc()),
    /** The prior-comparable read: the newest qualified finding for one agent. */
    index('shopping_agent_findings_qualified_idx')
      .on(t.agentId, t.createdAt.desc())
      .where(sql`${t.outcome} = 'qualified'`),
  ],
);

/**
 * `shopping_agent_finding_lines` — what the plan behind a finding selected.
 *
 * A child TABLE and not a jsonb array: every column here is a typed fact a
 * surface renders and a test asserts — an amount with its currency, a #90
 * condition segment, and the two booleans #97 notification 4 asks a shopper to
 * be told apart ("native, external, official, used, nearby or mixed"). The
 * analytics precedent is the argument: an open bag is the one mechanism by
 * which something nobody declared reaches production.
 */
export const shoppingAgentFindingLines = pgTable(
  'shopping_agent_finding_lines',
  {
    id: generatedId(),
    findingId: text()
      .notNull()
      .references(() => shoppingAgentFindings.id, { onDelete: 'cascade' }),
    /** The agent LINE this covers. No FK — a line may be edited away afterwards. */
    lineId: text().notNull(),
    /**
     * RESTRICT: the finding is the record of what was observed about this
     * product, and a merge REPOINTS it rather than deleting it.
     */
    canonicalProductId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    /** #96's opaque per-finding handle for the offer, resolvable in `record_refs`. */
    offerRef: text().notNull(),
    quantity: integer().notNull(),
    ...optionalMoney('unitItemPrice'),
    conditionGroup: text({ enum: asEnumValues(CONDITION_GROUPS) }),
    /** #97 notification 4 — a native purchase and an external hop are different. */
    nativeCheckoutEligible: boolean().notNull(),
    /** #55's verified standing, snapshotted: a badge can lapse after a finding. */
    officialChannel: boolean().notNull(),
    position: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    ...currencyChecks('shopping_agent_finding_lines', [t.unitItemPriceCurrency]),
    checkOneOf(
      'shopping_agent_finding_lines_condition_group_check',
      t.conditionGroup,
      CONDITION_GROUPS,
    ),
    check('shopping_agent_finding_lines_quantity_check', sql`${t.quantity} >= 1`),
    check('shopping_agent_finding_lines_position_check', sql`${t.position} >= 0`),
    uniqueIndex('shopping_agent_finding_lines_position_key').on(t.findingId, t.position),
    index('shopping_agent_finding_lines_product_idx').on(t.canonicalProductId),
  ],
);

/**
 * `shopping_agent_notifications` — the durable DELIVERY job (#97 evaluation 1,
 * notification 9, acceptance 2).
 *
 * ### Separate from evaluation, and the consequence that matters is the reverse
 *
 * A delivery retried a hundred times re-reads THIS row and never the
 * catalogue, so "a notification retry never re-runs an evaluation and never
 * creates a second finding" is a property of the call graph rather than a rule
 * somebody follows. `shopping-agent-isolation.test.ts` asserts the delivery
 * modules import nothing that evaluates.
 *
 * ### The id is DETERMINISTIC and there is no default
 *
 * Derived from the finding and the channel, so a repeat converges on the same
 * row rather than queueing a second message about one piece of news.
 *
 * ### A withheld notification leaves a ROW
 *
 * `suppressed` is terminal and carries a coded reason. #97 cost rule 6 asks for
 * duplicate suppression to be MONITORED, and a table of messages that were sent
 * can never answer how many were not.
 */
export const shoppingAgentNotifications = pgTable(
  'shopping_agent_notifications',
  {
    /** DETERMINISTIC, caller-supplied — deliberately no default. */
    id: text().primaryKey(),
    findingId: text()
      .notNull()
      .references(() => shoppingAgentFindings.id, { onDelete: 'cascade' }),
    /** Denormalized so the dispatcher's reads never join to find the owner. */
    agentId: text()
      .notNull()
      .references(() => shoppingAgents.id, { onDelete: 'cascade' }),
    channel: text({ enum: asEnumValues(SHOPPING_AGENT_NOTIFICATION_CHANNELS) }).notNull(),
    state: text({ enum: asEnumValues(SHOPPING_AGENT_NOTIFICATION_STATES) })
      .notNull()
      .default('queued'),
    suppressionReason: text({ enum: asEnumValues(SHOPPING_AGENT_SUPPRESSION_REASONS) }),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    failureReason: text({ enum: asEnumValues(SHOPPING_AGENT_DELIVERY_FAILURES) }),
    deliveredAt: timestamptz(),
    /**
     * The `notifications` row this produced, and the ONLY way "was it opened"
     * is answered. SET NULL rather than CASCADE: the retention sweep reaps a
     * dismissed feed entry and the delivery RECORD outlives it — #97
     * notification 9 asks that delivery and open outcomes be recorded
     * separately from evaluation, and losing the first to a retention rule
     * about the second would make that unanswerable.
     */
    notificationId: text().references(() => notifications.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'shopping_agent_notifications_channel_check',
      t.channel,
      SHOPPING_AGENT_NOTIFICATION_CHANNELS,
    ),
    checkOneOf(
      'shopping_agent_notifications_state_check',
      t.state,
      SHOPPING_AGENT_NOTIFICATION_STATES,
    ),
    checkOneOf(
      'shopping_agent_notifications_suppression_reason_check',
      t.suppressionReason,
      SHOPPING_AGENT_SUPPRESSION_REASONS,
    ),
    checkOneOf(
      'shopping_agent_notifications_failure_reason_check',
      t.failureReason,
      SHOPPING_AGENT_DELIVERY_FAILURES,
    ),
    check('shopping_agent_notifications_attempts_check', sql`${t.attempts} >= 0`),
    check(
      'shopping_agent_notifications_delivered_at_check',
      sql`(${t.state} = 'delivered') = (${t.deliveredAt} is not null)`,
    ),
    check(
      'shopping_agent_notifications_suppression_check',
      sql`(${t.state} = 'suppressed') = (${t.suppressionReason} is not null)`,
    ),
    check(
      'shopping_agent_notifications_notification_id_check',
      sql`${t.notificationId} is null or ${t.state} = 'delivered'`,
    ),
    index('shopping_agent_notifications_pending_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.state} in ('queued', 'failed')`),
    index('shopping_agent_notifications_reclaim_idx')
      .on(t.leaseUntil)
      .where(sql`${t.state} = 'delivering'`),
    index('shopping_agent_notifications_finding_idx').on(t.findingId),
    index('shopping_agent_notifications_agent_idx').on(t.agentId, t.createdAt.desc()),
  ],
);

/**
 * `shopping_agent_audits` — creation, material edits, authorization changes and
 * deletion (#97 privacy 7).
 *
 * Append-only against UPDATE by trigger; DELETE is permitted so a scoped
 * erasure of one account's agents actually erases. `actor` has exactly two
 * members and no third may be added: everything here is either something the
 * OWNER did or something the SYSTEM did on their behalf, and an operator is
 * neither — there is no operator route that can write a row in this domain.
 */
export const shoppingAgentAudits = pgTable(
  'shopping_agent_audits',
  {
    id: generatedId(),
    agentId: text()
      .notNull()
      .references(() => shoppingAgents.id, { onDelete: 'cascade' }),
    action: text({ enum: asEnumValues(SHOPPING_AGENT_AUDIT_ACTIONS) }).notNull(),
    actor: text({ enum: asEnumValues(SHOPPING_AGENT_AUDIT_ACTORS) }).notNull(),
    /** The Oxy account that acted. Present for `owner` and absent for `system`. */
    actorOxyUserId: text(),
    /** The agent revision at the moment of the act. */
    agentRevision: integer().notNull(),
    /** A BOUNDED code or short phrase — never a shopper's own words. */
    detail: text(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('shopping_agent_audits_action_check', t.action, SHOPPING_AGENT_AUDIT_ACTIONS),
    checkOneOf('shopping_agent_audits_actor_check', t.actor, SHOPPING_AGENT_AUDIT_ACTORS),
    check('shopping_agent_audits_revision_check', sql`${t.agentRevision} >= 1`),
    check(
      'shopping_agent_audits_detail_check',
      sql`${t.detail} is null or length(${t.detail}) <= 200`,
    ),
    /**
     * An `owner` act names the account; a `system` act names none.
     *
     * A biconditional rather than a one-way implication, because a system act
     * carrying an account id would read as somebody having done it.
     */
    check(
      'shopping_agent_audits_actor_shape_check',
      sql`(${t.actor} = 'owner') = (${t.actorOxyUserId} is not null)`,
    ),
    index('shopping_agent_audits_agent_idx').on(t.agentId, t.createdAt.desc()),
  ],
);
