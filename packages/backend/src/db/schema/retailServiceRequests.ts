/**
 * Retail cancellations, returns, warranties, supplier RMAs and customer refunds
 * (#127, ADR 0004 D2.6/D8.5, diagrams 8–11) — twelve tables.
 *
 * The failure mode this schema is shaped around is a BUYER STRANDED BETWEEN
 * THREE PARTIES: Mercaria says the supplier has not answered, the supplier has
 * no contract with the buyer, and Stripe sees a captured charge with no refund
 * against it. Every table below exists to make one of the three impossible to
 * blame.
 *
 * ## The wall down the middle, and where it is enforced
 *
 * The customer half — `retail_service_requests` and its lines, evidence, events,
 * return case and warranty case — carries no supplier amount, no supplier state
 * and no purchase-order reference. The supplier half —
 * `supplier_return_authorizations` and `supplier_recoveries` — carries no
 * customer amount and no refund pointer. **There is exactly one column joining
 * them**, `supplier_recoveries.service_request_id`, and it points from the
 * supplier side to the customer side and never back: an operator reading a
 * request can find its recoveries, and no query starting from a recovery can
 * change what the buyer is owed.
 *
 * That is ADR 0004 D8.5 as a shape. `retail-service-isolation.test.ts` walks
 * these tables against
 * `RETAIL_SERVICE_FORBIDDEN_CUSTOMER_INPUTS` / `SUPPLIER_RECOVERY_FORBIDDEN_EFFECTS`
 * and fails the build if a column appears on the wrong side of it.
 *
 * ## Nothing here can move money, change an order or touch stock
 *
 * #110 established the posture and it holds unchanged: there is no status
 * column, no payment column, no inventory column and no ledger account column in
 * any of the twelve. A request records what somebody ASKED FOR and what Mercaria
 * DECIDED; the money moves through `refunds` and the `payment_refunded` outbox,
 * and the only trace of it that lands here is `refund_id` — a pointer to a row
 * #49 wrote, never a copy of what it says.
 *
 * The ledger absence is the sharper one. ADR 0004 D7 assigns the five retail
 * accounts and the four transaction kinds to #128 *together with the code that
 * writes them*, so `supplier_recoveries` has no account column and no ledger
 * pointer — it CLASSIFIES a recovery and #128 BOOKS it, the same division
 * `retail_cost_variance_records` (#123) already holds.
 *
 * ## Two deadline columns, never one
 *
 * #127 policy rules 2 and 3 ask that statutory and commercial policy be recorded
 * separately and that a supplier's narrower policy never silently reduce a
 * statutory right. One `deadline_at` column cannot express the second: by the
 * time the two are one number the narrower one has already won and nothing
 * records that it did. So a request stores both and the effective deadline is
 * `resolveEffectiveServiceDeadline`'s LATER of them — arithmetic that can only
 * move a deadline outwards.
 *
 * ## `array_length` is not used anywhere below
 *
 * It is NULL on an empty array and a CHECK reads NULL as satisfied, so
 * `array_length(col, 1) >= 1` admits exactly the row it exists to refuse.
 * Measured twice in this repository already (#108, #68). Every non-emptiness
 * CHECK here reads `cardinality(...)`.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
  type PgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  OPEN_RETAIL_SERVICE_REQUEST_STATES,
  RETAIL_CUSTOMER_OUTCOMES,
  RETAIL_POLICY_EXCEPTION_SOURCES,
  RETAIL_REFUND_SUSPENSION_STATES,
  RETAIL_RETURN_CASE_STATES,
  RETAIL_RETURN_DESTINATIONS,
  RETAIL_RETURN_DISPOSITIONS,
  RETAIL_RETURN_LABEL_SOURCES,
  RETAIL_SERVICE_ACTOR_KINDS,
  RETAIL_SERVICE_COMPLETION_FAILURES,
  RETAIL_SERVICE_EVIDENCE_KINDS,
  RETAIL_SERVICE_NOTE_MAX_LENGTH,
  RETAIL_SERVICE_REQUEST_KINDS,
  RETAIL_SERVICE_REQUEST_ORIGINS,
  RETAIL_SERVICE_REQUEST_STATES,
  RETAIL_WARRANTY_BASES,
  RETAIL_WARRANTY_CASE_STATES,
  RETAIL_WARRANTY_PATHS,
  SUPPLIER_RECOVERY_KINDS,
  SUPPLIER_RECOVERY_STATES,
  SUPPLIER_RETURN_STATES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, optionalMoney } from './columns';
import { categories } from './catalog';
import { guestOrderAccessGrants } from './guestPortal';
import { orderItems, orders, refunds } from './orders';
import { disputes } from './payments';
import { purchaseOrders } from './procurement';

/** The SQL `in (…)` list a partial index's predicate compares against. */
function stateList(states: readonly string[]): string {
  return states.map((state) => `'${state}'`).join(', ');
}

/**
 * The actor CHECK every table here reuses — `order_status_history`'s triple,
 * three domains down and identical to #110's for the same reason.
 *
 * An `oxy` actor carries an Oxy id and no grant, an `operator` carries an Oxy
 * id, a `guest` carries a grant and NO Oxy id, and `system` carries neither. One
 * expression rendered five times rather than five hand-written ones: written out
 * per table, the fifth copy is where somebody permits both.
 */
function actorShapeCheck(
  name: string,
  kind: PgColumn,
  oxyUserId: PgColumn,
  grantId: PgColumn,
) {
  return check(
    name,
    sql`(${kind} = 'oxy' and ${oxyUserId} is not null and ${grantId} is null)
        or (${kind} = 'operator' and ${oxyUserId} is not null and ${grantId} is null)
        or (${kind} = 'guest' and ${oxyUserId} is null)
        or (${kind} = 'system' and ${oxyUserId} is null and ${grantId} is null)`,
  );
}

