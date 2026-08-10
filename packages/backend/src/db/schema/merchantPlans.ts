/**
 * Merchant plans, entitlements and subscription billing (#89) — nine tables,
 * none of which has a source model.
 *
 * `merchant_plans` + `merchant_plan_prices` (versioned commercial policy),
 * `entitlement_definitions` + `plan_entitlements` (what a capability IS and
 * which version grants it), `billing_customers` + `merchant_subscriptions` +
 * `merchant_subscription_events` (the billing relationship and its audit
 * trail), `entitlement_grants` (capabilities given outside a plan) and
 * `entitlement_usage_counters` (the transactionally safe half of a limit).
 *
 * ## Versioning is the `fee_schedules` mechanism, not a second one
 *
 * A plan VERSION is editable only while `draft`. From `active` onward every
 * commercial column is frozen by the `merchant_plans_immutable_once_active`
 * trigger, and `merchant_plans_one_active_per_key` makes "the active version of
 * this plan" a single row rather than a query with a bug. That is what makes a
 * merchant's entitlements SNAPSHOTTED without copying them anywhere: the
 * subscription names a plan VERSION by foreign key, and the version cannot
 * change, so a policy change is a new version somebody has to be moved onto.
 *
 * There is a SECOND partial unique the fee domain has no counterpart for —
 * `merchant_plans_one_active_free_plan`, at most one active `free` version in
 * the whole database. A store with no subscription resolves against "the active
 * free plan", and with two of them that phrase names nothing.
 *
 * ## A capability that must stay free has no key to be gated by
 *
 * `entitlement_definitions.capability_key` is CHECKed against
 * `MERCHANT_ENTITLEMENT_CAPABILITIES`, which is DISJOINT from
 * `MERCHANT_UNGATEABLE_CAPABILITIES` (a shared-types test). So
 * `order_management`, `refund_issuance`, `financial_record_access` and
 * `data_export` have no row shape here at all — the guarantee that they cannot
 * become paid-only is the absence of a value, not a rule in a service.
 *
 * ## `limit_kind` is denormalized, and a COMPOSITE foreign key is what makes
 * that safe
 *
 * `plan_entitlements` and `entitlement_grants` both carry `limit_kind` beside
 * their `capability_key`, pointing at `UNIQUE(capability_key, limit_kind)` on
 * the definition — the `match_category_gates` device (#58). Without the copy the
 * "a `flag` carries no number" rule would be a cross-table condition no CHECK
 * can express; with it the rule is intra-row and real, and the composite key
 * makes the copy provably equal to the definition's own value. The definition's
 * `limit_kind` is frozen by trigger, so the target never moves under it.
 *
 * ## The billing customer is a DIFFERENT table from the connected account
 *
 * Acceptance 2: "Connect account and subscription billing customer cannot be
 * confused or cross-linked accidentally." `billing_customers` has no foreign
 * key to `provider_accounts`, no column that could hold a connected-account id,
 * and no shared key space — a Connect account is `acct_…` on Mercaria's
 * platform and a billing customer is `cus_…` under it. The two domains do not
 * import each other either, which `merchant-plan-isolation.test.ts` fails the
 * build over.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  BILLING_INTERVALS,
  BILLING_PROVIDER_IDS,
  ENTITLEMENT_AVAILABILITIES,
  ENTITLEMENT_ENFORCEMENT_POINTS,
  ENTITLEMENT_GRANT_REASONS,
  ENTITLEMENT_LIMIT_KINDS,
  MERCHANT_ENTITLEMENT_CAPABILITIES,
  MERCHANT_PLAN_STATUSES,
  MERCHANT_PLAN_TIERS,
  MERCHANT_SUBSCRIPTION_EVENT_KINDS,
  MERCHANT_SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_CANCELLATION_BEHAVIORS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, money, optionalMoney } from './columns';
import { ledgerTransactions } from './ledger';
import { stores } from './stores';

/**
 * `merchant_plans` — one VERSION of one commercial plan.
 *
 * `(plan_key, version)` is the public name a subscription, an invoice and every
 * audit row refer to; the uuid primary key is what a foreign key points at, so
 * a subscription's plan cannot be reinterpreted by a later policy change.
 */
