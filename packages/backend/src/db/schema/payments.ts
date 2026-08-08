/**
 * The payment domain: `payments`, `payment_attempts`,
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
 * `db/deferredForeignKeys.ts` with that reason. Two things force it, and the
 * second outlives the first:
 *
 *  1. Orders are still served from MongoDB. The Postgres `orders` table exists
 *     but is not yet the write path, so a constraint here would reject every
 *     payment written today — for an order that genuinely exists.
 *  2. A financial record must be insertable and readable independently of the
 *     commerce record it names (#45 invariant 12). Money that moved is a fact
 *     Mercaria owes an answer about whether or not the order row is reachable,
 *     and a payment that could not be written because a join partner was
 *     missing is the one failure mode a payment system may not have.
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
  PROVIDER_EVENT_STATUSES,
  TRANSFER_STATUSES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, money, optionalMoney } from './columns';

/** Bound on a stored dispatch or processing error — the `.slice()` at every writer. */
const MAX_LAST_ERROR_LENGTH = 2_000;

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
    // #45 invariant 3. `nullsNotDistinct` because platform-scope events carry no
    // account and would otherwise never collide — see the table docblock.
    unique('payment_provider_events_provider_event_key')
      .on(t.provider, t.providerAccountId, t.providerEventId)
      .nullsNotDistinct(),
    // The processing sweep: what has been received and not yet interpreted.
    index('payment_provider_events_status_received_at_idx').on(t.status, t.receivedAt),
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