/* -------------------------------------------------------------------------- */
/*  The customer side                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `retail_service_requests` — one customer asking Mercaria for one remedy on one
 * retail order.
 *
 * ## ONE order, never a checkout group
 *
 * There is no `checkout_group_id` column, for #110 authorization rule 5's
 * reason: "one sibling order cannot authorize a mutation on another
 * automatically" is only structural if there is no shape that could describe
 * two. A buyer whose basket held a retail item and a marketplace item files this
 * against the retail order and a #110 request against the other, and neither can
 * reach the other's seller.
 *
 * ## The open-request unique is what makes a retry converge
 *
 * `UNIQUE(order_id, kind)` partial on the OPEN states, so a double tap, a
 * retried POST and two concurrent submissions collide and the loser reads the
 * winner back. Keyed on the KIND as well as the order because a buyer may
 * legitimately have a warranty claim open on one line while a wrong-item return
 * runs on another — #110's cancellation unique is order-only because there is
 * exactly one thing a cancellation can mean.
 *
 * ## `idempotency_key` is a SECOND converger and both are needed
 *
 * The partial unique converges two attempts on one order+kind; the key converges
 * ONE client's retry after the first was already decided, when the open unique
 * no longer applies. Neither covers the other.
 *
 * ## What is deliberately ABSENT
 *
 * No supplier id, no purchase-order id, no supplier state and no wholesale
 * amount. A request is decided from the order, its lines, its terms snapshot and
 * the clock — #127 responsibility rule 4 and ADR 0004 D8.5 held by the column
 * list rather than by a decision service remembering not to look.
 */
export const retailServiceRequests = pgTable(
  'retail_service_requests',
  {
    id: generatedId(),
    /**
     * RESTRICT, matching every other reference to an order: a request is part of
     * the commercial record of a sale and must never be orphaned from it.
     */
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(RETAIL_SERVICE_REQUEST_KINDS) }).notNull(),
    state: text({ enum: asEnumValues(RETAIL_SERVICE_REQUEST_STATES) })
      .notNull()
      .default('submitted'),
    origin: text({ enum: asEnumValues(RETAIL_SERVICE_REQUEST_ORIGINS) }).notNull(),
    /* --- the requester triple (#110's shape) --- */
    requesterKind: text({ enum: asEnumValues(RETAIL_SERVICE_ACTOR_KINDS) }).notNull(),
    requesterOxyUserId: text(),
    /**
     * The portal grant that authorized it — the access-session audit.
     * `ON DELETE SET NULL` because #108's retention sweep purges grants at 90
     * days and a RESTRICT would deadlock the sweep against every request ever
     * filed.
     */
    requesterGrantId: text().references(() => guestOrderAccessGrants.id, {
      onDelete: 'set null',
    }),
    /** The buyer's own words, bounded. Never a taxonomy's substitute. */
    customerNote: text(),
    /* --- the policy snapshot, TWO deadlines --- */
    /**
     * The terms version the deadlines below were derived under, copied from the
     * order's #126 role snapshot so a request can be explained after the
     * constants have moved on.
     */
    customerTermsVersion: text().notNull(),
    /** The market whose statutory rules were applied — ISO-3166-1 alpha-2. */
    policyMarket: text().notNull(),
    /** NULL when the market grants no statutory minimum for this kind. */
    statutoryDeadlineAt: timestamptz(),
    /** NULL when Mercaria's own policy states nothing about this kind. */
    commercialDeadlineAt: timestamptz(),
    /**
     * The SUPPLIER's clock, tracked separately (#127 policy rule 10).
     *
     * It bounds nothing on the customer side and no CHECK relates it to the two
     * above. That separation is the point: a supplier who never answers lets
     * this instant pass and the request stands exactly where it was, which is
     * policy rule 9 held by the absence of any transition keyed on it.
     */
    supplierResponseDueAt: timestamptz(),
    /** The category exception that decided an `ineligible` verdict, if one did. */
    policyExceptionId: text().references((): AnyPgColumn => retailServicePolicyExceptions.id, {
      onDelete: 'restrict',
    }),
    /* --- the decision --- */
    outcome: text({ enum: asEnumValues(RETAIL_CUSTOMER_OUTCOMES) }),
    outcomeNote: text(),
    decidedAt: timestamptz(),
    deciderKind: text({ enum: asEnumValues(RETAIL_SERVICE_ACTOR_KINDS) }),
    deciderOxyUserId: text(),
    /* --- the financial reference --- */
    /**
     * The #49 refund this request produced. A POINTER, never a copy: the amount,
     * the rail state and the allocation all live on the refund, and reading them
     * from there is what stops this domain and the payment domain disagreeing
     * about whether a buyer was paid.
     */
    refundId: text().references(() => refunds.id, { onDelete: 'restrict' }),
    /**
     * Why a completion did not complete. A bounded code; the retry is the same
     * idempotent call. There is deliberately no `failed` STATE — #110's
     * `payment_repairs` posture.
     */
    completionFailure: text({ enum: asEnumValues(RETAIL_SERVICE_COMPLETION_FAILURES) }),
    completedAt: timestamptz(),
    /**
     * The convergence key one client's retry carries. Sparse-unique, so a
     * request filed without one (an operator's, a system's) is unconstrained.
     */
    idempotencyKey: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('retail_service_requests_kind_check', t.kind, RETAIL_SERVICE_REQUEST_KINDS),
    checkOneOf('retail_service_requests_state_check', t.state, RETAIL_SERVICE_REQUEST_STATES),
    checkOneOf('retail_service_requests_origin_check', t.origin, RETAIL_SERVICE_REQUEST_ORIGINS),
    checkOneOf('retail_service_requests_outcome_check', t.outcome, RETAIL_CUSTOMER_OUTCOMES),
    checkOneOf(
      'retail_service_requests_failure_check',
      t.completionFailure,
      RETAIL_SERVICE_COMPLETION_FAILURES,
    ),
    checkOneOf(
      'retail_service_requests_requester_kind_check',
      t.requesterKind,
      RETAIL_SERVICE_ACTOR_KINDS,
    ),
    checkOneOf(
      'retail_service_requests_decider_kind_check',
      t.deciderKind,
      RETAIL_SERVICE_ACTOR_KINDS,
    ),
    actorShapeCheck(
      'retail_service_requests_requester_check',
      t.requesterKind,
      t.requesterOxyUserId,
      t.requesterGrantId,
    ),
    /**
     * A decision is attributable or absent. There is no third shape: a decided
     * request whose decider is unknown is an unauditable remedy, and a decider
     * on an undecided one is a name attached to nothing.
     */
    check(
      'retail_service_requests_decision_shape_check',
      sql`(${t.decidedAt} is null) = (${t.deciderKind} is null)
          and (${t.decidedAt} is null) = (${t.outcome} is null)
          and (${t.deciderKind} <> 'guest' or ${t.deciderKind} is null)`,
    ),
    /**
     * A GUEST can never be the decider. Mercaria decides a retail remedy
     * (#127 responsibility rule 2), and the shape is what says so — an actor
     * CHECK alone would happily accept `guest` here.
     */
    check(
      'retail_service_requests_decider_authority_check',
      sql`${t.deciderKind} is null or ${t.deciderKind} in ('oxy', 'operator', 'system')`,
    ),
    /**
     * A `system` decider carries no Oxy id, which the actor shape already says;
     * this adds that a decided request has no grant anywhere near it. A portal
     * credential is a buyer's, and a buyer does not decide their own claim.
     */
    check(
      'retail_service_requests_decider_identity_check',
      sql`(${t.deciderKind} in ('oxy', 'operator')) = (${t.deciderOxyUserId} is not null)`,
    ),
    check(
      'retail_service_requests_market_check',
      sql`${t.policyMarket} ~ '^[A-Z]{2}$'`,
    ),
    check(
      'retail_service_requests_terms_check',
      sql`length(btrim(${t.customerTermsVersion})) > 0`,
    ),
    check(
      'retail_service_requests_note_check',
      sql`${t.customerNote} is null
          or (length(${t.customerNote}) between 1 and ${sql.raw(String(RETAIL_SERVICE_NOTE_MAX_LENGTH))})`,
    ),
    check(
      'retail_service_requests_outcome_note_check',
      sql`${t.outcomeNote} is null
          or (length(${t.outcomeNote}) between 1 and ${sql.raw(String(RETAIL_SERVICE_NOTE_MAX_LENGTH))})`,
    ),
    /**
     * A refund pointer implies a decision that could produce one. Without this a
     * `rejected` request could carry a refund id, which is the shape a
     * double-refund hides in: two requests, one rejected, both pointing at money
     * that went out once.
     */
    check(
      'retail_service_requests_refund_shape_check',
      sql`${t.refundId} is null or ${t.outcome} is not null`,
    ),
    /** A completion instant belongs to a terminal state. */
    check(
      'retail_service_requests_completed_shape_check',
      sql`(${t.completedAt} is null)
          = (${t.state} not in ('completed', 'rejected', 'withdrawn', 'cancelled'))`,
    ),
    /**
     * ONE open request per (order, kind). PARTIAL on the open states, whose list
     * is rendered from the same tuple the service reasons about.
     */
    uniqueIndex('retail_service_requests_open_order_kind_key')
      .on(t.orderId, t.kind)
      .where(sql.raw(`state in (${stateList(OPEN_RETAIL_SERVICE_REQUEST_STATES)})`)),
    uniqueIndex('retail_service_requests_idempotency_key')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index('retail_service_requests_order_idx').on(t.orderId, t.createdAt.desc()),
    /** The operator queue: what is still open, oldest first. */
    index('retail_service_requests_open_idx')
      .on(t.createdAt)
      .where(sql.raw(`state in (${stateList(OPEN_RETAIL_SERVICE_REQUEST_STATES)})`)),
    /**
     * The reconciler's cursor: requests whose refund the rail has not settled.
     * Partial, so the sweep never reads a request that has no money in flight.
     */
    index('retail_service_requests_settling_idx')
      .on(t.updatedAt)
      .where(sql`${t.refundId} is not null and ${t.state} = 'in_progress'`),
  ],
);