export const merchantPlans = pgTable(
  'merchant_plans',
  {
    id: generatedId(),
    /** The stable logical id shared by every version (`free`, `pro`). */
    planKey: text().notNull(),
    /** Monotonic per key, assigned by the operator creating the draft. */
    version: integer().notNull(),
    tier: text({ enum: asEnumValues(MERCHANT_PLAN_TIERS) }).notNull(),
    name: text().notNull(),
    /** The merchant-facing summary shown in the plan comparison. */
    summary: text().notNull(),
    /** The terms document version a merchant accepts when subscribing. */
    termsVersion: text().notNull(),
    /**
     * Free trial length in days, 0 for none.
     *
     * On the PLAN rather than on the subscription because it is policy, and
     * policy on an immutable version is what stops it changing under somebody
     * mid-trial. What lands on the subscription is the resulting DEADLINE.
     */
    trialDays: integer().notNull().default(0),
    /**
     * How long paid entitlements survive a failed payment — issue #89
     * entitlement rule 6, as a number on an immutable row.
     *
     * The subscription stores the resulting `grace_expires_at`, computed once
     * when the subscription goes `past_due`, so a later plan version cannot
     * retroactively shorten a grace somebody is already inside.
     */
    gracePeriodDays: integer().notNull().default(0),
    status: text({ enum: asEnumValues(MERCHANT_PLAN_STATUSES) }).notNull().default('draft'),
    /** The operator who drafted it — an Oxy account id, no foreign key. */
    createdByOxyUserId: text().notNull(),
    /** The operator who activated it — the audit half of "publish a new version". */
    approvedByOxyUserId: text(),
    activatedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('merchant_plans_status_check', t.status, MERCHANT_PLAN_STATUSES),
    checkOneOf('merchant_plans_tier_check', t.tier, MERCHANT_PLAN_TIERS),
    check('merchant_plans_version_check', sql`${t.version} >= 1`),
    check('merchant_plans_trial_days_check', sql`${t.trialDays} between 0 and 365`),
    check('merchant_plans_grace_period_days_check', sql`${t.gracePeriodDays} between 0 and 365`),
    // An active or superseded version carries its activation audit; nothing that
    // ever priced a merchant is anonymous.
    check(
      'merchant_plans_activation_audit_check',
      sql`${t.status} not in ('active', 'superseded')
          or (${t.approvedByOxyUserId} is not null and ${t.activatedAt} is not null)`,
    ),
    uniqueIndex('merchant_plans_key_version_key').on(t.planKey, t.version),
    // The structural half of "active versions are immutable; publish a new
    // version": at most one active row per key, so activation must supersede.
    uniqueIndex('merchant_plans_one_active_per_key')
      .on(t.planKey)
      .where(sql`${t.status} = 'active'`),
    // "The active free plan" has to name exactly one row, because it is what a
    // store with no subscription resolves against.
    uniqueIndex('merchant_plans_one_active_free_plan')
      .on(t.tier)
      .where(sql`${t.tier} = 'free' and ${t.status} = 'active'`),
  ],
);

/**
 * `merchant_plan_prices` — what one plan version costs, per currency, cadence
 * and provider MODE.
 *
 * Issue #89 billing rule 6: "Support plan and price ids by environment without
 * hardcoding them in clients." `livemode` is that environment, carried as a
 * column rather than an environment variable, so test-mode and live-mode price
 * ids for one version coexist and neither is a deployment-time string a client
 * could be shipped with. A client is never told a provider price id at all — it
 * asks the server to open a hosted session.
 */
