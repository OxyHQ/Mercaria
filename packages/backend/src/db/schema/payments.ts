/**
 * The payment domain: `provider_accounts`, `payments`, `payment_attempts`,
 * `payment_provider_events`, `transfers`, `payouts`, `payment_outboxes`.
 *
 * These tables replace the four fields `orders.payment_*` used to carry alone.
 * That subdocument had to be simultaneously a state machine, an audit trail, an
 * idempotency key and a provider reference, so it could be none of them well —
 * and it is why ADR 0001 makes the internal ledger (`./ledger`) land before any
 * real charge is created.
 *
 * ## The rules this file exists to hold
 *
 * **A provider's id is never a Mercaria primary key** (#45 invariant 4). Every
 * `provider_object_id` here is a plain, indexed, nullable column. A provider's
 * key space is not ours: it changes between test and live mode, it is absent
 * until the provider has answered, and two providers may mint the same string.
 *
 * **One payment per checkout group, for native rails** (ADR 0001 D4/D11). The
 * partial unique index below is what makes a retried checkout converge on the
 * existing payment instead of opening a second one — the same mechanism
 * `orders.idempotency_key` uses one level up, and the reason the payment domain
 * needs no idempotency table of its own.
 *
 * **Receipt is separate from processing.** A `payment_provider_events` row is
 * committed the moment a signature verifies (#48 builds the HTTP ingress on this
 * store); interpreting it is a later, retryable step. A provider that got a 200
 * has been told "stored", never "understood".
 *
 * ## Why the order correlations carry no foreign key
 *
 * `payments.order_id`, `transfers.order_id` and `ledger_entries.order_id` are
 * CORRELATION, not composition, and they are registered in
 * `db/deferredForeignKeys.ts` with that reason. Two things forced it. The first
 * — orders being served from MongoDB, where a constraint here would have
 * rejected every payment written for an order that genuinely existed — is gone:
 * orders are a Postgres write path in this same database now.
 *
 * The second was always the one that outlives it, and is why these stay
 * unconstrained: a financial record must be insertable and readable
 * independently of the commerce record it names (#45 invariant 12). Money that
 * moved is a fact Mercaria owes an answer about whether or not the order row is
 * reachable, and a payment that could not be written because a join partner was
 * missing is the one failure mode a payment system may not have.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_OUTBOX_EVENT_TYPES,
  PAYMENT_OUTBOX_STATUSES,
  PAYMENT_PROVIDER_IDS,
  PAYMENT_STATUSES,
  PAYOUT_STATUSES,
  PROVIDER_ACCOUNT_OWNER_TYPES,
  PROVIDER_CAPABILITY_STATUSES,
  PROVIDER_EVENT_STATUSES,
  PROVIDER_ONBOARDING_STATES,
  TRANSFER_STATUSES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, money, optionalMoney } from './columns';

/** Bound on a stored dispatch or processing error — the `.slice()` at every writer. */
const MAX_LAST_ERROR_LENGTH = 2_000;

/**
 * `provider_accounts` — one seller's standing with one payment rail.
 *
 * The record ADR 0001 D9 and issue #46 both call for, and the answer to "may
 * this seller's group be checked out" (D4). It exists as a TABLE rather than a
 * handful of columns on `stores` and `seller_profiles` for three reasons that
 * each rule out the scattered form on their own: the two owner kinds would need
 * the same six columns duplicated across two tables, a second rail (#51) would
 * need them again, and a payout event naming a connected account has exactly one
 * place to resolve it from.
 *
 * ## The owner is ONE polymorphic column, not a mutually-exclusive pair
 *
 * `orders` distinguishes its seller with `seller_type` plus two nullable id
 * columns and a CHECK holding them mutually exclusive, because an order joins to
 * `stores` for real and wants that foreign key. This table cannot: half its
 * owners are Oxy accounts, whose key space is not in this database at all
 * (`CONVENTIONS.md`, "there is no users table"), so the store half would be the
 * only constrained one and the pair would exist purely to be CHECKed.
 *
 * `ledger_entries` already carries this exact `owner_type` + `owner_id` pair for
 * exactly these two kinds, and this follows it. One column makes "two owners at
 * once" UNREPRESENTABLE rather than merely rejected, and it is what lets the
 * uniqueness below be the single index that actually matters here:
 * `UNIQUE(provider, owner_type, owner_id)` is the one thing standing between a
 * seller and attaching a second account, or someone else's (#46, security 3).
 * The pair form cannot express that constraint in one index at all.
 *
 * The store half gains no foreign key by the same argument the payment
 * correlations make: a provider account outlives the store record it names,
 * because money can still be owed to it, and a financial row that could not be
 * read because its join partner was deleted is the failure a payment system may
 * not have.
 *
 * ## `onboarding_state` is the ONLY verdict, and readiness is not a column
 *
 * ADR 0001 D9's conjunction — payouts enabled, transfers active, nothing due or
 * past due, not disabled — is evaluated when provider state is synchronised and
 * collapsed into `onboarding_state`. Storing a `ready` boolean beside it would
 * be two representations of one fact, and nothing in a schema can stop them
 * disagreeing; the checkout gate would then admit a seller because a flag was
 * stale. Everything else on this row EXPLAINS that verdict and is never
 * consulted to reach it a second time.
 *
 * ## Requirements are COUNTS, and that is a security property
 *
 * `requirement_collection = stripe` (D2) means the provider holds the identity
 * data and Mercaria holds none of it. Four integers and a deadline is what a
 * seller-facing surface can honestly use, and an integer column cannot hold
 * `individual.verification.document` — so the safe subset is structural here
 * rather than a rule someone has to remember at the write site. A `jsonb`
 * summary would have been the mechanical port of the provider's own object and
 * would have re-opened exactly that door; it would also not have earned `jsonb`
 * under `CONVENTIONS.md`, since the shape is Mercaria's own and closed.
 */