/**
 * `retail_service_request_lines` — exactly which units of which order lines one
 * request names.
 *
 * FROZEN by trigger once written. #127 acceptance 3 is *"duplicate requests and
 * reordered provider events cannot double-refund, double-cancel or double-return
 * a quantity"*, and a mutable quantity is the mechanism by which they can: a
 * request approved for two units and then edited to five refunds five.
 *
 * The cross-row half — the sum of requested quantities over OPEN and RESOLVED
 * requests never exceeding the order line's own quantity — is not expressible as
 * a CHECK, so the repository is the single writer and refuses before issuing
 * SQL, with the order items locked `FOR UPDATE` first. #126's allocation cap,
 * the same shape and the same reason.
 */
export const retailServiceRequestLines = pgTable(
  'retail_service_request_lines',
  {
    id: generatedId(),
    requestId: text()
      .notNull()
      .references(() => retailServiceRequests.id, { onDelete: 'cascade' }),
    /**
     * RESTRICT: an order line is a commercial record and a request must not be
     * what permits removing one.
     */
    orderItemId: text()
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    /** What the buyer asked for. Frozen. */
    requestedQuantity: integer().notNull(),
    /**
     * What Mercaria approved. NULL until the decision, and the ONLY quantity any
     * refund or return reads — #110's `approved_quantity`, for the same reason:
     * a buyer asking for five of three units must not be able to make the
     * approval arithmetic read their number.
     */
    approvedQuantity: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('retail_service_request_lines_requested_check', sql`${t.requestedQuantity} >= 1`),
    check(
      'retail_service_request_lines_approved_check',
      sql`${t.approvedQuantity} is null
          or (${t.approvedQuantity} >= 0 and ${t.approvedQuantity} <= ${t.requestedQuantity})`,
    ),
    /**
     * One row per (request, line). Two would let one request name the same units
     * twice, and the cross-row cap the repository enforces would still be
     * satisfied by the sum — a duplicate hiding inside a correct total.
     */
    uniqueIndex('retail_service_request_lines_request_item_key').on(t.requestId, t.orderItemId),
    index('retail_service_request_lines_item_idx').on(t.orderItemId),
  ],
);

/**
 * `retail_service_request_evidence` — declared Oxy file references.
 *
 * A bare `file_id`, never a URL and never a `mercaria.co` one: the moderation
 * domain establishes why, and #110 already adopted it. Mercaria holds no Oxy
 * service credential, so it cannot read the file's metadata, compute a digest or
 * scan it — and asserting any of the three would be worse than admitting it has
 * none.
 */
export const retailServiceRequestEvidence = pgTable(
  'retail_service_request_evidence',
  {
    id: generatedId(),
    requestId: text()
      .notNull()
      .references(() => retailServiceRequests.id, { onDelete: 'cascade' }),
    kind: text({ enum: asEnumValues(RETAIL_SERVICE_EVIDENCE_KINDS) }).notNull(),
    /** An Oxy storage file id. No foreign key — Oxy owns that namespace. */
    fileId: text().notNull(),
    caption: text(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'retail_service_request_evidence_kind_check',
      t.kind,
      RETAIL_SERVICE_EVIDENCE_KINDS,
    ),
    check('retail_service_request_evidence_file_check', sql`length(btrim(${t.fileId})) > 0`),
    /**
     * A `mercaria.co` reference is refused at the row. The service refuses one
     * too, and both are needed: the service protects the ordinary path, and this
     * protects a backfill, a replay and `psql`.
     */
    check(
      'retail_service_request_evidence_bare_id_check',
      sql`${t.fileId} !~ '^https?://' and ${t.fileId} !~ 'mercaria'`,
    ),
    check('retail_service_request_evidence_position_check', sql`${t.position} >= 0`),
    uniqueIndex('retail_service_request_evidence_file_key').on(t.requestId, t.fileId),
    index('retail_service_request_evidence_request_idx').on(t.requestId, t.position),
  ],
);