export const merchantPlanPrices = pgTable(
  'merchant_plan_prices',
  {
    id: generatedId(),
    /**
     * `cascade`: a price exists only to price its version, and a draft version
     * being abandoned should take its prices with it. Nothing else points here.
     */
    planId: text()
      .notNull()
      .references(() => merchantPlans.id, { onDelete: 'cascade' }),
    provider: text({ enum: asEnumValues(BILLING_PROVIDER_IDS) }).notNull(),
    /** Whether this price id belongs to the provider's LIVE key space. */
    livemode: boolean().notNull(),
    interval: text({ enum: asEnumValues(BILLING_INTERVALS) }).notNull(),
    /** The recurring amount, in its own currency's minor units. */
    ...money('unitPrice'),
    /**
     * The provider's own price object id. A plain indexed column and never a
     * Mercaria key — their key space changes between test and live mode
     * (`CONVENTIONS.md`, the `provider_object_id` rule).
     */
    providerPriceId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('merchant_plan_prices_provider_check', t.provider, BILLING_PROVIDER_IDS),
    checkOneOf('merchant_plan_prices_interval_check', t.interval, BILLING_INTERVALS),
    ...currencyChecks('merchant_plan_prices', [t.unitPriceCurrency]),
    check('merchant_plan_prices_amount_check', sql`${t.unitPriceAmount} >= 0`),
    // One price per (version, provider, mode, cadence, currency): two rows would
    // make "the monthly EUR price of Pro v3" a question with two answers.
    uniqueIndex('merchant_plan_prices_scope_key').on(
      t.planId,
      t.provider,
      t.livemode,
      t.interval,
      t.unitPriceCurrency,
    ),
    index('merchant_plan_prices_provider_price_idx').on(t.provider, t.livemode, t.providerPriceId),
  ],
);

/**
 * `entitlement_definitions` — what a capability IS, once, for the whole
 * deployment.
 *
 * `capability_key` is the STABLE identifier controllers and jobs check (#89
 * entitlement rule 2: "Controllers and jobs check stable capability keys, not
 * plan names"), and it is unique so a plan entitlement, a grant and a usage
 * counter can all point at it. `name` and `description` are product COPY and are
 * deliberately not frozen — the #90 rule that stored KEYS are what stay stable
 * while labels may be rewritten.
 *
 * `limit_kind` and `enforcement_point` ARE frozen, by
 * `entitlement_definitions_immutable_contract`: they are the shape every plan
 * entitlement and every grant was written against, and changing one would
 * silently reinterpret rows that already exist.
 */
export const entitlementDefinitions = pgTable(
  'entitlement_definitions',
  {
    id: generatedId(),
    capabilityKey: text({ enum: asEnumValues(MERCHANT_ENTITLEMENT_CAPABILITIES) }).notNull(),
    name: text().notNull(),
    description: text().notNull(),
    limitKind: text({ enum: asEnumValues(ENTITLEMENT_LIMIT_KINDS) }).notNull(),
    /**
     * Where the capability may be enforced. ONE possible value, deliberately —
     * see `ENTITLEMENT_ENFORCEMENT_POINTS`. A capability that gated READING or
     * EXPORTING what a merchant already has cannot be defined.
     */
    enforcementPoint: text({ enum: asEnumValues(ENTITLEMENT_ENFORCEMENT_POINTS) })
      .notNull()
      .default('create_or_extend'),
    availability: text({ enum: asEnumValues(ENTITLEMENT_AVAILABILITIES) })
      .notNull()
      .default('postponed'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'entitlement_definitions_capability_key_check',
      t.capabilityKey,
      MERCHANT_ENTITLEMENT_CAPABILITIES,
    ),
    checkOneOf('entitlement_definitions_limit_kind_check', t.limitKind, ENTITLEMENT_LIMIT_KINDS),
    checkOneOf(
      'entitlement_definitions_enforcement_point_check',
      t.enforcementPoint,
      ENTITLEMENT_ENFORCEMENT_POINTS,
    ),
    checkOneOf(
      'entitlement_definitions_availability_check',
      t.availability,
      ENTITLEMENT_AVAILABILITIES,
    ),
    // `unique()` and NOT `uniqueIndex()`, twice: both are foreign-key TARGETS,
    // and drizzle-kit emits every `ADD CONSTRAINT … FOREIGN KEY` before every
    // `CREATE UNIQUE INDEX`, so a key targeting an index fails at apply time
    // with 42830 (`~/Oxy/AGENTS.md`). An inline `unique()` lands in the
    // `CREATE TABLE` and already exists when the keys are added.
    unique('entitlement_definitions_capability_key_unique').on(t.capabilityKey),
    unique('entitlement_definitions_capability_limit_kind_unique').on(t.capabilityKey, t.limitKind),
  ],
);