export const providerAccounts = pgTable(
  'provider_accounts',
  {
    id: generatedId(),
    provider: text({ enum: asEnumValues(PAYMENT_PROVIDER_IDS) }).notNull(),
    ownerType: text({ enum: asEnumValues(PROVIDER_ACCOUNT_OWNER_TYPES) }).notNull(),
    /** A store id or an Oxy account id — polymorphic by `owner_type`, no foreign key. */
    ownerId: text().notNull(),
    /**
     * The provider's own account reference (`acct_…`). Unique per provider,
     * indexed, and NEVER a Mercaria primary key — the same invariant every other
     * `provider_object_id` in this file carries (#45 invariant 4).
     *
     * It is also never accepted from a client. The only writer is the create
     * path, which reads it off the provider's own response to a call it made
     * itself; a request body able to carry one is the account-takeover surface
     * (#46, security 3).
     */
    providerAccountId: text().notNull(),
    /**
     * ISO-3166-1 alpha-2, as the account was created and immutable at the
     * provider afterwards. Validated against `config.payments.stripe.sellerCountries`
     * before creation (ADR 0001 D8) — the allow-list is configuration because the
     * transfer region is the provider's and changes on their schedule.
     */
    country: text().notNull(),
    /**
     * The account's own settlement currency, as the provider reports it.
     *
     * Deliberately NOT CHECKed against `ALL_CURRENCY_CODES` — the second such
     * exemption in this schema, for the same reason as `connections.shop_currency`
     * and registered beside it. Several EEA currencies a seller may legitimately
     * settle in (RON, CZK, HUF, BGN) are not in Mercaria's presentment set, and a
     * CHECK would fail the SYNC of a real account rather than the price. Nothing
     * in Mercaria prices against this value; it is shown to the seller.
     */
    defaultCurrency: text(),
    onboardingState: text({ enum: asEnumValues(PROVIDER_ONBOARDING_STATES) })
      .notNull()
      .default('not_connected'),
    /**
     * Whether the connected account may itself charge cards.
     *
     * Recorded because the provider reports it and an operator will ask, and
     * deliberately absent from the readiness conjunction: under separate charges
     * and transfers (D3) the connected account never charges anything, so this
     * being false does not stop the seller selling. ADR 0001 D9 says as much in
     * the readiness definition itself.
     */
    chargesEnabled: boolean().notNull().default(false),
    /** Whether the provider will pay this account out. Half of the D9 conjunction. */
    payoutsEnabled: boolean().notNull().default(false),
    /**
     * The `transfers` capability — the only one D2 requests. NULL means it was
     * never requested, which is a different fact from `inactive` (the provider
     * declining) and from `pending` (the provider working).
     */
    transfersCapability: text({ enum: asEnumValues(PROVIDER_CAPABILITY_STATUSES) }),
    /** Outstanding now. Non-zero means the seller has something to do. */
    requirementsCurrentlyDue: integer().notNull().default(0),
    /** Outstanding eventually — collected up front so payouts are never interrupted (D2). */
    requirementsEventuallyDue: integer().notNull().default(0),
    /** Overdue. Non-zero is what turns a working account `restricted`. */
    requirementsPastDue: integer().notNull().default(0),
    /** Submitted and being checked — nothing for the seller to do, hence `under_review`. */
    requirementsPendingVerification: integer().notNull().default(0),
    /** When the provider needs `currently_due` satisfied by, when it says. */
    requirementsDeadlineAt: timestamptz(),
    /**
     * Why the provider will not pay this account out, in its own codes, filtered
     * to those safe to show the account's owner.
     *
     * `text[]` and not a child table: it is a small set never queried BY element,
     * which is the line `CONVENTIONS.md` draws. NOT NULL with an empty default
     * because "no reasons" is a real value here and a nullable column would make
     * every reader handle two spellings of it.
     */
    disabledReasonCodes: text().array().notNull().default([]),
    /** `manual`, `daily`, `weekly` or `monthly` — display metadata, never enforced. */
    payoutScheduleInterval: text(),
    /** Days the provider holds funds before paying out, when it reports one. */
    payoutScheduleDelayDays: integer(),
    /**
     * The last successful provider read.
     *
     * Also the reconciliation cursor: the sweep refreshes the accounts whose
     * value is oldest, so a missed `account.updated` converges without anyone
     * knowing which one was missed (ADR 0001, sequence 6).
     */
    lastSyncedAt: timestamptz(),
    /** When this account first became `ready`. Set once and never cleared. */
    activatedAt: timestamptz(),
    /**
     * When the platform's authorisation was revoked (the seller disconnected).
     *
     * Kept rather than deleting the row: the account may still hold a balance,
     * `payouts` rows still name it, and the fact that a seller WAS onboarded is
     * part of the record a marketplace has to be able to produce (D10).
     */
    revokedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('provider_accounts_provider_check', t.provider, PAYMENT_PROVIDER_IDS),
    checkOneOf('provider_accounts_owner_type_check', t.ownerType, PROVIDER_ACCOUNT_OWNER_TYPES),
    checkOneOf(
      'provider_accounts_onboarding_state_check',
      t.onboardingState,
      PROVIDER_ONBOARDING_STATES,
    ),
    checkOneOf(
      'provider_accounts_transfers_capability_check',
      t.transfersCapability,
      PROVIDER_CAPABILITY_STATUSES,
    ),
    // An empty string is a VALUE, so it satisfies NOT NULL and collides for real
    // in the uniqueness below — the same trap `CONVENTIONS.md` records for a
    // sparse-unique column written `''` instead of NULL.
    check('provider_accounts_owner_id_check', sql`length(${t.ownerId}) > 0`),
    check(
      'provider_accounts_provider_account_id_check',
      sql`length(${t.providerAccountId}) > 0`,
    ),
    // ISO-3166-1 alpha-2, upper-cased — the form the allow-list is compared in.
    check(
      'provider_accounts_country_check',
      sql`${t.country} = upper(${t.country}) and length(${t.country}) = 2`,
    ),
    check(
      'provider_accounts_requirements_check',
      sql`${t.requirementsCurrentlyDue} >= 0 and ${t.requirementsEventuallyDue} >= 0
          and ${t.requirementsPastDue} >= 0 and ${t.requirementsPendingVerification} >= 0`,
    ),
    check(
      'provider_accounts_payout_delay_days_check',
      sql`${t.payoutScheduleDelayDays} is null or ${t.payoutScheduleDelayDays} >= 0`,
    ),
    // A code is a code. The allow-list form (`<@ array[…]`) would be wrong here —
    // these are the PROVIDER's own codes and their set grows on the provider's
    // schedule — but an EMPTY one carries no meaning and renders as a blank
    // bullet in the seller's dashboard, so that much is refused.
    check(
      'provider_accounts_disabled_reason_codes_check',
      sql`not ('' = any(${t.disabledReasonCodes}))`,
    ),
    // #46, security 3, and the whole reason the owner is one column: ONE account
    // per owner per rail. A concurrent second `ensureConnectedAccount` converges
    // on the row this refuses to duplicate rather than opening a second account
    // at the provider.
    uniqueIndex('provider_accounts_owner_key').on(t.provider, t.ownerType, t.ownerId),
    // "Which seller is this connected account?" — the lookup every inbound
    // account and payout event starts from.
    uniqueIndex('provider_accounts_provider_account_id_key').on(t.provider, t.providerAccountId),
    // The reconciliation sweep: least-recently-synced first, NULLs (never synced)
    // ahead of everything, which is the order it must visit them in.
    index('provider_accounts_sync_idx').on(t.provider, t.lastSyncedAt),
    // The operator question "who is stuck", and the seller-cohort reads behind it.
    index('provider_accounts_state_idx').on(t.provider, t.onboardingState),
  ],
);