/**
 * `retail_service_request_events` — the append-only trail.
 *
 * APPEND-ONLY against UPDATE *and* DELETE by trigger, and its foreign key is
 * RESTRICT rather than CASCADE so the declaration and the trigger agree. A
 * cascade would be a way to delete the audit by deleting its parent, which is
 * the one deletion an operator covering something up would reach for.
 *
 * The trail is what makes #127 acceptance 6 checkable — *"a missing or rejected
 * supplier credit does not corrupt an owed customer refund"* — because the two
 * sides' events sit in one ordered list and a reader can see that the refund
 * event preceded the supplier's answer rather than following it.
 */
export const retailServiceRequestEvents = pgTable(
  'retail_service_request_events',
  {
    id: generatedId(),
    requestId: text()
      .notNull()
      .references(() => retailServiceRequests.id, { onDelete: 'restrict' }),
    /**
     * A bounded code. Free text here would be the one place a supplier's own
     * words, and with them a supplier's identity, reached a trail an operator
     * screen renders beside customer copy.
     */
    kind: text().notNull(),
    /** The state the request was in AFTER this event, when the event moved it. */
    resultingState: text({ enum: asEnumValues(RETAIL_SERVICE_REQUEST_STATES) }),
    actorKind: text({ enum: asEnumValues(RETAIL_SERVICE_ACTOR_KINDS) }).notNull(),
    actorOxyUserId: text(),
    actorGrantId: text().references(() => guestOrderAccessGrants.id, { onDelete: 'set null' }),
    /** A bounded operator/system note. Never a provider payload. */
    detail: text(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'retail_service_request_events_state_check',
      t.resultingState,
      RETAIL_SERVICE_REQUEST_STATES,
    ),
    checkOneOf(
      'retail_service_request_events_actor_kind_check',
      t.actorKind,
      RETAIL_SERVICE_ACTOR_KINDS,
    ),
    actorShapeCheck(
      'retail_service_request_events_actor_check',
      t.actorKind,
      t.actorOxyUserId,
      t.actorGrantId,
    ),
    check('retail_service_request_events_kind_check', sql`length(btrim(${t.kind})) > 0`),
    check(
      'retail_service_request_events_detail_check',
      sql`${t.detail} is null
          or (length(${t.detail}) between 1 and ${sql.raw(String(RETAIL_SERVICE_NOTE_MAX_LENGTH))})`,
    ),
    index('retail_service_request_events_request_idx').on(t.requestId, t.createdAt),
  ],
);

/**
 * `retail_service_policy_exceptions` — the explicit, reviewed category carve-outs
 * #127 policy rule 7 demands.
 *
 * EU consumer law really does carve categories out of the withdrawal right
 * (sealed hygiene goods, custom-made items, perishables), so this is a real
 * mechanism and not a hedge. What makes it safe is the SOURCE column: an
 * exception cites a statutory instrument or Mercaria's own reviewed policy, and
 * `RETAIL_FORBIDDEN_POLICY_EXCEPTION_SOURCES` is disjoint from that set — so a
 * supplier's narrower returns policy has no value it could be recorded under and
 * cannot reduce a customer right by being written down.
 *
 * FOUR EYES: `reviewed_by` must differ from `requested_by`, by CHECK. One person
 * can type two ids (#55's reasoning), so this is a floor rather than a proof —
 * but removing a consumer right is exactly the decision that should cost two
 * names.
 *
 * IMMUTABLE once active, by trigger. An exception is snapshotted onto real
 * requests as the reason somebody was refused, and editing it afterwards rewrites
 * what those buyers were told.
 */
export const retailServicePolicyExceptions = pgTable(
  'retail_service_policy_exceptions',
  {
    id: generatedId(),
    /** ISO-3166-1 alpha-2 of the market the exception applies in. */
    market: text().notNull(),
    /**
     * RESTRICT: an exception names the goods it covers, and deleting the
     * category out from under it would silently widen it to everything.
     */
    categoryId: text()
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    /** Which request kinds it removes. Non-empty by CHECK. */
    excludedKinds: text().array().notNull(),
    source: text({ enum: asEnumValues(RETAIL_POLICY_EXCEPTION_SOURCES) }).notNull(),
    /** The instrument or policy document, cited so a refusal can be explained. */
    legalBasis: text().notNull(),
    requestedByOxyUserId: text().notNull(),
    reviewedByOxyUserId: text().notNull(),
    reviewedAt: timestamptz().notNull(),
    /** NULL while live. A withdrawn exception stays for the requests it decided. */
    withdrawnAt: timestamptz(),
    withdrawnByOxyUserId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'retail_service_policy_exceptions_source_check',
      t.source,
      RETAIL_POLICY_EXCEPTION_SOURCES,
    ),
    check('retail_service_policy_exceptions_market_check', sql`${t.market} ~ '^[A-Z]{2}$'`),
    /**
     * `cardinality`, never `array_length` — the latter is NULL on `{}` and a
     * CHECK reads NULL as satisfied, so the obvious spelling admits an exception
     * that excludes nothing while claiming to exclude something.
     */
    check(
      'retail_service_policy_exceptions_kinds_check',
      sql`cardinality(${t.excludedKinds}) >= 1
          and ${t.excludedKinds} <@ ${sql.raw(
            `array[${RETAIL_SERVICE_REQUEST_KINDS.map((k) => `'${k}'`).join(', ')}]::text[]`,
          )}`,
    ),
    check(
      'retail_service_policy_exceptions_basis_check',
      sql`length(btrim(${t.legalBasis})) > 0`,
    ),
    check(
      'retail_service_policy_exceptions_four_eyes_check',
      sql`${t.reviewedByOxyUserId} <> ${t.requestedByOxyUserId}`,
    ),
    check(
      'retail_service_policy_exceptions_withdrawn_shape_check',
      sql`(${t.withdrawnAt} is null) = (${t.withdrawnByOxyUserId} is null)`,
    ),
    /**
     * One LIVE exception per (market, category). Two operators publishing the
     * same carve-out converge rather than doubling it; a withdrawn one no longer
     * occupies the slot, so a policy can be replaced.
     */
    uniqueIndex('retail_service_policy_exceptions_live_key')
      .on(t.market, t.categoryId)
      .where(sql`${t.withdrawnAt} is null`),
    index('retail_service_policy_exceptions_category_idx').on(t.categoryId),
  ],
);