/**
 * `plan_entitlements` — which capabilities one plan VERSION grants, and the
 * limit that version sets.
 *
 * A NULL `limit_value` on a quantified kind means UNLIMITED; on a `flag` it
 * means nothing at all, which the CHECK enforces by refusing a number there.
 * Note the CHECK is one-directional on purpose: "unlimited" has to stay
 * representable, so NULL is legal for every kind and only a flag is forbidden a
 * value.
 */
export const planEntitlements = pgTable(
  'plan_entitlements',
  {
    id: generatedId(),
    planId: text()
      .notNull()
      .references(() => merchantPlans.id, { onDelete: 'cascade' }),
    capabilityKey: text({ enum: asEnumValues(MERCHANT_ENTITLEMENT_CAPABILITIES) }).notNull(),
    /** Denormalized from the definition and tied to it by the composite key below. */
    limitKind: text({ enum: asEnumValues(ENTITLEMENT_LIMIT_KINDS) }).notNull(),
    /** NULL = unlimited (quantified kinds) and unrepresentable (a `flag`). */
    limitValue: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'plan_entitlements_capability_key_check',
      t.capabilityKey,
      MERCHANT_ENTITLEMENT_CAPABILITIES,
    ),
    checkOneOf('plan_entitlements_limit_kind_check', t.limitKind, ENTITLEMENT_LIMIT_KINDS),
    check(
      'plan_entitlements_flag_has_no_limit_check',
      sql`${t.limitKind} <> 'flag' or ${t.limitValue} is null`,
    ),
    check(
      'plan_entitlements_limit_value_check',
      sql`${t.limitValue} is null or ${t.limitValue} >= 0`,
    ),
    uniqueIndex('plan_entitlements_plan_capability_key').on(t.planId, t.capabilityKey),
    // The composite key that makes the denormalized `limit_kind` provably the
    // definition's own. `restrict`: a definition whose plans still reference it
    // is not deletable, which is right — the plans were written against it.
    foreignKey({
      name: 'plan_entitlements_capability_fk',
      columns: [t.capabilityKey, t.limitKind],
      foreignColumns: [entitlementDefinitions.capabilityKey, entitlementDefinitions.limitKind],
    }).onDelete('restrict'),
  ],
);

/**
 * `merchant_plan_acceptances` — an authorized owner accepted one plan version's
 * terms, once (#89 domain model item 9).
 *
 * `fee_schedule_acceptances` one domain over, and it exists as a TABLE rather
 * than three columns on the subscription for a reason that is entirely about
 * ORDER: a merchant agrees to the terms BEFORE they are sent to a hosted
 * checkout, and the subscription row cannot exist until the rail has created one
 * and told Mercaria about it. Without this row there would be nothing holding
 * the acceptance across that gap, and the alternatives are worse — putting an
 * Oxy account id into provider metadata, or letting a subscription exist with no
 * recorded consent.
 *
 * It is what makes the fail-closed rule real: a subscription arriving from the
 * rail with NO acceptance on file for its plan is not recorded at all, and the
 * event says so. Mercaria does not write down a paid plan nobody agreed to.
 *
 * Append-only (trigger): re-accepting the same version converges on the existing
 * row through the unique index rather than rewriting the audit trail.
 */
