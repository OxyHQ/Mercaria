/**
 * The supplier ORDER orchestration (#124): `procurement_outboxes`,
 * `supplier_order_attempts`, `supplier_provider_events`,
 * `purchase_order_line_outcomes`, `purchase_order_tracking_events`,
 * `purchase_order_documents` and `procurement_exceptions`.
 *
 * #118 modelled the purchase order and its immutable line snapshot; #122
 * modelled what a supplier says BEFORE Mercaria buys. This file is the durable
 * machinery of actually buying: the job that submits, the log of every call
 * made, the events that come back, the line-level evidence behind a partial
 * outcome, and the conditions only a person can close.
 *
 * ## The failure mode that shapes all of it
 *
 * A supplier order placed TWICE for one customer order, because an HTTP
 * response was lost. It costs real money, it is invisible until a supplier's
 * statement is reconciled weeks later, and every naive recovery makes it more
 * likely: a retry, a redelivered webhook, an operator clicking "submit again",
 * two ECS tasks draining one queue. Four mechanisms hold it, and none of them
 * is a convention:
 *
 *  1. **`purchase_orders.idempotency_key`** (#118, `po:<orderId>:<supplierId>`,
 *     UNIQUE) — one purchase order per supplier per customer order, whoever
 *     asks and however often.
 *  2. **`supplier_order_attempts`** — the attempt row is written `in_flight`
 *     BEFORE the provider is called and frozen once it terminates, so a process
 *     that dies mid-call leaves evidence that a call was in flight. A crash
 *     between the write and the call is indistinguishable from a crash after
 *     it, which is exactly why the recovery is a LOOKUP rather than a retry.
 *  3. **`purchase_orders.supplier_external_order_id`** (#118, UNIQUE per
 *     account) — two purchase orders can never claim one supplier order, so a
 *     duplicate is refused by the database rather than noticed by a report.
 *  4. **`procurement_exceptions`** — an ambiguity that cannot be converged
 *     (a provider with no `order_reference_lookup`) becomes an operator's row
 *     rather than another attempt.
 *
 * ## What is deliberately absent
 *
 * - **No second client reference.** Mercaria's reference to a supplier IS the
 *   purchase-order id (ADR 0004 D6.6), rendered by
 *   `deriveSupplierClientReference`. A column holding a separately generated
 *   one would be a second identity for one record — the `po_number` sequence
 *   #118 already refused.
 * - **No provider state-mapping TABLE.** The mapping from a provider's own
 *   status string to a normalized state is a PROCEDURE the adapter ships, and
 *   every row that was read under one records the `state_mapping_version` it
 *   used. A table would let somebody publish a mapping version whose rules
 *   nobody shipped — `CATALOG_BACKFILL_MAPPING_VERSION`'s reasoning (#60),
 *   applied to a provider vocabulary.
 * - **No address, recipient, phone or email column anywhere in this file.** The
 *   destination lives on `purchase_orders` alone (#118's redacted-by-shape
 *   snapshot). An attempt records a request DIGEST, an event records an
 *   allow-listed summary, and a tracking event records a country and a region.
 *   The columns that could leak do not exist.
 * - **No document URL.** `purchase_order_documents` carries the supplier's own
 *   document reference. A supplier portal's link is routinely a signed URL — a
 *   credential wearing a location — and a column of them is a credential store
 *   nobody declared.
 *
 * ## Hand-written triggers ride this domain's migration
 *
 * drizzle-kit does not model triggers, so four enforcement functions are added
 * by hand in the same migration, each stated here so a regeneration that drops
 * them is visible:
 *
 *  - `supplier_order_attempts` refuses DELETE always and refuses UPDATE once
 *    the row has left `in_flight` — an attempt's terminal outcome is written
 *    once and frozen, which is what "append-only attempt log" means for a row
 *    that necessarily exists before its outcome does.
 *  - `purchase_order_line_outcomes` and `purchase_order_tracking_events` refuse
 *    UPDATE and DELETE outright — provider evidence, never edited.
 *  - `supplier_accounts` refuses any change to `provider`, `environment` and
 *    `provider_account_id`. That is #124 security item 8 ("keep test and
 *    production accounts impossible to mix") held structurally: a purchase
 *    order, a quote and an event all name an account rather than snapshotting
 *    its environment, so freezing the account's identity is what stops a flip
 *    silently reinterpreting every historical row that points at it.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
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
  PROCUREMENT_EXCEPTION_KINDS,
  PROCUREMENT_EXCEPTION_RESOLUTIONS,
  PROCUREMENT_OUTBOX_EVENT_TYPES,
  PROCUREMENT_OUTBOX_STATUSES,
  PURCHASE_ORDER_REASON_CODES,
  SUPPLIER_DOCUMENT_KINDS,
  SUPPLIER_EVENT_DELIVERIES,
  SUPPLIER_EVENT_STATUSES,
  SUPPLIER_EVENT_VERIFICATIONS,
  SUPPLIER_ORDER_ATTEMPT_OUTCOMES,
  SUPPLIER_ORDER_LINE_OUTCOME_KINDS,
  SUPPLIER_ORDER_NORMALIZED_STATES,
  SUPPLIER_ORDER_OPERATIONS,
  SUPPLIER_ORDER_REFUSAL_REASONS,
  SUPPLIER_PROVIDER_ERROR_CLASSES,
  SUPPLIER_TRACKING_STATUSES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, CURRENCY_CODE_VALUES } from './columns';
import {
  purchaseOrderLines,
  purchaseOrders,
  purchaseOrderShipments,
  supplierAccounts,
  suppliers,
} from './procurement';

/** Bound on any stored provider message or operator note. */
const MAX_NOTE_LENGTH = 2_000;