/* -------------------------------------------------------------------------- */
/*  Return cases                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `retail_return_cases` — ONE internal case per request that brings goods back
 * (#127 return rule 1).
 *
 * ## The destination is Mercaria's decision and the buyer never learns it
 *
 * Return rule 5 is *"do not expose the supplier as customer support merely
 * because the return goes to its facility"*. `destination` and every supplier
 * handle on this row are in `PROTECTED_COLUMNS`, and the customer projection is
 * a different TYPE rather than a filtered one — `RetailServiceReturnCaseView`
 * has no destination member at all, so a serializer that reached for one would
 * fail `tsc`.
 *
 * ## The label is a SEAM and it fails closed
 *
 * Return rule 6 permits exactly two sources: a supplier RMA label and an
 * approved carrier. No registered supplier adapter declares
 * `return_authorization`, and Moovo reverse transport is #159 and unbuilt — so
 * `label_source` is `unavailable` in this deployment and `label_reference` is
 * NULL. Composing an address or a label here is precisely what rule 6 forbids
 * and what #126's logistics gate fails the build over.
 */
export const retailReturnCases = pgTable(
  'retail_return_cases',
  {
    id: generatedId(),
    /**
     * RESTRICT and UNIQUE: exactly one case per request (rule 1), and the case
     * cannot be what permits deleting the request that authorized it.
     */
    requestId: text()
      .notNull()
      .references(() => retailServiceRequests.id, { onDelete: 'restrict' }),
    state: text({ enum: asEnumValues(RETAIL_RETURN_CASE_STATES) })
      .notNull()
      .default('authorization_pending'),
    destination: text({ enum: asEnumValues(RETAIL_RETURN_DESTINATIONS) }).notNull(),
    /**
     * The supplier RMA behind this case, when the destination is a supplier and
     * one was obtained. NULL is the shipped state of this deployment.
     */
    supplierReturnAuthorizationId: text().references(
      (): AnyPgColumn => supplierReturnAuthorizations.id,
      { onDelete: 'restrict' },
    ),
    labelSource: text({ enum: asEnumValues(RETAIL_RETURN_LABEL_SOURCES) })
      .notNull()
      .default('unavailable'),
    /**
     * The carrier or supplier's own handle for the label. PROTECTED — it is a
     * cross-service correlation key for somebody's parcel.
     */
    labelReference: text(),
    /** The copy key #129 renders. Never a composed address or drop-off point. */
    instructionsKey: text(),
    /** By when the buyer must send it. Mercaria's own answer to "by when". */
    shipBackDeadlineAt: timestamptz(),
    /** What inspection concluded, as a bounded code. */
    inspectionOutcome: text(),
    inspectedAt: timestamptz(),
    closedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('retail_return_cases_state_check', t.state, RETAIL_RETURN_CASE_STATES),
    checkOneOf(
      'retail_return_cases_destination_check',
      t.destination,
      RETAIL_RETURN_DESTINATIONS,
    ),
    checkOneOf(
      'retail_return_cases_label_source_check',
      t.labelSource,
      RETAIL_RETURN_LABEL_SOURCES,
    ),
    /**
     * A label reference implies a real source. Without this, a case could carry
     * a reference under `unavailable` — a label nobody can explain the origin
     * of, which rule 6 exists to make impossible.
     */
    check(
      'retail_return_cases_label_shape_check',
      sql`(${t.labelReference} is null) or (${t.labelSource} <> 'unavailable')`,
    ),
    /**
     * A supplier RMA belongs to a supplier-destined return. Attaching one to a
     * return coming to Mercaria would be a claim against a supplier for goods
     * they never receive.
     */
    check(
      'retail_return_cases_rma_destination_check',
      sql`${t.supplierReturnAuthorizationId} is null or ${t.destination} = 'supplier'`,
    ),
    check(
      'retail_return_cases_inspection_shape_check',
      sql`(${t.inspectedAt} is null) = (${t.inspectionOutcome} is null)`,
    ),
    /**
     * A deadline with no instructions behind it is a date nobody was told about.
     * #110's `return_instructions` CHECK, one domain over.
     */
    check(
      'retail_return_cases_deadline_shape_check',
      sql`${t.shipBackDeadlineAt} is null or ${t.instructionsKey} is not null`,
    ),
    uniqueIndex('retail_return_cases_request_key').on(t.requestId),
    index('retail_return_cases_open_idx')
      .on(t.createdAt)
      .where(sql`${t.closedAt} is null`),
  ],
);

/**
 * `retail_return_case_lines` — the units one case authorizes, frozen.
 *
 * The authorized quantity is what the buyer was told to send and is the
 * denominator every disposition sums against. Frozen by trigger for the reason
 * the request's lines are: an editable authorization is how three units become
 * five between the decision and the refund.
 */
export const retailReturnCaseLines = pgTable(
  'retail_return_case_lines',
  {
    id: generatedId(),
    returnCaseId: text()
      .notNull()
      .references(() => retailReturnCases.id, { onDelete: 'cascade' }),
    orderItemId: text()
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    authorizedQuantity: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('retail_return_case_lines_quantity_check', sql`${t.authorizedQuantity} >= 1`),
    uniqueIndex('retail_return_case_lines_case_item_key').on(t.returnCaseId, t.orderItemId),
    index('retail_return_case_lines_item_idx').on(t.orderItemId),
  ],
);

/**
 * `retail_return_line_dispositions` — APPEND-ONLY quantity movements.
 *
 * #127 return rule 10 is *"prevent the same quantity from being returned or
 * refunded twice"*, and a mutable `received_quantity` column is exactly how it
 * is not prevented: two concurrent scans both read three and both write six.
 * Movements SUM instead, the repository holds the cross-row cap with the case
 * line locked `FOR UPDATE`, and the trail says who reported what and when.
 *
 * That trail is also rule 12's lost-parcel escalation: "we shipped four and
 * received none" is two rows a query can find, where a pair of counters is an
 * absence nobody notices.
 *
 * **There is no amount column here, deliberately.** `credited` is a supplier
 * fact recorded on the customer's case so an operator sees both sides in one
 * list; the money is on `supplier_recoveries`, and a figure here would be the
 * first place a customer projection could reach one.
 */