export const merchantPlanAcceptances = pgTable(
  'merchant_plan_acceptances',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    /** The plan by NAME, like an order line's frozen title — see the fee domain. */
    planKey: text().notNull(),
    planVersion: integer().notNull(),
    /**
     * The terms version the owner actually saw, denormalized from the plan at
     * acceptance time: the acceptance must state what was agreed even when read
     * apart from the plan row.
     */
    termsVersion: text().notNull(),
    /** The store member who accepted — `store:manage`, checked at the route. */
    acceptedByOxyUserId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('merchant_plan_acceptances_version_check', sql`${t.planVersion} >= 1`),
    uniqueIndex('merchant_plan_acceptances_store_version_key').on(
      t.storeId,
      t.planKey,
      t.planVersion,
    ),
    index('merchant_plan_acceptances_store_created_at_idx').on(t.storeId, t.createdAt),
  ],
);

/**
 * `billing_customers` — the platform-side customer a store's subscription is
 * charged to.
 *
 * Deliberately NOT on `provider_accounts`, and deliberately without a foreign
 * key to it. A Connect account and a billing customer are two objects in two
 * key spaces that mean opposite things — one is a seller Mercaria PAYS, the
 * other is a merchant Mercaria CHARGES — and acceptance 2 asks that they cannot
 * be confused. Two tables with no relation between them is how.
 */
export const billingCustomers = pgTable(
  'billing_customers',
  {
    id: generatedId(),
    /**
     * `restrict`: a billing customer without its store is an unexplained
     * commercial relationship, and nothing deletes a store.
     */
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    provider: text({ enum: asEnumValues(BILLING_PROVIDER_IDS) }).notNull(),
    livemode: boolean().notNull(),
    /** The provider's own customer id. A plain column; never a Mercaria key. */
    providerCustomerId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('billing_customers_provider_check', t.provider, BILLING_PROVIDER_IDS),
    // One customer per store per rail per mode — the outer half of the
    // idempotency key the adapter derives from the OWNER (#46's reasoning: a
    // Mercaria row can be deduplicated afterwards, a provider CUSTOMER cannot be
    // un-created, so the key must not depend on a freshly-minted row id).
    uniqueIndex('billing_customers_store_scope_key').on(t.provider, t.livemode, t.storeId),
    // And the reverse: one Mercaria store per provider customer.
    uniqueIndex('billing_customers_provider_customer_key').on(
      t.provider,
      t.livemode,
      t.providerCustomerId,
    ),
  ],
);

/**
 * `merchant_subscriptions` — one store's paid relationship with a plan version.
 *
 * A row exists ONLY for a billing relationship: the provider trio is NOT NULL,
 * so a partnership with no charge cannot be recorded here (it is an
 * `entitlement_grants` row) and a free store simply has no subscription. That is
 * what makes `subscription is null` mean "free", unambiguously, everywhere.
 *
 * One row per store, reused across cancellations and re-subscriptions, with
 * `merchant_subscription_events` carrying the history — because "what happened
 * to this merchant's billing" should be one chain to read, not a set of rows
 * whose ordering somebody has to reconstruct.
 *
 * The acceptance triple is NOT NULL: issue #89 domain model item 9 is "terms
 * version and authorized acceptance", and a subscription nobody agreed to is
 * not a state this table should be able to hold.
 */