/**
 * `payments` — the durable payment aggregate, one per funded checkout group.
 *
 * It owns the payment's own lifecycle and nothing else: what the buyer is
 * charged, what that becomes in the platform's settlement currency, and which
 * provider object it corresponds to. Per-attempt detail lives in
 * `payment_attempts`, inbound evidence in `payment_provider_events`, money
 * movement in `./ledger`, and seller settlement in `transfers`.
 *
 * ## The two money sides, and why the second one is nullable
 *
 * `presentment_*` is what the buyer sees and is charged — the currency chosen at
 * checkout, known from the moment the payment is created.
 *
 * `platform_*` is that amount in the platform's settlement currency, which
 * exists only once the provider has actually converted it (ADR 0001 D8). It is
 * nullable together with its rate snapshot, and the CHECK below pins them to
 * "all six present or all six absent": a platform amount with no rate is a
 * figure nobody can reproduce, and a rate with no amount is a rate about
 * nothing.
 *
 * This is a single `Money` on each side, NOT a `DualMoney`. A `DualMoney` is one
 * economic value carried in a seller's and a buyer's currency at one rate; these
 * two are a charge and its conversion, related by a rate that is captured HERE
 * and is not the order's shop→presentment rate.
 */
export const payments = pgTable(
  'payments',
  {
    id: generatedId(),
    /**
     * The checkout group this payment funds. Sibling orders of a multi-seller
     * cart share it, which is exactly why funding is atomic at the GROUP level
     * (ADR 0001 D4) — there is one payment for them all, so they cannot have
     * different funding outcomes.
     *
     * For an `external` payment this is the connector's own synthetic group
     * (`ext:<provider>:<externalId>`), which is why the uniqueness below is
     * partial: two connected shops can legitimately import orders carrying the
     * same external id, and their groups collide.
     */
    checkoutGroupId: text().notNull(),
    /**
     * The Oxy buyer, when there is one. NULL on an `external` payment: an order
     * imported from Shopify has no Oxy account behind it, and inventing one
     * would make a connector import look like a Mercaria purchase.
     *
     * A payment belongs financially to the checkout and its orders, never to the
     * lifespan of whatever credential placed it (#45 buyer boundaries 1 and 2).
     */
    buyerOxyUserId: text(),
    provider: text({ enum: asEnumValues(PAYMENT_PROVIDER_IDS) }).notNull(),
    /**
     * The ONE order an `external` payment stands for, and NULL for every native
     * payment (which correlates through `checkout_group_id`). The CHECK below
     * makes those two cases exhaustive, so "which orders does this payment
     * fund" always has exactly one answer.
     */
    orderId: text(),
    status: text({ enum: asEnumValues(PAYMENT_STATUSES) }).notNull().default('created'),
    ...money('presentment'),
    ...optionalMoney('platform'),
    // The presentment→platform conversion, captured at charge time. Same five
    // fields as `orders.fx_rate_*` and for the same reason: a stored rate nobody
    // can attribute to a source is not reproducible.
    platformRateFrom: text(),
    platformRateTo: text(),
    /** A conversion rate, genuinely fractional. */
    platformRateRate: doublePrecision(),
    platformRateProvider: text(),
    /** An ISO-8601 instant as TEXT — `FxRateSnapshot.asOf` is declared `string`. */
    platformRateAsOf: text(),
    /**
     * The provider's own object for this payment (a PaymentIntent, a Faircoin
     * transaction). Indexed for reconciliation lookups and NEVER a primary key.
     */
    providerObjectId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('payments_provider_check', t.provider, PAYMENT_PROVIDER_IDS),
    checkOneOf('payments_status_check', t.status, PAYMENT_STATUSES),
    ...currencyChecks('payments', [t.presentmentCurrency, t.platformCurrency]),
    // The platform side is a conversion or it is absent — never a half of one.
    check(
      'payments_platform_conversion_complete_check',
      sql`num_nonnulls(${t.platformAmount}, ${t.platformCurrency}, ${t.platformRateFrom}, ${t.platformRateTo}, ${t.platformRateRate}, ${t.platformRateProvider}, ${t.platformRateAsOf}) in (0, 7)`,
    ),
    // An external payment names its one order; a native payment never does.
    check(
      'payments_external_order_check',
      sql`(${t.provider} = 'external') = (${t.orderId} is not null)`,
    ),
    check('payments_presentment_amount_check', sql`${t.presentmentAmount} >= 0`),
    // ADR 0001 D11: one payment record per checkout group, for native rails.
    // A replayed checkout converges on it instead of opening a second payment.
    uniqueIndex('payments_checkout_group_id_key')
      .on(t.checkoutGroupId)
      .where(sql`${t.provider} <> 'external'`),
    // …and one per imported order, so a re-sync of the same external order
    // refreshes its payment rather than adding another.
    uniqueIndex('payments_external_order_id_key')
      .on(t.orderId)
      .where(sql`${t.provider} = 'external'`),
    // Reconciliation reads: "which payment is this provider object?"
    index('payments_provider_object_id_idx')
      .on(t.provider, t.providerObjectId)
      .where(sql`${t.providerObjectId} is not null`),
    index('payments_buyer_created_at_idx').on(t.buyerOxyUserId, t.createdAt.desc()),
    index('payments_status_created_at_idx').on(t.status, t.createdAt),
  ],
);