export const retailReturnLineDispositions = pgTable(
  'retail_return_line_dispositions',
  {
    id: generatedId(),
    returnCaseLineId: text()
      .notNull()
      .references(() => retailReturnCaseLines.id, { onDelete: 'restrict' }),
    disposition: text({ enum: asEnumValues(RETAIL_RETURN_DISPOSITIONS) }).notNull(),
    quantity: integer().notNull(),
    /** Who reported it — a buyer, an operator, a supplier event, a sweep. */
    actorKind: text({ enum: asEnumValues(RETAIL_SERVICE_ACTOR_KINDS) }).notNull(),
    actorOxyUserId: text(),
    actorGrantId: text().references(() => guestOrderAccessGrants.id, { onDelete: 'set null' }),
    /** When the reporter observed it, not when Mercaria stored it. */
    observedAt: timestamptz().notNull(),
    /**
     * The convergence key. A redelivered supplier event, a re-run sweep and an
     * operator's retry all carry the same one and write the movement once.
     */
    idempotencyKey: text().notNull(),
    detail: text(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'retail_return_line_dispositions_disposition_check',
      t.disposition,
      RETAIL_RETURN_DISPOSITIONS,
    ),
    checkOneOf(
      'retail_return_line_dispositions_actor_kind_check',
      t.actorKind,
      RETAIL_SERVICE_ACTOR_KINDS,
    ),
    actorShapeCheck(
      'retail_return_line_dispositions_actor_check',
      t.actorKind,
      t.actorOxyUserId,
      t.actorGrantId,
    ),
    check('retail_return_line_dispositions_quantity_check', sql`${t.quantity} >= 1`),
    check(
      'retail_return_line_dispositions_key_check',
      sql`length(btrim(${t.idempotencyKey})) > 0`,
    ),
    uniqueIndex('retail_return_line_dispositions_key').on(t.idempotencyKey),
    index('retail_return_line_dispositions_line_idx').on(t.returnCaseLineId, t.observedAt),
  ],
);

/* -------------------------------------------------------------------------- */
/*  Warranty                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `retail_warranty_cases` — the durable case #127 §"Warranty and legal
 * guarantee" asks for, capable of representing all twelve of its facts.
 *
 * The one to read is `replacement_purchase_order_id`. #127 warranty item 9 asks
 * the case to be *capable of representing* a replacement procurement order, and
 * the column is here — but nothing writes it, because #124 derives a purchase
 * order's idempotency key as `po:<orderId>:<supplierId>` and a replacement is a
 * SECOND purchase order under that same pair. That key is deliberate and
 * load-bearing (it is what makes a redelivered success, a reclaimed lease and an
 * operator retry converge on one purchase order), so a replacement is a change
 * #124 owns rather than a function missing here.
 *
 * `repeat_failure_count` is item 11 and is a COUNTER rather than a derived
 * query, uniquely in this schema, because the thing it counts spans cases: EU
 * conformity law escalates on repeated failure of the SAME goods, and a case
 * that could only count itself would always read one.
 */
export const retailWarrantyCases = pgTable(
  'retail_warranty_cases',
  {
    id: generatedId(),
    requestId: text()
      .notNull()
      .references(() => retailServiceRequests.id, { onDelete: 'restrict' }),
    state: text({ enum: asEnumValues(RETAIL_WARRANTY_CASE_STATES) })
      .notNull()
      .default('reported'),
    basis: text({ enum: asEnumValues(RETAIL_WARRANTY_BASES) }).notNull(),
    /** Which body honours it. Never disclosed to the buyer. */
    path: text({ enum: asEnumValues(RETAIL_WARRANTY_PATHS) }).notNull(),
    /** When the customer reported the defect — item 1, and the clock's origin. */
    reportedAt: timestamptz().notNull(),
    /** The market whose guarantee period applies — item 3. */
    guaranteeMarket: text().notNull(),
    /** Months, snapshotted from the order's own terms so it cannot move. */
    guaranteeMonths: integer().notNull(),
    /** When the guarantee expires, derived once at report time and stored. */
    guaranteeExpiresAt: timestamptz().notNull(),
    /** Item 2 — a serial or lot the buyer supplied, where relevant. */
    serialNumber: text(),
    lotNumber: text(),
    /** Item 6 — the copy key for shipping and diagnostic instructions. */
    instructionsKey: text(),
    /** Item 7 — a bounded code for what the supplier or manufacturer said. */
    supplierResponse: text(),
    supplierRespondedAt: timestamptz(),
    /** Item 8 — the customer-facing deadline, Mercaria's own. */
    customerDeadlineAt: timestamptz(),
    /**
     * Item 9 — the replacement procurement order. Nothing writes it; see the
     * table docblock.
     */
    replacementPurchaseOrderId: text().references(() => purchaseOrders.id, {
      onDelete: 'restrict',
    }),
    /** Item 11 — repeated defect or failed repair, across cases on these goods. */
    repeatFailureCount: integer().notNull().default(0),
    /** Item 12 — escalated to product safety. */
    safetyEscalatedAt: timestamptz(),
    safetyEscalationReason: text(),
    resolvedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('retail_warranty_cases_state_check', t.state, RETAIL_WARRANTY_CASE_STATES),
    checkOneOf('retail_warranty_cases_basis_check', t.basis, RETAIL_WARRANTY_BASES),
    checkOneOf('retail_warranty_cases_path_check', t.path, RETAIL_WARRANTY_PATHS),
    check('retail_warranty_cases_market_check', sql`${t.guaranteeMarket} ~ '^[A-Z]{2}$'`),
    /**
     * A guarantee is a real duration. A zero-month guarantee is not a shorter
     * policy, it is a legal minimum recorded as absent — and a case is the one
     * place that would never be questioned afterwards. #126's window CHECK, one
     * domain over.
     */
    check('retail_warranty_cases_months_check', sql`${t.guaranteeMonths} >= 1`),
    check(
      'retail_warranty_cases_expiry_check',
      sql`${t.guaranteeExpiresAt} > ${t.reportedAt}`,
    ),
    check('retail_warranty_cases_repeat_check', sql`${t.repeatFailureCount} >= 0`),
    check(
      'retail_warranty_cases_supplier_response_shape_check',
      sql`(${t.supplierResponse} is null) = (${t.supplierRespondedAt} is null)`,
    ),
    /**
     * A safety escalation is always explained. An escalation with no reason is
     * the shape a recall gets raised in by accident and never withdrawn.
     */
    check(
      'retail_warranty_cases_safety_shape_check',
      sql`(${t.safetyEscalatedAt} is null) = (${t.safetyEscalationReason} is null)
          and (${t.safetyEscalatedAt} is null or ${t.state} = 'escalated_safety')`,
    ),
    uniqueIndex('retail_warranty_cases_request_key').on(t.requestId),
    index('retail_warranty_cases_open_idx')
      .on(t.reportedAt)
      .where(sql`${t.resolvedAt} is null`),
    /** The safety queue: everything escalated, newest first. */
    index('retail_warranty_cases_safety_idx')
      .on(t.safetyEscalatedAt.desc())
      .where(sql`${t.safetyEscalatedAt} is not null`),
  ],
);