export const merchantSubscriptions = pgTable(
  'merchant_subscriptions',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    /**
     * The plan VERSION whose entitlements apply. `restrict`, and the version is
     * immutable — together they ARE the entitlement snapshot, with nothing
     * copied and therefore nothing that can disagree.
     */
    planId: text()
      .notNull()
      .references(() => merchantPlans.id, { onDelete: 'restrict' }),
    billingCustomerId: text()
      .notNull()
      .references(() => billingCustomers.id, { onDelete: 'restrict' }),
    provider: text({ enum: asEnumValues(BILLING_PROVIDER_IDS) }).notNull(),
    livemode: boolean().notNull(),
    /** The provider's own subscription id. A plain column; never a Mercaria key. */
    providerSubscriptionId: text().notNull(),
    status: text({ enum: asEnumValues(MERCHANT_SUBSCRIPTION_STATUSES) }).notNull(),
    interval: text({ enum: asEnumValues(BILLING_INTERVALS) }).notNull(),
    currentPeriodStart: timestamptz(),
    currentPeriodEnd: timestamptz(),
    trialEndsAt: timestamptz(),
    /**
     * When paid entitlements stop, for a subscription whose payment failed.
     *
     * Computed ONCE from the plan version's `grace_period_days` at the moment
     * the subscription went `past_due`, and stored — so a plan change cannot
     * shorten a grace already running, and the resolver reads a deadline rather
     * than recomputing a policy.
     */
    graceExpiresAt: timestamptz(),
    cancellationBehavior: text({ enum: asEnumValues(SUBSCRIPTION_CANCELLATION_BEHAVIORS) }),
    /** When the cancellation takes effect. Present exactly with the behaviour. */
    cancelAt: timestamptz(),
    cancelledAt: timestamptz(),
    endedAt: timestamptz(),
    /** The terms version the merchant actually agreed to, denormalized. */
    acceptedTermsVersion: text().notNull(),
    acceptedByOxyUserId: text().notNull(),
    acceptedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('merchant_subscriptions_provider_check', t.provider, BILLING_PROVIDER_IDS),
    checkOneOf('merchant_subscriptions_status_check', t.status, MERCHANT_SUBSCRIPTION_STATUSES),
    checkOneOf('merchant_subscriptions_interval_check', t.interval, BILLING_INTERVALS),
    checkOneOf(
      'merchant_subscriptions_cancellation_behavior_check',
      t.cancellationBehavior,
      SUBSCRIPTION_CANCELLATION_BEHAVIORS,
    ),
    // A `past_due` with no deadline either never expires or expires immediately
    // depending on which reader you ask — the exact shape of a control that
    // cannot be told from its own absence.
    check(
      'merchant_subscriptions_grace_deadline_check',
      sql`${t.status} <> 'past_due' or ${t.graceExpiresAt} is not null`,
    ),
    check(
      'merchant_subscriptions_cancellation_complete_check',
      sql`num_nonnulls(${t.cancellationBehavior}, ${t.cancelAt}) in (0, 2)`,
    ),
    check(
      'merchant_subscriptions_period_order_check',
      sql`${t.currentPeriodStart} is null
          or ${t.currentPeriodEnd} is null
          or ${t.currentPeriodEnd} > ${t.currentPeriodStart}`,
    ),
    // One subscription per store, reused — see the table docblock.
    uniqueIndex('merchant_subscriptions_store_key').on(t.storeId),
    uniqueIndex('merchant_subscriptions_provider_subscription_key').on(
      t.provider,
      t.livemode,
      t.providerSubscriptionId,
    ),
    // The reconciliation sweep's cursor: everything still billing, oldest first.
    index('merchant_subscriptions_status_updated_at_idx').on(t.status, t.updatedAt),
    // The grace sweep: which past-due subscriptions have run out of grace.
    index('merchant_subscriptions_grace_expires_at_idx')
      .on(t.graceExpiresAt)
      .where(sql`${t.graceExpiresAt} is not null`),
  ],
);

/**
 * `merchant_subscription_events` — the append-only audit trail (#89 domain model
 * item 10).
 *
 * Refuses UPDATE and DELETE by trigger, like `order_fee_snapshots` and the
 * ledger, and for the same reason: it is the record of what a merchant was
 * charged and what they were entitled to at the time.
 *
 * `provider_event_id` carries a PARTIAL unique, which is the second layer of
 * acceptance 3. The first is `payment_provider_events`' own dedupe, which stops
 * a REDELIVERY being stored twice; this one stops a REPLAY — the operator surface
 * can re-run a processed event deliberately — from booking a second ledger
 * transaction or double-applying a state change.
 */