/**
 * `payment_attempts` — one row per provider authorization or confirmation
 * Mercaria asked for.
 *
 * Append-mostly evidence, and the reason a failed payment does not lose its
 * audit trail (#45 acceptance 4): the payment row holds only the CURRENT state,
 * so without this table a retry would overwrite the record of what went wrong.
 *
 * `error_message` is stored REDACTED. The redaction happens at the call site
 * (`services/payments/redact.ts`), not here, because a CHECK cannot tell a safe
 * message from one carrying a card fingerprint — but the length bound below at
 * least stops an unbounded provider string.
 */
export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: generatedId(),
    /**
     * `restrict`: nothing deletes a payment. A financial aggregate is not
     * deletable, and saying so here is more useful than a cascade that would
     * silently take its evidence with it if something ever tried.
     */
    paymentId: text()
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    /** 1-based, dense per payment. The UNIQUE below is what keeps it so. */
    sequence: integer().notNull(),
    provider: text({ enum: asEnumValues(PAYMENT_PROVIDER_IDS) }).notNull(),
    providerObjectId: text(),
    status: text({ enum: asEnumValues(PAYMENT_ATTEMPT_STATUSES) }).notNull(),
    /** The provider's own machine-readable failure code, when it gave one. */
    errorCode: text(),
    /** A redacted human message. Never a payload, never a secret. */
    errorMessage: text(),
    /**
     * The key sent to the provider for this attempt, derived from Mercaria
     * durable ids (ADR 0001 D11) and never from request-scoped randomness.
     * Sparse-unique, so a replayed call converges on the attempt it already
     * made rather than recording a second one.
     */
    idempotencyKey: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('payment_attempts_provider_check', t.provider, PAYMENT_PROVIDER_IDS),
    checkOneOf('payment_attempts_status_check', t.status, PAYMENT_ATTEMPT_STATUSES),
    check('payment_attempts_sequence_check', sql`${t.sequence} >= 1`),
    check(
      'payment_attempts_error_message_length_check',
      sql`${t.errorMessage} is null or length(${t.errorMessage}) <= ${sql.raw(String(MAX_LAST_ERROR_LENGTH))}`,
    ),
    uniqueIndex('payment_attempts_payment_id_sequence_key').on(t.paymentId, t.sequence),
    uniqueIndex('payment_attempts_idempotency_key_key')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index('payment_attempts_payment_id_created_at_idx').on(t.paymentId, t.createdAt),
  ],
);