/** Bound on a redacted provider message — shorter, because it is quoted back. */
const MAX_PROVIDER_MESSAGE_LENGTH = 512;

/**
 * `procurement_outboxes` — the durable promise that a paid retail order will be
 * procured, cancelled, polled and reconciled.
 *
 * The `payment_outboxes` mechanism, deliberately down to the column names, so
 * the two claim queries are the same query. What it protects is different: the
 * consequence of a retail payment succeeding is a supplier order being PLACED,
 * and an in-memory queue that loses one loses it silently — the customer has
 * paid, the provider was never called, and nothing reports an error.
 *
 * ## The id has NO DEFAULT, and that is the whole design
 *
 * `id` is derived from the domain fact
 * (`procurement:purchase_order_submission:<purchaseOrderId>`), never generated.
 * A redelivered payment event, a reclaimed lease, an operator retry and a
 * reconciliation sweep re-deriving the same fact all UPSERT the same row
 * instead of queueing a second supplier order. That is #124 idempotency item 6
 * — "prevent operator retry from bypassing the same unique key" — held by the
 * primary key rather than by a check in the operator handler.
 *
 * ## The LOOP is gated, never the record
 *
 * Rows are written whatever `PROCUREMENT_ORCHESTRATION_ENABLED` says. A
 * deployment with the dispatcher off parks the work; a per-supplier kill switch
 * (`supplier_accounts.state = 'killed'`) stops new SUBMISSION while status,
 * cancellation, return and reconciliation rows keep draining — which is
 * acceptance 5.
 */