export const merchantSubscriptionEvents = pgTable(
  'merchant_subscription_events',
  {
    id: generatedId(),
    subscriptionId: text()
      .notNull()
      .references(() => merchantSubscriptions.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(MERCHANT_SUBSCRIPTION_EVENT_KINDS) }).notNull(),
    fromStatus: text({ enum: asEnumValues(MERCHANT_SUBSCRIPTION_STATUSES) }),
    toStatus: text({ enum: asEnumValues(MERCHANT_SUBSCRIPTION_STATUSES) }),
    /** The plan version in force after this event, when the event moved one. */
    planId: text().references(() => merchantPlans.id, { onDelete: 'restrict' }),
    /** The Oxy account that acted. NULL for a provider-driven event. */
    actorOxyUserId: text(),
    /** The provider event this was applied from. NULL for a Mercaria-driven one. */
    providerEventId: text(),
    /** The provider's invoice object id, on an `invoice_paid` row. */
    providerInvoiceId: text(),
    /** What the invoice settled for, in the currency it settled in. */
    ...optionalMoney('amount'),
    /** The balanced posting this event booked, when it booked one. */
    ledgerTransactionId: text().references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    /** One line for a human reading the trail. Never a payload, never a secret. */
    note: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'merchant_subscription_events_kind_check',
      t.kind,
      MERCHANT_SUBSCRIPTION_EVENT_KINDS,
    ),
    checkOneOf(
      'merchant_subscription_events_from_status_check',
      t.fromStatus,
      MERCHANT_SUBSCRIPTION_STATUSES,
    ),
    checkOneOf(
      'merchant_subscription_events_to_status_check',
      t.toStatus,
      MERCHANT_SUBSCRIPTION_STATUSES,
    ),
    ...currencyChecks('merchant_subscription_events', [t.amountCurrency]),
    check(
      'merchant_subscription_events_amount_complete_check',
      sql`num_nonnulls(${t.amountAmount}, ${t.amountCurrency}) in (0, 2)`,
    ),
    // Only a settled invoice books anything. A ledger pointer on any other kind
    // would make the trail claim a movement its own kind does not describe.
    check(
      'merchant_subscription_events_ledger_kind_check',
      sql`${t.ledgerTransactionId} is null or ${t.kind} = 'invoice_paid'`,
    ),
    uniqueIndex('merchant_subscription_events_provider_event_key')
      .on(t.providerEventId)
      .where(sql`${t.providerEventId} is not null`),
    index('merchant_subscription_events_subscription_created_at_idx').on(
      t.subscriptionId,
      t.createdAt,
    ),
  ],
);

/**
 * `entitlement_grants` — a capability given outside a plan (#89 domain model
 * item 5).
 *
 * A grant only ADDS. There is no negative grant and none may be added: the
 * capabilities a free merchant relies on are ungateable by construction, so the
 * only thing a removing grant could take is something somebody is paying for —
 * and the honest way to do that is to change the plan.
 *
 * `grant_key` is a caller-supplied stable identifier, UNIQUE per store, so an
 * operator retry converges on one row instead of stacking grants. Several LIVE
 * grants on one capability are legitimate (a trial and then a partnership), and
 * the resolver takes the most generous — which is deterministic and needs no
 * unique index that `now()` could not be part of anyway.
 */