/* -------------------------------------------------------------------------- */
/*  The supplier side                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `supplier_return_authorizations` — the RMA table #124 named and left to #127.
 *
 * #124 built the adapter contract (`createReturn` / `readReturn`, the
 * `return_authorization` capability, `SupplierReturn` and
 * `SUPPLIER_RETURN_STATES`) and stopped there, because an RMA is a consequence
 * of a CUSTOMER decision and the procurement domain must not know one was made.
 * This is the row that consequence lands in.
 *
 * It sits on the SUPPLIER side of the wall: no customer amount, no refund
 * pointer, no request id. The join runs the other way — a return case names its
 * RMA — so a query starting here cannot reach what the buyer is owed.
 *
 * `state` is #124's own vocabulary rather than a second normalization, because
 * two normalizations of one supplier fact disagree in the direction nobody
 * notices. `provider_reference` is PROTECTED: it is a handle in somebody else's
 * key space that identifies this order to that supplier.
 */
export const supplierReturnAuthorizations = pgTable(
  'supplier_return_authorizations',
  {
    id: generatedId(),
    /**
     * RESTRICT: an RMA is a claim against a purchase order and must never be
     * orphaned from it.
     */
    purchaseOrderId: text()
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    state: text({ enum: asEnumValues(SUPPLIER_RETURN_STATES) }).notNull().default('requested'),
    /** The supplier's own RMA reference, once they gave one. PROTECTED. */
    providerReference: text(),
    /**
     * Mercaria's normalized reason, never the supplier's vocabulary and never
     * the customer's words — a bounded code the adapter maps.
     */
    reasonCode: text().notNull(),
    /** By when the supplier said the goods must arrive. Their clock, not ours. */
    supplierDeadlineAt: timestamptz(),
    /**
     * Why no authorization exists, when none does. A bounded code, and the
     * shipped value in this deployment is `capability_not_declared`: no
     * registered adapter declares `return_authorization`, so #124's chokepoint
     * refuses before any provider is called.
     */
    unavailableReason: text(),
    requestedAt: timestamptz().notNull(),
    authorizedAt: timestamptz(),
    closedAt: timestamptz(),
    /** The convergence key — one RMA request per (purchase order, attempt key). */
    idempotencyKey: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'supplier_return_authorizations_state_check',
      t.state,
      SUPPLIER_RETURN_STATES,
    ),
    check(
      'supplier_return_authorizations_reason_check',
      sql`length(btrim(${t.reasonCode})) > 0`,
    ),
    check(
      'supplier_return_authorizations_key_check',
      sql`length(btrim(${t.idempotencyKey})) > 0`,
    ),
    /**
     * An `authorized` RMA has a provider reference and an instant; anything else
     * has neither. Without this, a case could claim a supplier authorized a
     * return that was never asked for — and the buyer would be told to post
     * goods to a warehouse expecting nothing.
     */
    check(
      'supplier_return_authorizations_authorized_shape_check',
      sql`(${t.state} = 'authorized' or ${t.state} = 'received' or ${t.state} = 'closed')
          = (${t.authorizedAt} is not null)`,
    ),
    /**
     * An unavailable reason and an authorization are mutually exclusive. Both at
     * once is a row that says the RMA both exists and could not be obtained.
     */
    check(
      'supplier_return_authorizations_unavailable_shape_check',
      sql`${t.unavailableReason} is null or ${t.authorizedAt} is null`,
    ),
    uniqueIndex('supplier_return_authorizations_key').on(t.idempotencyKey),
    index('supplier_return_authorizations_po_idx').on(t.purchaseOrderId, t.createdAt.desc()),
    index('supplier_return_authorizations_open_idx')
      .on(t.requestedAt)
      .where(sql`${t.closedAt} is null`),
  ],
);

/**
 * `supplier_recoveries` — the normalized record of what Mercaria is trying to
 * get back from a supplier (#127 §"Supplier credits and recoveries", all ten
 * kinds).
 *
 * ## It BOOKS NOTHING, and the absence of an account column is the enforcement
 *
 * ADR 0004 D7 names five retail ledger accounts and four transaction kinds and
 * assigns them to #128 *together with the code that writes them*. So there is no
 * `ledger_account` column, no `ledger_transaction_id` and no import of the
 * ledger repository anywhere in this domain —
 * `SUPPLIER_RECOVERY_FORBIDDEN_EFFECTS` names the prohibition as values and
 * `retail-service-isolation.test.ts` asserts it. #123's
 * `retail_cost_variance_records` holds exactly this division already, and the
 * reason is the same: a domain that both decides an amount and books it has no
 * independent record to reconcile against.
 *
 * ## `service_request_id` points one way
 *
 * It is the ONLY column joining the supplier half to the customer half, and it
 * exists so an operator screen can show the two side by side. Nothing reads it
 * in the other direction: no customer projection carries a recovery, and no
 * function in this domain takes a recovery and returns a customer amount.
 *
 * ## `rejected` is an ordinary terminal state
 *
 * #127 responsibility rule 4 — *"a supplier rejecting a credit does not
 * automatically remove a refund or remedy already owed to the customer"* — is
 * held by that state living on a row no customer path reads.
 */