/**
 * `payment_provider_events` — the immutable envelope of everything a provider
 * has told Mercaria.
 *
 * ## The uniqueness is the whole point, and NULLs nearly break it
 *
 * `UNIQUE(provider, provider_account_id, provider_event_id)` is #45 invariant 3.
 * `provider_account_id` is NULL for platform-scope events, and Postgres treats
 * NULLs as DISTINCT by default — so the plain constraint would dedupe
 * connect-scope events and silently accept every redelivery of a platform-scope
 * one, which is the majority of them. `NULLS NOT DISTINCT` is what closes it.
 * Coalescing to `''` would work too and is worse: an empty string is a VALUE, so
 * it would collide for real the day a provider ever reports an empty account.
 *
 * ## `payload_summary` is jsonb, and it is REDACTED
 *
 * A provider payload is genuinely open-shaped — it is not Mercaria's schema and
 * a newer API version adds fields — which is the bar `CONVENTIONS.md` sets for
 * jsonb. What it must never be is the payload verbatim (#45 invariant 9): the
 * writer passes it through `redactProviderPayload`, which keeps ids, amounts,
 * currencies and statuses and drops everything else. Storing the wholesale
 * payload would put card metadata and buyer contact details in a table the
 * operator surface reads.
 *
 * ## This table IS the job queue for inbound events (#48)
 *
 * `status`, `attempts` and `last_error` were here from the start; #48 added
 * `next_attempt_at`, `lease_owner`, `lease_until` and `processing_note`, which
 * is what turns the row from a record OF work into the work itself — the same
 * claim shape `payment_outboxes` uses, `for update skip locked` and all.
 *
 * The alternative — writing a `payment_outboxes` row saying "please interpret
 * the event row I just wrote" — was rejected for three reasons. It would make
 * one inbound delivery into TWO durable records that can disagree (an envelope
 * whose insert was deduped, beside an outbox row that was not). It would put
 * inbound ingress into a table whose event types are Mercaria's own DOMAIN
 * consequences, which are a different kind of thing with different consumers.
 * And the retentions differ on purpose: outbox rows are swept at 14 days,
 * events at 90, and a dead-lettered event must stay replayable across a dispute
 * window rather than for a fortnight.
 */