export const procurementOutboxes = pgTable(
  'procurement_outboxes',
  {
    /** A DETERMINISTIC id supplied by the caller — deliberately no default. */
    id: text().primaryKey(),
    eventType: text({ enum: asEnumValues(PROCUREMENT_OUTBOX_EVENT_TYPES) }).notNull(),
    /**
     * The domain fact's own ids — `{purchaseOrderId, orderId}` and friends.
     *
     * jsonb because the key set differs per event type, and deliberately
     * MINIMAL: ids, not snapshots. The handler re-reads the live rows at
     * delivery time, so the outbox can never become a second, drifting source
     * of truth, and no destination, provider payload or credential can reach a
     * consumer through it.
     */
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    status: text({ enum: asEnumValues(PROCUREMENT_OUTBOX_STATUSES) }).notNull().default('pending'),
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
    checkOneOf('procurement_outboxes_event_type_check', t.eventType, PROCUREMENT_OUTBOX_EVENT_TYPES),
    checkOneOf('procurement_outboxes_status_check', t.status, PROCUREMENT_OUTBOX_STATUSES),
    check('procurement_outboxes_attempts_check', sql`${t.attempts} >= 0`),
    check(
      'procurement_outboxes_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    // The claim query is a two-branch `or`: due PENDING work, and PROCESSING
    // work whose lease has expired. One partial index per branch, each carrying
    // `created_at` because the claim takes the oldest first.
    index('procurement_outboxes_pending_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index('procurement_outboxes_reclaim_idx')
      .on(t.leaseUntil, t.createdAt)
      .where(sql`${t.status} = 'processing'`),
    // "Stuck purchase orders by state and age" (#124 observability 6) reads the
    // dead letters from here rather than from a copy.
    index('procurement_outboxes_dead_letter_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'dead_letter'`),
    index('procurement_outboxes_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * `supplier_order_attempts` — every provider call this domain has made, with
 * secrets and full addresses absent rather than removed (#124 idempotency 8).
 *
 * ## The row exists BEFORE the call, which is the point
 *
 * `outcome = 'in_flight'` is written and COMMITTED before the adapter is
 * invoked, so a task that dies mid-request leaves a durable record that a
 * request may have reached the provider. Recovery then reads this row and
 * converges by LOOKUP rather than by resubmitting — which is #124 idempotency
 * items 3 and 9 and acceptance 2.
 *
 * A trigger refuses DELETE always and refuses UPDATE once the row has left
 * `in_flight`. "Append-only" for a row whose outcome necessarily arrives after
 * its creation means exactly that: one write to terminate it, and then frozen.
 *
 * ## `request_hash` is a digest and is PROTECTED
 *
 * The canonical request it digests contains the buyer's shipping address, so
 * the digest is an exact-match ORACLE over it — the `guest_checkouts.email_hash`
 * reasoning (ADR 0003), and the reason a keyed digest is registered in
 * `db/protectedColumns.ts` beside the ciphertext it summarises. What it is FOR
 * is #124 submission orchestration 6: persisting what was sent, so a second
 * attempt that differs is visible rather than silently overwriting the first.
 */
export const supplierOrderAttempts = pgTable(
  'supplier_order_attempts',
  {
    id: generatedId(),
    purchaseOrderId: text()
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    operation: text({ enum: asEnumValues(SUPPLIER_ORDER_OPERATIONS) }).notNull(),
    /** 1-based, dense per (purchase order, operation) — the sequence a trace reads. */
    attemptNumber: integer().notNull(),
    outcome: text({ enum: asEnumValues(SUPPLIER_ORDER_ATTEMPT_OUTCOMES) })
      .notNull()
      .default('in_flight'),
    /** Why the framework declined to call at all. Present exactly when `refused`. */
    refusalReason: text({ enum: asEnumValues(SUPPLIER_ORDER_REFUSAL_REASONS) }),
    /** The sha-256 of the canonical request. PROTECTED — see the table docblock. */
    requestHash: text().notNull(),
    /** The provider object this call produced or read. Their key space. */
    providerObjectId: text(),
    /** The normalized class of a failure, when the call failed. */
    providerErrorClass: text({ enum: asEnumValues(SUPPLIER_PROVIDER_ERROR_CLASSES) }),
    /**
     * Whether the request's bytes may already have been applied at the provider.
     *
     * The field that decides AMBIGUITY (#124 idempotency 4). Only the code
     * holding the socket can know which side of the write a failure fell on,
     * so the adapter states it and this column records what it said.
     */
    providerErrorAfterWrite: text({ enum: ['yes', 'no', 'unknown'] }),
    /** The provider's own error code, when it gave one. */
    providerErrorCode: text(),
    /** The provider's message, REDACTED and bounded at the call site. */
    providerMessage: text(),
    /** The normalized reason the provider gave, when it maps to one. */
    reasonCode: text({ enum: asEnumValues(PURCHASE_ORDER_REASON_CODES) }),
    /** Which version of the adapter's mapping read this answer. */
    stateMappingVersion: integer(),
    startedAt: timestamptz().notNull(),
    completedAt: timestamptz(),
    latencyMs: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('supplier_order_attempts_operation_check', t.operation, SUPPLIER_ORDER_OPERATIONS),
    checkOneOf('supplier_order_attempts_outcome_check', t.outcome, SUPPLIER_ORDER_ATTEMPT_OUTCOMES),
    checkOneOf(
      'supplier_order_attempts_refusal_reason_check',
      t.refusalReason,
      SUPPLIER_ORDER_REFUSAL_REASONS,
    ),
    checkOneOf(
      'supplier_order_attempts_error_class_check',
      t.providerErrorClass,
      SUPPLIER_PROVIDER_ERROR_CLASSES,
    ),
    checkOneOf('supplier_order_attempts_reason_code_check', t.reasonCode, PURCHASE_ORDER_REASON_CODES),
    check('supplier_order_attempts_attempt_number_check', sql`${t.attemptNumber} >= 1`),
    check('supplier_order_attempts_request_hash_check', sql`length(${t.requestHash}) = 64`),
    check(
      'supplier_order_attempts_latency_check',
      sql`${t.latencyMs} is null or ${t.latencyMs} >= 0`,
    ),
    check(
      'supplier_order_attempts_message_length_check',
      sql`${t.providerMessage} is null
          or length(${t.providerMessage}) <= ${sql.raw(String(MAX_PROVIDER_MESSAGE_LENGTH))}`,
    ),
    // A refusal names its reason and nothing else does. The framework declining
    // to call and the provider declining the call are different facts, and a
    // row that could carry both would let one be read as the other.
    check(
      'supplier_order_attempts_refusal_shape_check',
      sql`(${t.outcome} = 'refused') = (${t.refusalReason} is not null)`,
    ),
    // An AMBIGUOUS outcome is only reachable from a failure the adapter said
    // happened after the write. Without this, "ambiguous" would be a value a
    // service could choose, and the whole convergence path would rest on
    // whoever wrote the call site rather than on what the socket did.
    check(
      'supplier_order_attempts_ambiguity_shape_check',
      sql`${t.outcome} <> 'ambiguous' or ${t.providerErrorAfterWrite} = 'yes'`,
    ),
    // A terminated attempt has a completion time; an in-flight one does not.
    check(
      'supplier_order_attempts_completion_shape_check',
      sql`(${t.outcome} = 'in_flight') = (${t.completedAt} is null)`,
    ),
    // The dense sequence a trace reads, and the constraint that stops two
    // concurrent dispatchers writing attempt 3 twice.
    uniqueIndex('supplier_order_attempts_sequence_key').on(
      t.purchaseOrderId,
      t.operation,
      t.attemptNumber,
    ),
    index('supplier_order_attempts_po_started_idx').on(t.purchaseOrderId, t.startedAt),
    // The convergence queue: attempts that may have written and were never
    // resolved. `in_flight` is in the predicate because a task that died holds
    // exactly that shape.
    index('supplier_order_attempts_unresolved_idx')
      .on(t.startedAt)
      .where(sql`${t.outcome} in ('ambiguous', 'in_flight')`),
    // "Supplier API errors, auth and quota" (#124 observability 8).
    index('supplier_order_attempts_error_class_idx')
      .on(t.supplierAccountId, t.providerErrorClass, t.startedAt)
      .where(sql`${t.providerErrorClass} is not null`),
  ],
);

/**
 * `supplier_provider_events` — the immutable envelope of everything a supplier
 * has told Mercaria, and the job queue for interpreting it.
 *
 * `payment_provider_events`'s shape and its reasoning: receipt is separate from
 * processing, so **a 200 means stored, never processed** (#124 polling and
 * webhooks 2), and the ROW is the job rather than an outbox row pointing at it.
 *
 * ## Dedupe has TWO keys because polled events have no event id
 *
 * A webhook carries the provider's own event id and dedupes on it. A POLL does
 * not — it is a snapshot Mercaria asked for — so its identity is its CONTENT
 * (`content_hash`, over the normalized state, the provider state, the observed
 * time and the object ids). Two partial uniques rather than one
 * `NULLS NOT DISTINCT` constraint, because that would collapse every polled
 * event for an account into a single row: `NULLS NOT DISTINCT` makes NULLs
 * COLLIDE, which is right for `payment_provider_events`' optional account scope
 * and catastrophic here.
 *
 * ## `verification` has no `unverified` value
 *
 * An unverified callback has no row shape, so it cannot be stored now and
 * applied later by a sweep that never re-checked (#124 polling and webhooks 8).
 * The ingress refuses it, counts it and logs it.
 *
 * ## `observed_at` is the PROVIDER's clock and is the ordering key
 *
 * Two deliveries racing produce two `received_at` values whose order says
 * nothing about the world. An event whose `observed_at` precedes what has
 * already been applied is stored and NOT applied — the
 * `mercaria_catalog_source_object_monotonic` device (#62), which is what makes
 * "support reordered, delayed and duplicate events" (item 4) a property rather
 * than a hope.
 */
export const supplierProviderEvents = pgTable(
  'supplier_provider_events',
  {
    id: generatedId(),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    /** The provider slug, denormalized from the account for the operator queues. */
    provider: text().notNull(),
    delivery: text({ enum: asEnumValues(SUPPLIER_EVENT_DELIVERIES) }).notNull(),
    verification: text({ enum: asEnumValues(SUPPLIER_EVENT_VERIFICATIONS) }).notNull(),
    /** The provider's own event id. NULL for a poll — see the table docblock. */
    providerEventId: text(),
    /** sha-256 over the normalized content — the poll path's identity. */
    contentHash: text().notNull(),
    /** The provider's event type verbatim, e.g. `order.shipped`. */
    eventType: text().notNull(),
    /** The provider's own order id this event is about, when it names one. */
    providerOrderId: text(),
    /** The purchase order this resolved to. NULL while unresolved, and NULL forever
     * for an event about an order Mercaria does not know — evidence worth keeping. */
    purchaseOrderId: text().references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    normalizedState: text({ enum: asEnumValues(SUPPLIER_ORDER_NORMALIZED_STATES) }).notNull(),
    /** The provider's own status string, verbatim, for the operator trace. */
    providerState: text(),
    /** Which version of the adapter's mapping produced `normalized_state`. */
    stateMappingVersion: integer().notNull(),
    /** The PROVIDER's clock — the ordering key. See the table docblock. */
    observedAt: timestamptz().notNull(),
    receivedAt: timestamptz().notNull(),
    /** The ALLOW-LISTED projection of the payload. Never the payload. */
    payloadSummary: jsonb().$type<Record<string, unknown>>().notNull(),
    status: text({ enum: asEnumValues(SUPPLIER_EVENT_STATUSES) }).notNull().default('received'),
    attempts: integer().notNull().default(0),
    lastError: text(),
    processedAt: timestamptz(),
    nextAttemptAt: timestamptz(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    /** What this version DID with the event, when what it did was not to apply it. */
    processingNote: text(),
    /** Set at insert and never advanced. Swept by `db/expiryTargets.ts`. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('supplier_provider_events_delivery_check', t.delivery, SUPPLIER_EVENT_DELIVERIES),
    checkOneOf(
      'supplier_provider_events_verification_check',
      t.verification,
      SUPPLIER_EVENT_VERIFICATIONS,
    ),
    checkOneOf('supplier_provider_events_status_check', t.status, SUPPLIER_EVENT_STATUSES),
    checkOneOf(
      'supplier_provider_events_state_check',
      t.normalizedState,
      SUPPLIER_ORDER_NORMALIZED_STATES,
    ),
    check('supplier_provider_events_provider_check', sql`${t.provider} ~ '^[a-z0-9][a-z0-9_-]*$'`),
    check('supplier_provider_events_content_hash_check', sql`length(${t.contentHash}) = 64`),
    check('supplier_provider_events_attempts_check', sql`${t.attempts} >= 0`),
    check(
      'supplier_provider_events_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    check(
      'supplier_provider_events_processing_note_length_check',
      sql`${t.processingNote} is null
          or length(${t.processingNote}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    // A POLL cannot carry a provider event id and a WEBHOOK must: an event id
    // invented for a snapshot Mercaria asked for would dedupe two genuinely
    // different observations, and a webhook without one cannot be deduped at
    // all by the key its provider guarantees.
    check(
      'supplier_provider_events_delivery_identity_check',
      sql`(${t.delivery} = 'webhook') = (${t.providerEventId} is not null)`,
    ),
    // The two dedupe keys — see the table docblock for why they are not one.
    uniqueIndex('supplier_provider_events_provider_event_key')
      .on(t.supplierAccountId, t.providerEventId)
      .where(sql`${t.providerEventId} is not null`),
    uniqueIndex('supplier_provider_events_content_key')
      .on(t.supplierAccountId, t.contentHash)
      .where(sql`${t.providerEventId} is null`),
    // The two claim branches, one partial index each.
    index('supplier_provider_events_claimable_idx')
      .on(t.nextAttemptAt, t.receivedAt)
      .where(sql`${t.status} in ('received', 'failed')`),
    index('supplier_provider_events_reclaim_idx')
      .on(t.leaseUntil, t.receivedAt)
      .where(sql`${t.status} = 'processing'`),
    index('supplier_provider_events_po_observed_idx')
      .on(t.purchaseOrderId, t.observedAt)
      .where(sql`${t.purchaseOrderId} is not null`),
    // "Polling and webhook lag" (#124 observability 5): the gap between the
    // provider's clock and ours, newest first, per account.
    index('supplier_provider_events_lag_idx').on(t.supplierAccountId, t.receivedAt),
    index('supplier_provider_events_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * `purchase_order_line_outcomes` — the line-level provider evidence behind
 * every PARTIAL outcome (#124 cancellation 6, state machine 6 and 8).
 *
 * `purchase_order_lines` is immutable from birth: it is what was ORDERED.
 * What happened to each line is a different fact arriving later, repeatedly,
 * and from a party that may correct itself — so it is an append-only trail
 * beside the snapshot rather than columns on it. A trigger refuses UPDATE and
 * DELETE outright.
 *
 * A row here exists only where the provider gave line-level evidence. An
 * adapter that did not declare `order_partial_acceptance` cannot produce one
 * for an acceptance split, because doing so would be
 * `assumed_partial_acceptance` — the capability boundary removes it before
 * anything reaches this table.
 */
export const purchaseOrderLineOutcomes = pgTable(
  'purchase_order_line_outcomes',
  {
    id: generatedId(),
    purchaseOrderId: text()
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    purchaseOrderLineId: text()
      .notNull()
      .references(() => purchaseOrderLines.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(SUPPLIER_ORDER_LINE_OUTCOME_KINDS) }).notNull(),
    quantity: integer().notNull(),
    reasonCode: text({ enum: asEnumValues(PURCHASE_ORDER_REASON_CODES) }),
    /** The event that reported it, when one did. NULL for a submission answer. */
    providerEventId: text().references(() => supplierProviderEvents.id, { onDelete: 'restrict' }),
    /** The PROVIDER's clock for this outcome. */
    observedAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'purchase_order_line_outcomes_kind_check',
      t.kind,
      SUPPLIER_ORDER_LINE_OUTCOME_KINDS,
    ),
    checkOneOf(
      'purchase_order_line_outcomes_reason_code_check',
      t.reasonCode,
      PURCHASE_ORDER_REASON_CODES,
    ),
    // A zero-quantity outcome says nothing and would let "the provider reported
    // nothing about this line" and "the provider accepted none of it" become
    // the same row.
    check('purchase_order_line_outcomes_quantity_check', sql`${t.quantity} > 0`),
    index('purchase_order_line_outcomes_line_idx').on(t.purchaseOrderLineId, t.observedAt),
    index('purchase_order_line_outcomes_po_idx').on(t.purchaseOrderId, t.observedAt),
    // A redelivered event must not append a second copy of the same evidence.
    uniqueIndex('purchase_order_line_outcomes_event_key')
      .on(t.providerEventId, t.purchaseOrderLineId, t.kind)
      .where(sql`${t.providerEventId} is not null`),
  ],
);

/**
 * `purchase_order_tracking_events` — the carrier scan trail (#124 SupplierAdapter
 * 10, polling and webhooks 4).
 *
 * `purchase_order_shipments` (#118) is the parcel; this is what happened to it.
 * Append-only by trigger, and deduped on the SCAN's own identity so a
 * redelivered webhook, a poll that overlaps it and a reordered delivery all
 * converge on one row.
 *
 * The location is a country and a region and nothing finer, deliberately: a
 * carrier's final scan is at the delivery address, and a full-precision
 * location column would put the buyer's home in a table an operator reads and
 * retention keeps for as long as the order.
 */
export const purchaseOrderTrackingEvents = pgTable(
  'purchase_order_tracking_events',
  {
    id: generatedId(),
    purchaseOrderId: text()
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    shipmentId: text().references(() => purchaseOrderShipments.id, { onDelete: 'restrict' }),
    /** The carrier reference the scan belongs to — how a provider reports it. */
    trackingNumber: text().notNull(),
    status: text({ enum: asEnumValues(SUPPLIER_TRACKING_STATUSES) }).notNull(),
    /** The CARRIER's clock. The ordering key, and part of the identity. */
    occurredAt: timestamptz().notNull(),
    /** The carrier's own words, REDACTED and bounded at the call site. */
    description: text(),
    /** ISO-3166-1 alpha-2. Coarse deliberately — see the table docblock. */
    locationCountry: text(),
    locationRegion: text(),
    providerEventId: text().references(() => supplierProviderEvents.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'purchase_order_tracking_events_status_check',
      t.status,
      SUPPLIER_TRACKING_STATUSES,
    ),
    check('purchase_order_tracking_events_tracking_number_check', sql`length(${t.trackingNumber}) > 0`),
    check(
      'purchase_order_tracking_events_description_length_check',
      sql`${t.description} is null
          or length(${t.description}) <= ${sql.raw(String(MAX_PROVIDER_MESSAGE_LENGTH))}`,
    ),
    check(
      'purchase_order_tracking_events_country_check',
      sql`${t.locationCountry} is null or ${t.locationCountry} ~ '^[A-Z]{2}$'`,
    ),
    // The scan's own identity: one carrier reference, one status, one instant.
    // A redelivered webhook and an overlapping poll produce the same triple and
    // converge here rather than doubling the trail.
    uniqueIndex('purchase_order_tracking_events_scan_key').on(
      t.purchaseOrderId,
      t.trackingNumber,
      t.status,
      t.occurredAt,
    ),
    index('purchase_order_tracking_events_po_occurred_idx').on(t.purchaseOrderId, t.occurredAt),
  ],
);

/**
 * `purchase_order_documents` — the supplier invoices and credit notes for one
 * purchase order (#124 SupplierAdapter 11).
 *
 * Metadata only. #128 reconciles these against the purchase order one-to-one
 * (ADR 0004 D6.6) and books what they mean; nothing here books anything, there
 * is no `reconciled` flag beside `purchase_orders.reconciled_at`, and there is
 * no column for the document's bytes or a link to them.
 *
 * Amounts are `bigint({ mode: 'number' })` minor units like every money column
 * in this repository, and carry the document's OWN currency — a supplier
 * invoices in the currency of its agreement, which is the purchase order's, but
 * a credit note against a re-invoiced order can legitimately differ and the
 * column says which rather than assuming.
 */
export const purchaseOrderDocuments = pgTable(
  'purchase_order_documents',
  {
    id: generatedId(),
    purchaseOrderId: text()
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(SUPPLIER_DOCUMENT_KINDS) }).notNull(),
    /** The provider's own document id. Their key space, never a Mercaria key. */
    providerDocumentId: text().notNull(),
    /** The human-readable number printed on it, when the provider gives one. */
    documentNumber: text(),
    currency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    totalAmount: bigint({ mode: 'number' }).notNull(),
    taxAmount: bigint({ mode: 'number' }),
    issuedAt: timestamptz().notNull(),
    retrievedAt: timestamptz().notNull(),
    /** For a credit note, the invoice it reverses — the provider's reference. */
    relatedProviderDocumentId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('purchase_order_documents_kind_check', t.kind, SUPPLIER_DOCUMENT_KINDS),
    ...currencyChecks('purchase_order_documents', [t.currency]),
    check('purchase_order_documents_provider_id_check', sql`length(${t.providerDocumentId}) > 0`),
    // A credit note is negative money and an invoice is positive; both are
    // stored as the magnitude the supplier printed, so both are non-negative
    // and the KIND carries the sign. A signed column would let a credit note be
    // recorded as a positive invoice by a caller that forgot.
    check(
      'purchase_order_documents_amounts_check',
      sql`${t.totalAmount} >= 0 and (${t.taxAmount} is null or ${t.taxAmount} >= 0)`,
    ),
    // Only a credit note may name what it reverses.
    check(
      'purchase_order_documents_related_shape_check',
      sql`${t.relatedProviderDocumentId} is null or ${t.kind} = 'credit_note'`,
    ),
    // A re-retrieval updates the document it already made.
    uniqueIndex('purchase_order_documents_provider_document_key').on(
      t.purchaseOrderId,
      t.kind,
      t.providerDocumentId,
    ),
    index('purchase_order_documents_po_issued_idx').on(t.purchaseOrderId, t.issuedAt),
  ],
);

/**
 * `procurement_exceptions` — the conditions only a person can close.
 *
 * The `payment_discrepancies` relationship (#50): a row here is a RECORDING,
 * and every kind has an idempotent remedy an operator drives rather than a
 * repair this domain performs on its own. Detection and repair are separate
 * acts, and nothing in this domain deletes or rewrites a procurement record to
 * make a mismatch go away.
 *
 * ## One OPEN case per condition, and that is a partial unique
 *
 * `UNIQUE(kind, purchase_order_id) WHERE resolved_at IS NULL`, so two
 * detections of one condition — a webhook and the sweep that noticed the same
 * thing — converge on the case that is already open instead of filling a queue
 * nobody reads. The predicate is what makes a RESOLVED case re-raisable when
 * the condition genuinely recurs.
 *
 * ## `detail` is text and it is REDACTED
 *
 * There is no jsonb bag here, deliberately: an exception's context is composed
 * by Mercaria's own code, which is exactly the shape `services/analytics/`
 * refuses an open bag for. What a person needs is the two ids and a sentence,
 * and the sentence goes through the same provider-message redaction every
 * stored provider string does.
 */
export const procurementExceptions = pgTable(
  'procurement_exceptions',
  {
    id: generatedId(),
    kind: text({ enum: asEnumValues(PROCUREMENT_EXCEPTION_KINDS) }).notNull(),
    purchaseOrderId: text().references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    supplierId: text().references(() => suppliers.id, { onDelete: 'restrict' }),
    supplierAccountId: text().references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    providerEventId: text().references(() => supplierProviderEvents.id, { onDelete: 'restrict' }),
    /** A redacted, bounded sentence. Never a payload, never an address. */
    detail: text().notNull(),
    detectedAt: timestamptz().notNull(),
    resolvedAt: timestamptz(),
    resolution: text({ enum: asEnumValues(PROCUREMENT_EXCEPTION_RESOLUTIONS) }),
    /** An Oxy account id — no foreign key. NULL unless a person closed it. */
    resolvedByOxyUserId: text(),
    resolutionNote: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('procurement_exceptions_kind_check', t.kind, PROCUREMENT_EXCEPTION_KINDS),
    checkOneOf(
      'procurement_exceptions_resolution_check',
      t.resolution,
      PROCUREMENT_EXCEPTION_RESOLUTIONS,
    ),
    check(
      'procurement_exceptions_detail_length_check',
      sql`length(${t.detail}) > 0 and length(${t.detail}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    check(
      'procurement_exceptions_note_length_check',
      sql`${t.resolutionNote} is null
          or length(${t.resolutionNote}) <= ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    // A resolution, a resolver and a time arrive together or not at all: a
    // closed case with nobody's name on it is a case nobody can be asked about.
    check(
      'procurement_exceptions_resolution_shape_check',
      sql`num_nonnulls(${t.resolvedAt}, ${t.resolution}, ${t.resolvedByOxyUserId}) in (0, 3)`,
    ),
    // Something must be nameable, or the row is a sentence about nothing.
    check(
      'procurement_exceptions_subject_check',
      sql`num_nonnulls(${t.purchaseOrderId}, ${t.supplierAccountId}, ${t.providerEventId}) >= 1`,
    ),
    uniqueIndex('procurement_exceptions_open_purchase_order_key')
      .on(t.kind, t.purchaseOrderId)
      .where(sql`${t.resolvedAt} is null and ${t.purchaseOrderId} is not null`),
    // The account-scoped conditions (a rejected credential, an exhausted quota,
    // an event stream lagging) have no purchase order to key on and converge on
    // the account instead.
    uniqueIndex('procurement_exceptions_open_account_key')
      .on(t.kind, t.supplierAccountId)
      .where(sql`${t.resolvedAt} is null and ${t.purchaseOrderId} is null
                 and ${t.supplierAccountId} is not null`),
    index('procurement_exceptions_open_idx')
      .on(t.detectedAt)
      .where(sql`${t.resolvedAt} is null`),
    index('procurement_exceptions_po_idx').on(t.purchaseOrderId, t.detectedAt),
  ],
);