export const entitlementGrants = pgTable(
  'entitlement_grants',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    /** The caller's stable identifier for this grant — the idempotency handle. */
    grantKey: text().notNull(),
    capabilityKey: text({ enum: asEnumValues(MERCHANT_ENTITLEMENT_CAPABILITIES) }).notNull(),
    /** Denormalized from the definition, tied to it by the composite key. */
    limitKind: text({ enum: asEnumValues(ENTITLEMENT_LIMIT_KINDS) }).notNull(),
    limitValue: integer(),
    reason: text({ enum: asEnumValues(ENTITLEMENT_GRANT_REASONS) }).notNull(),
    /** Why, in words. Required: an unexplained grant is an unauditable one. */
    note: text().notNull(),
    grantedByOxyUserId: text().notNull(),
    startsAt: timestamptz().notNull(),
    /** NULL = open-ended, which only an operator exception should ever be. */
    expiresAt: timestamptz(),
    revokedAt: timestamptz(),
    revokedByOxyUserId: text(),
    revocationReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'entitlement_grants_capability_key_check',
      t.capabilityKey,
      MERCHANT_ENTITLEMENT_CAPABILITIES,
    ),
    checkOneOf('entitlement_grants_limit_kind_check', t.limitKind, ENTITLEMENT_LIMIT_KINDS),
    checkOneOf('entitlement_grants_reason_check', t.reason, ENTITLEMENT_GRANT_REASONS),
    check(
      'entitlement_grants_flag_has_no_limit_check',
      sql`${t.limitKind} <> 'flag' or ${t.limitValue} is null`,
    ),
    check(
      'entitlement_grants_limit_value_check',
      sql`${t.limitValue} is null or ${t.limitValue} >= 0`,
    ),
    check(
      'entitlement_grants_window_check',
      sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.startsAt}`,
    ),
    // A revocation is attributable, dated and explained, or it is not recorded.
    check(
      'entitlement_grants_revocation_complete_check',
      sql`num_nonnulls(${t.revokedAt}, ${t.revokedByOxyUserId}, ${t.revocationReason}) in (0, 3)`,
    ),
    uniqueIndex('entitlement_grants_store_key').on(t.storeId, t.grantKey),
    index('entitlement_grants_store_capability_idx').on(t.storeId, t.capabilityKey),
    // The same composite key `plan_entitlements` carries, for the same reason:
    // a grant's `limit_kind` is the definition's, provably.
    foreignKey({
      name: 'entitlement_grants_capability_fk',
      columns: [t.capabilityKey, t.limitKind],
      foreignColumns: [entitlementDefinitions.capabilityKey, entitlementDefinitions.limitKind],
    }).onDelete('restrict'),
  ],
);

/**
 * `entitlement_usage_counters` — the transactionally safe half of a limit (#89
 * entitlement rule 3).
 *
 * One row per (store, capability, period). `period_key` is the literal `total`
 * for a `total` limit and a `YYYY-MM` for a `per_period` one, so both kinds
 * share one table and one unique index without a nullable column that would
 * make two rows for one period possible.
 *
 * The LIMIT is deliberately not stored here. It lives on the plan version (which
 * is immutable) or on the grant, and copying it would create a second
 * representation of one fact — the failure this schema spends most of its
 * constraints preventing. What this table holds is the only thing a plan cannot:
 * how much has actually been used.
 */
export const entitlementUsageCounters = pgTable(
  'entitlement_usage_counters',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    capabilityKey: text({ enum: asEnumValues(MERCHANT_ENTITLEMENT_CAPABILITIES) })
      .notNull()
      .references(() => entitlementDefinitions.capabilityKey, { onDelete: 'restrict' }),
    /** `total`, or the `YYYY-MM` a `per_period` limit resets on. */
    periodKey: text().notNull(),
    /**
     * How much has been consumed. `bigint` for the same reason a money column
     * is: an API-call counter over years outgrows a signed `integer`, and the
     * failure would be a wrap rather than a refusal.
     */
    used: bigint({ mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'entitlement_usage_counters_capability_key_check',
      t.capabilityKey,
      MERCHANT_ENTITLEMENT_CAPABILITIES,
    ),
    check('entitlement_usage_counters_used_check', sql`${t.used} >= 0`),
    uniqueIndex('entitlement_usage_counters_scope_key').on(
      t.storeId,
      t.capabilityKey,
      t.periodKey,
    ),
  ],
);