export const paymentProviderEvents = pgTable(
  'payment_provider_events',
  {
    id: generatedId(),
    provider: text({ enum: asEnumValues(PAYMENT_PROVIDER_IDS) }).notNull(),
    /** The connected account the event is scoped to; NULL for platform scope. */
    providerAccountId: text(),
    /** The provider's own event id — their key space, part of the dedupe key. */
    providerEventId: text().notNull(),
    /** The provider's event type verbatim, e.g. `payment_intent.succeeded`. */
    type: text().notNull(),
    /**
     * Whether the provider says this is live traffic.
     *
     * Stored rather than filtered away, because a production endpoint receives
     * test events too and "we received it and ignored it" is a different fact
     * from "it never arrived" when an integration is being debugged.
     */
    livemode: boolean().notNull(),
    /** The provider API version that rendered this payload, when it says. */
    apiVersion: text(),
    /**
     * The provider object ids this event refers to, e.g.
     * `{"paymentIntent": "pi_…", "charge": "ch_…"}`. jsonb because the key set
     * is the PROVIDER's, differs per rail, and grows with their API.
     */
    objectIds: jsonb().$type<Record<string, string>>().notNull(),
    /** The redacted summary — see the table docblock. */
    payloadSummary: jsonb().$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamptz().notNull(),
    status: text({ enum: asEnumValues(PROVIDER_EVENT_STATUSES) }).notNull().default('received'),
    attempts: integer().notNull().default(0),
    lastError: text(),
    processedAt: timestamptz(),
    /**
     * When this event is next eligible to be claimed. Set at insert (now) and
     * advanced by exponential backoff on every retryable failure.
     *
     * Separate from `received_at`, which never moves: one says when the provider
     * told us, the other when we may next try to understand it, and collapsing
     * them would make a backed-off event look like it arrived later than it did.
     */
    nextAttemptAt: timestamptz(),
    /** Which task holds the processing lease. An opaque worker identity. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    /**
     * What this version DID with the event, when what it did was not to apply it.
     *
     * The seam marker. Several of the event types #48 subscribes to are consumed
     * by later issues — connected-account readiness by #46, refunds, disputes and
     * payouts by #49 — and those arrive here today, verify, store and then have
     * nowhere to go. Marking them `processed` with nothing else recorded would
     * make a deferral indistinguishable from real handling in the operator trace,
     * which is the one thing a seam must never look like. So a deferred handler
     * writes `deferred: #49 — …` here and the trace says so out loud.
     *
     * Distinct from `last_error` on purpose: this is not a failure, it is the
     * correct outcome for this version, and putting it in an error column would
     * make every dashboard counting errors wrong.
     */
    processingNote: text(),
    /**
     * The payment this event resolved to, once it has been processed. NULL while
     * unprocessed, and NULL forever for an event about an object Mercaria does
     * not know — which is evidence worth keeping, not a row to drop.
     */
    paymentId: text().references(() => payments.id, { onDelete: 'restrict' }),
    /**
     * Set at insert and never advanced. Swept by `db/expiryTargets.ts` —
     * Postgres has no TTL index, and a table ported without a registry entry
     * grows FOREVER with no error and no failing test.
     */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('payment_provider_events_provider_check', t.provider, PAYMENT_PROVIDER_IDS),
    checkOneOf('payment_provider_events_status_check', t.status, PROVIDER_EVENT_STATUSES),
    check('payment_provider_events_attempts_check', sql`${t.attempts} >= 0`),
    check(
      'payment_provider_events_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(MAX_LAST_ERROR_LENGTH))}`,
    ),
    check(
      'payment_provider_events_processing_note_length_check',
      sql`${t.processingNote} is null or length(${t.processingNote}) <= ${sql.raw(String(MAX_LAST_ERROR_LENGTH))}`,
    ),
    // #45 invariant 3. `nullsNotDistinct` because platform-scope events carry no
    // account and would otherwise never collide — see the table docblock.
    unique('payment_provider_events_provider_event_key')
      .on(t.provider, t.providerAccountId, t.providerEventId)
      .nullsNotDistinct(),
    // The processing sweep: what has been received and not yet interpreted.
    index('payment_provider_events_status_received_at_idx').on(t.status, t.receivedAt),
    // The two claim branches, one partial index each — the same shape
    // `payment_outboxes` uses: work that is DUE, and work whose lease expired
    // because the task holding it died. Both order by `received_at`, because the
    // claim takes the oldest first and an event stream must not starve its head.
    index('payment_provider_events_claimable_idx')
      .on(t.nextAttemptAt, t.receivedAt)
      .where(sql`${t.status} in ('received', 'failed')`),
    index('payment_provider_events_reclaim_idx')
      .on(t.leaseUntil, t.receivedAt)
      .where(sql`${t.status} = 'processing'`),
    index('payment_provider_events_payment_id_received_at_idx')
      .on(t.paymentId, t.receivedAt.desc())
      .where(sql`${t.paymentId} is not null`),
    // The leading btree the expiry sweep needs; see `expiresAt`.
    index('payment_provider_events_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * `transfers` — Mercaria paying ONE seller order out of a settled charge.
 *
 * One per seller order (ADR 0001 D3), which is what lets a multi-seller
 * checkout fund atomically and then diverge: a refund, a dispute or a reversal
 * acts on one order's transfer without touching its siblings.
 *
 * `reversed_amount` is a quantity rather than a flag because a reversal is
 * routinely PARTIAL — a partial refund reverses the seller's proportional share.
 * A boolean would make a half-reversed transfer unrepresentable, which is the
 * state most of them are in during a partial refund.
 */
export const transfers = pgTable(
  'transfers',
  {
    id: generatedId(),
    paymentId: text()
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    /** Correlation to the seller order — no foreign key; see this file's docblock. */
    orderId: text().notNull(),
    provider: text({ enum: asEnumValues(PAYMENT_PROVIDER_IDS) }).notNull(),
    providerObjectId: text(),
    ...money('amount'),
    status: text({ enum: asEnumValues(TRANSFER_STATUSES) }).notNull().default('pending'),
    /**
     * How much of `amount` has been reversed, in the SAME currency — so it is
     * an amount without a currency column of its own, exactly like
     * `discounts.value`. `bigint` for the reason every minor-units column in
     * this schema is one: a signed `integer` tops out at 21.47 ⊜.
     */
    reversedAmount: bigint({ mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('transfers_provider_check', t.provider, PAYMENT_PROVIDER_IDS),
    checkOneOf('transfers_status_check', t.status, TRANSFER_STATUSES),
    ...currencyChecks('transfers', [t.amountCurrency]),
    check('transfers_amount_check', sql`${t.amountAmount} >= 0`),
    // A reversal can return everything and never more than everything.
    check(
      'transfers_reversed_amount_check',
      sql`${t.reversedAmount} >= 0 and ${t.reversedAmount} <= ${t.amountAmount}`,
    ),
    // ADR 0001 D3: exactly one transfer per (payment, seller order).
    uniqueIndex('transfers_payment_id_order_id_key').on(t.paymentId, t.orderId),
    index('transfers_order_id_created_at_idx').on(t.orderId, t.createdAt.desc()),
    index('transfers_provider_object_id_idx')
      .on(t.provider, t.providerObjectId)
      .where(sql`${t.providerObjectId} is not null`),
    index('transfers_status_created_at_idx').on(t.status, t.createdAt),
  ],
);

/**
 * `payouts` — the provider moving a seller's own balance to their bank.
 *
 * Mercaria is not a party to this movement and records it only to show payout
 * health and correlate seller support requests (ADR 0001 D7). It deliberately
 * carries NO ledger consequence: the merchant receivable was settled when the
 * transfer was created (D6), so a failed payout is a seller-and-provider matter
 * and must not reopen it.
 *
 * There is no foreign key to a seller: `provider_account_ref` is the PROVIDER's
 * connected-account id, and the record mapping one to a store or an Oxy user is
 * #46's to add.
 */
export const payouts = pgTable(
  'payouts',
  {
    id: generatedId(),
    provider: text({ enum: asEnumValues(PAYMENT_PROVIDER_IDS) }).notNull(),
    /** The provider's connected-account reference this payout belongs to. */
    providerAccountRef: text().notNull(),
    providerObjectId: text().notNull(),
    ...money('amount'),
    status: text({ enum: asEnumValues(PAYOUT_STATUSES) }).notNull().default('pending'),
    /** When the provider expects (or reported) the funds landing. */
    arrivalAt: timestamptz(),
    /** The provider's own failure code on a failed payout. */
    failureCode: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('payouts_provider_check', t.provider, PAYMENT_PROVIDER_IDS),
    checkOneOf('payouts_status_check', t.status, PAYOUT_STATUSES),
    ...currencyChecks('payouts', [t.amountCurrency]),
    check('payouts_amount_check', sql`${t.amountAmount} >= 0`),
    // A redelivered payout event updates the row it already made.
    uniqueIndex('payouts_provider_object_id_key').on(t.provider, t.providerObjectId),
    index('payouts_account_created_at_idx').on(t.providerAccountRef, t.createdAt.desc()),
    index('payouts_status_created_at_idx').on(t.status, t.createdAt),
  ],
);

/**
 * `payment_outboxes` — the durable promise that a payment's consequences will
 * happen.
 *
 * The same mechanism as `moderation_outboxes`, deliberately down to the column
 * names, so the two claim queries are the same query and a reader who
 * understands one understands the other. What it protects is different and
 * larger: the consequences of a payment succeeding are an order reaching `paid`,
 * inventory committing, a seller being told and a buyer being notified. An
 * in-memory queue or a detached promise loses all of that when a task restarts,
 * and loses it SILENTLY — the money is captured, the provider is satisfied, and
 * nothing reports an error.
 *
 * ## The primary key has NO DEFAULT, and that is the whole design
 *
 * `id` is derived from the domain event itself
 * (`payment:payment_succeeded:<paymentId>`), never generated. A duplicate
 * provider event, a reclaimed lease or a reconciliation sweep re-deriving the
 * same fact all UPSERT the same row instead of queueing the work twice, and the
 * insert is `on conflict (id) do nothing` so a repeat is a genuine no-op rather
 * than a write contending with a live lease.
 *
 * ## The LOOP is gated, never the record
 *
 * Rows are written whatever the configuration says. A deployment with the
 * dispatcher switched off parks work; it does not lose it.
 */
export const paymentOutboxes = pgTable(
  'payment_outboxes',
  {
    /** A DETERMINISTIC id supplied by the caller — deliberately no default. */
    id: text().primaryKey(),
    eventType: text({ enum: asEnumValues(PAYMENT_OUTBOX_EVENT_TYPES) }).notNull(),
    /**
     * The domain event's own ids — `{paymentId, orderIds}` and friends.
     *
     * jsonb because the key set differs per event type, and deliberately
     * MINIMAL: ids, not snapshots. The handler re-reads the live rows at
     * delivery time, so the outbox can never become a second, drifting source of
     * truth — and no provider payload, contact value or secret can reach a
     * consumer through it (#45 API and events 6 and 8).
     */
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    status: text({ enum: asEnumValues(PAYMENT_OUTBOX_STATUSES) }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    /** Which task holds the lease. An opaque worker identity — no foreign key. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    processedAt: timestamptz(),
    /** Set at insert and never advanced. Swept by `db/expiryTargets.ts`. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('payment_outboxes_event_type_check', t.eventType, PAYMENT_OUTBOX_EVENT_TYPES),
    checkOneOf('payment_outboxes_status_check', t.status, PAYMENT_OUTBOX_STATUSES),
    check('payment_outboxes_attempts_check', sql`${t.attempts} >= 0`),
    check(
      'payment_outboxes_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(MAX_LAST_ERROR_LENGTH))}`,
    ),
    // The claim query is a two-branch `or`: due PENDING work, and PROCESSING
    // work whose lease has expired (a dead task's, being reclaimed). One partial
    // index per branch, each carrying `created_at` because the claim takes the
    // oldest first — exactly the shape `moderation_outboxes` uses.
    index('payment_outboxes_pending_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index('payment_outboxes_reclaim_idx')
      .on(t.leaseUntil, t.createdAt)
      .where(sql`${t.status} = 'processing'`),
    // The leading btree the expiry sweep needs; see `expiresAt`.
    index('payment_outboxes_expires_at_idx').on(t.expiresAt),
  ],
);