export const supplierRecoveries = pgTable(
  'supplier_recoveries',
  {
    id: generatedId(),
    kind: text({ enum: asEnumValues(SUPPLIER_RECOVERY_KINDS) }).notNull(),
    state: text({ enum: asEnumValues(SUPPLIER_RECOVERY_STATES) }).notNull().default('claimed'),
    purchaseOrderId: text()
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    supplierReturnAuthorizationId: text().references(() => supplierReturnAuthorizations.id, {
      onDelete: 'restrict',
    }),
    /**
     * The customer request this recovery accompanies, when there is one. The one
     * column joining the two halves — see the table docblock. `set null` because
     * a recovery outlives the customer matter it arose from: a credit note can
     * arrive after a request is closed and archived, and losing the recovery
     * would lose money Mercaria is owed.
     */
    serviceRequestId: text().references((): AnyPgColumn => retailServiceRequests.id, {
      onDelete: 'set null',
    }),
    /** What Mercaria claimed, in the SUPPLIER's currency. */
    ...optionalMoney('expected'),
    /** What the supplier actually credited. */
    ...optionalMoney('credited'),
    /** The supplier's credit-note reference, once issued. PROTECTED. */
    creditNoteReference: text(),
    /** Why the supplier refused, as a bounded code. */
    rejectionReason: text(),
    openedAt: timestamptz().notNull(),
    closedAt: timestamptz(),
    /** The convergence key — a redelivered supplier event records once. */
    idempotencyKey: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('supplier_recoveries_kind_check', t.kind, SUPPLIER_RECOVERY_KINDS),
    checkOneOf('supplier_recoveries_state_check', t.state, SUPPLIER_RECOVERY_STATES),
    ...currencyChecks('supplier_recoveries', [t.expectedCurrency, t.creditedCurrency]),
    check(
      'supplier_recoveries_amounts_check',
      sql`(${t.expectedAmount} is null or ${t.expectedAmount} >= 0)
          and (${t.creditedAmount} is null or ${t.creditedAmount} >= 0)`,
    ),
    /**
     * An amount names its currency. `optionalMoney` makes the pair nullable and
     * says nothing about them being nullable TOGETHER, so a figure with no
     * currency is representable without this — and raw minor units with no
     * currency are how two suppliers' credits get added together.
     */
    check(
      'supplier_recoveries_money_pair_check',
      sql`(${t.expectedAmount} is null) = (${t.expectedCurrency} is null)
          and (${t.creditedAmount} is null) = (${t.creditedCurrency} is null)`,
    ),
    /**
     * A `credited` or `settled` recovery names what was credited. Without this a
     * recovery could report success with no figure, which is how a reconciliation
     * that thinks it balanced never notices the money did not arrive.
     */
    check(
      'supplier_recoveries_credited_shape_check',
      sql`${t.state} not in ('credited', 'settled') or ${t.creditedAmount} is not null`,
    ),
    /** A rejection is explained. */
    check(
      'supplier_recoveries_rejection_shape_check',
      sql`(${t.state} = 'rejected') = (${t.rejectionReason} is not null)`,
    ),
    check(
      'supplier_recoveries_closed_shape_check',
      sql`(${t.closedAt} is null)
          = (${t.state} not in ('settled', 'rejected', 'abandoned'))`,
    ),
    check('supplier_recoveries_key_check', sql`length(btrim(${t.idempotencyKey})) > 0`),
    /**
     * A `rejected_claim` recovery is the record of a refusal and can never carry
     * money. The kind and the state are two facts and this is where they must
     * agree, because an operator reading a recovery list sorts by kind.
     */
    check(
      'supplier_recoveries_rejected_kind_check',
      sql`${t.kind} <> 'rejected_claim' or ${t.creditedAmount} is null`,
    ),
    uniqueIndex('supplier_recoveries_key').on(t.idempotencyKey),
    index('supplier_recoveries_po_idx').on(t.purchaseOrderId, t.openedAt.desc()),
    index('supplier_recoveries_request_idx')
      .on(t.serviceRequestId)
      .where(sql`${t.serviceRequestId} is not null`),
    /** The operator queue: what is still outstanding, oldest first. */
    index('supplier_recoveries_open_idx')
      .on(t.openedAt)
      .where(sql`${t.closedAt} is null`),
  ],
);

/* -------------------------------------------------------------------------- */
/*  Chargeback coordination                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `retail_dispute_coordinations` — one card dispute, tied to one retail order,
 * with the refund suspension it implies.
 *
 * ## Why this is not just a column on `disputes`
 *
 * #49's `disputes` is the payment domain's record of what the rail said. This is
 * MERCARIA's decision about what to do while it runs, and the two have different
 * writers, different lifetimes and different readers. Putting a suspension flag
 * on `disputes` would make the payment domain — which #123's `role-separation`
 * gate keeps free of everything built on top of it — the authority on a customer
 * service policy.
 *
 * ## The suspension is the point (#127 chargeback rules 5 and 10)
 *
 * While `suspension = 'suspended'`, `assertRefundNotSuspended` refuses the
 * automatic refund path and the request records `dispute_suspension` as its
 * completion failure. That is *"suspend duplicate refund paths according to an
 * explicit policy"* — explicit because it is a stored value with a stored
 * reason, not a branch somebody can read two ways.
 *
 * Releasing it is an operator act with a mandatory reason, so a refund issued
 * while a dispute is open is a decision somebody made and can be shown to have
 * made. The word in rule 10 is *unnoticed*; a deliberate double payment is
 * sometimes right, and an unnoticed one never is.
 */
export const retailDisputeCoordinations = pgTable(
  'retail_dispute_coordinations',
  {
    id: generatedId(),
    /** RESTRICT: nothing deletes a financial aggregate. */
    disputeId: text()
      .notNull()
      .references(() => disputes.id, { onDelete: 'restrict' }),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    /**
     * The coordination request this opened. NULL until one exists — the dispute
     * event arrives first and the request is created from it.
     */
    serviceRequestId: text().references((): AnyPgColumn => retailServiceRequests.id, {
      onDelete: 'set null',
    }),
    suspension: text({ enum: asEnumValues(RETAIL_REFUND_SUSPENSION_STATES) })
      .notNull()
      .default('suspended'),
    /** Why the suspension was released. Mandatory on release, by CHECK. */
    suspensionReason: text(),
    releasedByOxyUserId: text(),
    releasedAt: timestamptz(),
    /**
     * Whether Mercaria has assembled the fulfilment, tracking, support and
     * return evidence #127 chargeback rule 2 asks be preserved. A BOOLEAN and
     * not the evidence itself: the evidence is the order, its status history,
     * its support thread and its return case, all of which already exist and are
     * append-only. Copying them here would be a second version somebody submits.
     */
    evidenceAssembledAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'retail_dispute_coordinations_suspension_check',
      t.suspension,
      RETAIL_REFUND_SUSPENSION_STATES,
    ),
    /**
     * A release is attributable, dated and explained — all three or none. A
     * release with no reason is exactly the unnoticed duplicate refund rule 10
     * forbids, wearing an audit trail.
     */
    check(
      'retail_dispute_coordinations_release_shape_check',
      sql`(${t.suspension} = 'released')
          = (${t.suspensionReason} is not null
             and ${t.releasedByOxyUserId} is not null
             and ${t.releasedAt} is not null)`,
    ),
    /** One coordination per dispute. A redelivered dispute event converges. */
    uniqueIndex('retail_dispute_coordinations_dispute_key').on(t.disputeId),
    /**
     * The refund gate's read: is anything suspending refunds on this order?
     * PARTIAL, so the check costs an index probe over the suspended rows alone.
     */
    index('retail_dispute_coordinations_suspended_idx')
      .on(t.orderId)
      .where(sql`${t.suspension} = 'suspended'`),
  ],
);

