/**
 * Buyer post-purchase requests — cancellations, returns and support (#110).
 *
 * Eight tables: `cancellation_requests` and `cancellation_request_lines`,
 * `return_requests`, `return_request_lines` and `return_request_evidence`,
 * `support_threads` and `support_messages`, and the shared append-only
 * `buyer_request_events`.
 *
 * ## The one property the schema exists to hold
 *
 * **Nothing here can change an order.** There is no status column, no payment
 * column, no money column and no inventory column in any of the eight. A
 * request records what somebody ASKED FOR and what somebody DECIDED; the order
 * moves through `order.service.transition` and the money through
 * `refund.service.process`, and the only trace of either that lands here is
 * `refund_id` — a pointer to a row those services wrote, never a copy of what
 * it says. So "a guest cannot mutate status or provider payment directly"
 * (acceptance 2) survives a service bug, a replay and `psql`.
 *
 * ## What is deliberately ABSENT
 *
 * No email in any form, no phone, no postal address, no email hash, no guest
 * session id, no payment-method detail, no card fingerprint and no IP address.
 * A request is identified by its ORDER; the contact it would be answered to is
 * one join away on `guest_checkouts` and is read only by the send path.
 * `BUYER_REQUEST_FORBIDDEN_IDENTIFIERS` names the prohibition as a value, and
 * three different layers hold it: `authorization.ts`, where
 * `BuyerRequestCredential` has no member any of them could arrive in;
 * `buyer-request-isolation.test.ts`, which scans the request SCHEMAS for their
 * spellings; and `buyer-request-forbidden-columns.test.ts`, which walks these
 * tables' actual COLUMNS (#354 — until then nothing did, while this sentence
 * said otherwise).
 * That walk is an ALLOW-LIST: every column of all eight tables is enumerated in
 * `buyer-request-column-allowlist.ts` with a reason, and a new one FAILS THE
 * BUILD until somebody decides it is allowed — because the field that leaks is
 * the one nobody was thinking about, and `recipient_name` matches none of the
 * constant's ten entries. The deny-list runs as a second layer over both sides,
 * so a forbidden name cannot be admitted by being written down.
 *
 * ## `guest_checkout_id` is NOT a column here, and #110 asks for one
 *
 * Cancellation field 2 says "order id and guest checkout id". `orders` already
 * carries `buyer_guest_checkout_id` (#105), so storing it again would be two
 * representations of one fact — the failure this repository refuses everywhere
 * else, and the place it would bite is a request whose contact was erased under
 * ADR 0003 D15 while a stale copy on the request still pointed at it. The join
 * answers the question; the duplicate could only ever disagree.
 *
 * ## Two actor triples, and both mirror `order_status_history`
 *
 * A requester and a decider, each stored as a KIND plus at most one identifier,
 * with a CHECK refusing every other combination — ADR 0003 D16's shape, so a
 * guest session id has no Oxy-shaped column to arrive in and "a guest acted"
 * can be recorded without saying which guest. The requester additionally names
 * the GRANT that authorized it (cancellation field 6, "access-session audit"),
 * which is an audit handle that authorizes nothing and is `ON DELETE SET NULL`
 * because #108's retention sweep purges grant rows at 90 days and a `RESTRICT`
 * would deadlock the sweep against every request ever filed.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type PgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  BUYER_REQUEST_ACTOR_KINDS,
  BUYER_REQUEST_COMPLETION_FAILURES,
  BUYER_REQUEST_EVENT_KINDS,
  BUYER_REQUEST_NOTE_MAX_LENGTH,
  CANCELLATION_COMPLETION_MODES,
  CANCELLATION_REQUEST_REASONS,
  CANCELLATION_REQUEST_STATES,
  OPEN_CANCELLATION_REQUEST_STATES,
  OPEN_RETURN_REQUEST_STATES,
  RETURN_EVIDENCE_KINDS,
  RETURN_REQUEST_REASONS,
  RETURN_REQUEST_STATES,
  RETURN_RESOLUTIONS,
  SUPPORT_MESSAGE_AUTHOR_KINDS,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_REDACTION_KINDS,
  SUPPORT_THREAD_STATES,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';
import { guestOrderAccessGrants } from './guestPortal';
import { orders, refunds } from './orders';

/** The SQL `in (…)` list a partial index's predicate compares against. */
function stateList(states: readonly string[]): string {
  return states.map((state) => `'${state}'`).join(', ');
}

/**
 * The actor CHECK both request tables and `support_messages` reuse.
 *
 * One expression rendered three times rather than three hand-written ones, for
 * the reason `order_status_history_actor_check` exists at all: an `oxy` actor
 * carries an Oxy id and no grant, a `guest` actor carries a grant and no Oxy
 * id, an `operator` carries an Oxy id, and `system` carries neither. Written
 * out per table, the fourth copy is where somebody permits both.
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
/*  Cancellation requests                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `cancellation_requests` — a buyer asking for one order to be undone.
 *
 * ## ONE order, never a group, and that is authorization rule 5
 *
 * There is no `checkout_group_id` column. A multi-seller checkout produces one
 * request per seller order, each decided by its own seller, because "one sibling
 * order cannot authorize a mutation on another sibling automatically" is only
 * structural if there is no shape that could describe two. A buyer cancelling
 * everything files N requests and N sellers answer them.
 *
 * ## The open-request unique is what makes a retry converge
 *
 * `cancellation_requests_open_order_key` is `UNIQUE(order_id)` partial on the
 * OPEN states, so a double tap, a retried POST and two concurrent submissions
 * all collide and the loser reads the winner back — acceptance 4, held by the
 * database rather than by a read-then-write that two racers both pass. The
 * predicate is rendered from `OPEN_CANCELLATION_REQUEST_STATES`, the same tuple
 * the service reasons about, so the two cannot drift.
 *
 * ## `idempotency_key` is a SECOND converger and both are needed
 *
 * The partial unique converges two attempts on one ORDER; the idempotency key
 * converges two attempts of one CLIENT CALL. They differ when the first request
 * has already been decided: a retry of the original submit must return the
 * original request rather than opening a second one against a now-closed first,
 * and only the key can tell that retry from a genuine new request.
 */
export const cancellationRequests = pgTable(
  'cancellation_requests',
  {
    id: generatedId(),
    /**
     * The ONE order. `RESTRICT` rather than `CASCADE`: an order is never
     * deleted in this system, and if one ever were, a buyer's cancellation
     * request is a commercial record that should stop the deletion rather than
     * vanish with it.
     */
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    state: text({ enum: asEnumValues(CANCELLATION_REQUEST_STATES) })
      .notNull()
      .default('submitted'),
    reason: text({ enum: asEnumValues(CANCELLATION_REQUEST_REASONS) }).notNull(),
    /** The buyer's own words, length-bounded. Never a contact detail. */
    note: text(),
    /**
     * How this would be undone, judged from the order's payment state WHEN IT
     * WAS ASKED. Re-derived at completion — see the shared-types docblock.
     */
    completionMode: text({ enum: asEnumValues(CANCELLATION_COMPLETION_MODES) }).notNull(),
    /**
     * Whether the buyer asked for the WHOLE order or named specific lines.
     *
     * A stored fact rather than "the lines table is empty", because the two are
     * not the same question and the difference decides whether a completion
     * refunds everything. An empty line set on a partial request is a client bug
     * and must not silently become a full refund.
     */
    wholeOrder: boolean().notNull().default(true),
    /** ADR 0003 D16's actor triple — see the file docblock. */
    requestedByActorKind: text({ enum: asEnumValues(BUYER_REQUEST_ACTOR_KINDS) }).notNull(),
    requestedByOxyUserId: text(),
    requestedByGrantId: text().references(() => guestOrderAccessGrants.id, {
      onDelete: 'set null',
    }),
    /** The deciding seller member or operator. NULL until a decision. */
    decidedByActorKind: text({ enum: asEnumValues(BUYER_REQUEST_ACTOR_KINDS) }),
    decidedByOxyUserId: text(),
    decidedAt: timestamptz(),
    /** Why a seller refused — #110 cancellation rule 8. Mandatory on rejection. */
    decisionNote: text(),
    /**
     * The refund this cancellation produced, when it needed one.
     *
     * The whole of #110 cancellation field 9 ("payment and inventory operation
     * references"), because `refunds` is where BOTH live: the row carries the
     * provider operation and `restocked_at`. A `release`-mode cancellation has
     * no refund and its inventory operation is the order's own status event,
     * which `order_status_history` already records — inventing a second id for
     * it would be a pointer to nothing.
     */
    refundId: text().references(() => refunds.id, { onDelete: 'restrict' }),
    completedAt: timestamptz(),
    /** Bounded, and present only while a decided request has not completed. */
    completionFailure: text({ enum: asEnumValues(BUYER_REQUEST_COMPLETION_FAILURES) }),
    /** Converges a retried client call. See the table docblock. */
    idempotencyKey: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('cancellation_requests_state_check', t.state, CANCELLATION_REQUEST_STATES),
    checkOneOf('cancellation_requests_reason_check', t.reason, CANCELLATION_REQUEST_REASONS),
    checkOneOf(
      'cancellation_requests_completion_mode_check',
      t.completionMode,
      CANCELLATION_COMPLETION_MODES,
    ),
    checkOneOf(
      'cancellation_requests_requested_actor_check',
      t.requestedByActorKind,
      BUYER_REQUEST_ACTOR_KINDS,
    ),
    checkOneOf(
      'cancellation_requests_decided_actor_check',
      t.decidedByActorKind,
      BUYER_REQUEST_ACTOR_KINDS,
    ),
    checkOneOf(
      'cancellation_requests_completion_failure_check',
      t.completionFailure,
      BUYER_REQUEST_COMPLETION_FAILURES,
    ),
    actorShapeCheck(
      'cancellation_requests_requester_shape_check',
      t.requestedByActorKind,
      t.requestedByOxyUserId,
      t.requestedByGrantId,
    ),
    // A DECIDER is never a guest and never a system: deciding is an authorized
    // act by a named person, and the two kinds that cannot name one are refused
    // outright rather than left to a service branch.
    check(
      'cancellation_requests_decider_shape_check',
      sql`${t.decidedByActorKind} is null
          or (${t.decidedByActorKind} in ('oxy', 'operator') and ${t.decidedByOxyUserId} is not null)`,
    ),
    // A decision is a kind, an actor and an instant together, or it did not
    // happen. Stated as a `num_nonnulls` triple rather than three implications,
    // the `guest_contact_suppressions_lift_check` shape.
    check(
      'cancellation_requests_decision_complete_check',
      sql`num_nonnulls(${t.decidedByActorKind}, ${t.decidedByOxyUserId}, ${t.decidedAt}) in (0, 3)`,
    ),
    // Every state that implies somebody decided must carry the decision, and no
    // state that does not may carry one. The biconditional is what stops a
    // `withdrawn` request claiming a seller rejected it.
    check(
      'cancellation_requests_decided_state_check',
      sql`(${t.state} in ('accepted', 'rejected', 'completed')) = (${t.decidedAt} is not null)`,
    ),
    // A rejection must say why (#110 cancellation rule 8), and only a rejection
    // may — a note on an acceptance would be a seller's remark on a request
    // nobody refused, shown to a buyer as if it were one.
    check(
      'cancellation_requests_rejection_note_check',
      sql`(${t.state} = 'rejected') = (${t.decisionNote} is not null)`,
    ),
    check(
      'cancellation_requests_completed_at_check',
      sql`(${t.state} = 'completed') = (${t.completedAt} is not null)`,
    ),
    // A failure is something still OWED. Recording one on a completed request
    // would say the money both did and did not move.
    check(
      'cancellation_requests_completion_failure_state_check',
      sql`${t.completionFailure} is null or ${t.state} = 'accepted'`,
    ),
    // A refund reference belongs to a cancellation that actually refunded.
    check(
      'cancellation_requests_refund_mode_check',
      sql`${t.refundId} is null or ${t.completionMode} = 'refund'`,
    ),
    check(
      'cancellation_requests_note_length_check',
      sql`${t.note} is null or length(${t.note}) <= ${sql.raw(String(BUYER_REQUEST_NOTE_MAX_LENGTH))}`,
    ),
    check(
      'cancellation_requests_decision_note_length_check',
      sql`${t.decisionNote} is null
          or (length(btrim(${t.decisionNote})) >= 3
              and length(${t.decisionNote}) <= ${sql.raw(String(BUYER_REQUEST_NOTE_MAX_LENGTH))})`,
    ),
    // ONE live request per order. See the table docblock.
    uniqueIndex('cancellation_requests_open_order_key')
      .on(t.orderId)
      .where(sql`${t.state} in (${sql.raw(stateList(OPEN_CANCELLATION_REQUEST_STATES))})`),
    // Partial, because most requests carry no key and Postgres treats NULLs as
    // distinct — a plain unique would work and would also index every NULL for
    // nothing.
    uniqueIndex('cancellation_requests_idempotency_key_key')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    // "What has been asked about this order" — the buyer's view and the
    // merchant's queue both open from here.
    index('cancellation_requests_order_idx').on(t.orderId, t.createdAt.desc()),
    // The merchant queue: everything still owed, oldest first, so the number a
    // dashboard shows is one indexed range rather than a scan.
    index('cancellation_requests_open_idx')
      .on(t.createdAt)
      .where(sql`${t.state} in (${sql.raw(stateList(OPEN_CANCELLATION_REQUEST_STATES))})`),
  ],
);

/**
 * `cancellation_request_lines` — the units a partial cancellation names.
 *
 * Absent entirely for a whole-order request, which is what `whole_order` says:
 * an empty line set and "every line" would otherwise be the same thing on the
 * wire, and the difference decides whether a completion refunds everything.
 *
 * `variant_id` is plain text with no foreign key, exactly as `order_items` and
 * `refund_line_items` already are — a historical reference to what was bought,
 * which must survive the variant being deleted from the catalogue.
 */
export const cancellationRequestLines = pgTable(
  'cancellation_request_lines',
  {
    id: generatedId(),
    requestId: text()
      .notNull()
      .references(() => cancellationRequests.id, { onDelete: 'cascade' }),
    /** Historical reference, no foreign key. See the table docblock. */
    variantId: text().notNull(),
    requestedQuantity: integer().notNull(),
    /**
     * What the seller agreed to. NULL until a decision.
     *
     * A SECOND number rather than an edit of the first, so "you asked for three
     * and we agreed two" survives in the record — and so the refund, which
     * reads only this column, can never be computed from what a buyer asked for.
     */
    approvedQuantity: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One line per variant, the invariant `refund.service` already relies on
    // when it indexes an order's items by variant.
    uniqueIndex('cancellation_request_lines_request_variant_key').on(t.requestId, t.variantId),
    check('cancellation_request_lines_requested_quantity_check', sql`${t.requestedQuantity} >= 1`),
    // Zero is meaningful here and 1 is not the floor: a seller agreeing to
    // cancel NONE of a line is a real decision, and it is different from not
    // having decided (NULL).
    check(
      'cancellation_request_lines_approved_quantity_check',
      sql`${t.approvedQuantity} is null
          or (${t.approvedQuantity} >= 0 and ${t.approvedQuantity} <= ${t.requestedQuantity})`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/*  Return requests                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `return_requests` — a buyer asking to send goods back.
 *
 * Everything the cancellation table's docblock says applies here: one order, an
 * open-request partial unique, an idempotency key, two actor triples, and no
 * column that could move an order.
 *
 * ## The deadlines are SNAPSHOTS, and there are two of them
 *
 * `return_window_ends_at` is #110 return field 9 — the policy deadline as it
 * stood when the request was opened, so a store shortening its window cannot
 * retroactively close a return somebody already filed. `ship_back_deadline_at`
 * is the seller's own answer to "by when", set when instructions are issued and
 * absent until then, because Mercaria has no carrier and therefore no way to
 * compute one.
 *
 * ## `return_instructions` is the seller's words, and Mercaria composes none
 *
 * #110 says return shipping instructions are "owned by the relevant fulfilment
 * system" and forbids building a carrier or shipping-zone system here. Moovo
 * owns that and has not landed, so the honest shape is a bounded text a seller
 * writes: Mercaria stores it, shows it to the buyer, and generates no label, no
 * address and no drop-off point of its own.
 */
export const returnRequests = pgTable(
  'return_requests',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    state: text({ enum: asEnumValues(RETURN_REQUEST_STATES) })
      .notNull()
      .default('requested'),
    reason: text({ enum: asEnumValues(RETURN_REQUEST_REASONS) }).notNull(),
    resolution: text({ enum: asEnumValues(RETURN_RESOLUTIONS) }).notNull(),
    note: text(),
    requestedByActorKind: text({ enum: asEnumValues(BUYER_REQUEST_ACTOR_KINDS) }).notNull(),
    requestedByOxyUserId: text(),
    requestedByGrantId: text().references(() => guestOrderAccessGrants.id, {
      onDelete: 'set null',
    }),
    decidedByActorKind: text({ enum: asEnumValues(BUYER_REQUEST_ACTOR_KINDS) }),
    decidedByOxyUserId: text(),
    decidedAt: timestamptz(),
    decisionNote: text(),
    /** The seller's own words about how to send it back. See the docblock. */
    returnInstructions: text(),
    /** Snapshotted from policy when the request was opened. */
    returnWindowEndsAt: timestamptz().notNull(),
    /** The seller's "by when", set with the instructions. */
    shipBackDeadlineAt: timestamptz(),
    /** When the seller confirmed the goods arrived. */
    receivedAt: timestamptz(),
    /** The refund this return produced — the payment AND inventory reference. */
    refundId: text().references(() => refunds.id, { onDelete: 'restrict' }),
    completedAt: timestamptz(),
    completionFailure: text({ enum: asEnumValues(BUYER_REQUEST_COMPLETION_FAILURES) }),
    idempotencyKey: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('return_requests_state_check', t.state, RETURN_REQUEST_STATES),
    checkOneOf('return_requests_reason_check', t.reason, RETURN_REQUEST_REASONS),
    checkOneOf('return_requests_resolution_check', t.resolution, RETURN_RESOLUTIONS),
    checkOneOf(
      'return_requests_requested_actor_check',
      t.requestedByActorKind,
      BUYER_REQUEST_ACTOR_KINDS,
    ),
    checkOneOf(
      'return_requests_decided_actor_check',
      t.decidedByActorKind,
      BUYER_REQUEST_ACTOR_KINDS,
    ),
    checkOneOf(
      'return_requests_completion_failure_check',
      t.completionFailure,
      BUYER_REQUEST_COMPLETION_FAILURES,
    ),
    actorShapeCheck(
      'return_requests_requester_shape_check',
      t.requestedByActorKind,
      t.requestedByOxyUserId,
      t.requestedByGrantId,
    ),
    check(
      'return_requests_decider_shape_check',
      sql`${t.decidedByActorKind} is null
          or (${t.decidedByActorKind} in ('oxy', 'operator') and ${t.decidedByOxyUserId} is not null)`,
    ),
    check(
      'return_requests_decision_complete_check',
      sql`num_nonnulls(${t.decidedByActorKind}, ${t.decidedByOxyUserId}, ${t.decidedAt}) in (0, 3)`,
    ),
    // Every state past the decision carries it. `withdrawn` is excluded because
    // a buyer can withdraw before anybody looked; `cancelled` is not, because a
    // seller terminating an APPROVED return necessarily decided it first.
    check(
      'return_requests_decided_state_check',
      sql`(${t.state} in ('approved', 'awaiting_item', 'received', 'refund_pending',
                          'completed', 'rejected', 'cancelled'))
          = (${t.decidedAt} is not null)`,
    ),
    check(
      'return_requests_rejection_note_check',
      sql`${t.decisionNote} is null or ${t.state} in ('rejected', 'cancelled')`,
    ),
    check(
      'return_requests_rejected_requires_note_check',
      sql`${t.state} <> 'rejected' or ${t.decisionNote} is not null`,
    ),
    // Instructions and their deadline arrive together and only from
    // `awaiting_item` onwards: a deadline with no instructions is a date nobody
    // was told about.
    check(
      'return_requests_instructions_state_check',
      sql`${t.returnInstructions} is null
          or ${t.state} in ('awaiting_item', 'received', 'refund_pending', 'completed', 'cancelled')`,
    ),
    check(
      'return_requests_ship_back_deadline_check',
      sql`${t.shipBackDeadlineAt} is null or ${t.returnInstructions} is not null`,
    ),
    // The goods arriving is what makes a refund defensible, so every state past
    // `received` must carry the instant, and none before it may.
    check(
      'return_requests_received_state_check',
      sql`(${t.state} in ('received', 'refund_pending', 'completed')) = (${t.receivedAt} is not null)`,
    ),
    // A refund reference means the commerce record committed, which is exactly
    // the two states past it. ADR 0001 D7: `refund_pending` is the rail still
    // moving, not the record still missing.
    check(
      'return_requests_refund_state_check',
      sql`${t.refundId} is null or ${t.state} in ('refund_pending', 'completed')`,
    ),
    check(
      'return_requests_completed_at_check',
      sql`(${t.state} = 'completed') = (${t.completedAt} is not null)`,
    ),
    // A failure is owed work, so it can only sit on the states from which work
    // is still owed — not on a terminal one.
    check(
      'return_requests_completion_failure_state_check',
      sql`${t.completionFailure} is null or ${t.state} in ('received', 'refund_pending')`,
    ),
    check(
      'return_requests_note_length_check',
      sql`${t.note} is null or length(${t.note}) <= ${sql.raw(String(BUYER_REQUEST_NOTE_MAX_LENGTH))}`,
    ),
    check(
      'return_requests_decision_note_length_check',
      sql`${t.decisionNote} is null
          or (length(btrim(${t.decisionNote})) >= 3
              and length(${t.decisionNote}) <= ${sql.raw(String(BUYER_REQUEST_NOTE_MAX_LENGTH))})`,
    ),
    check(
      'return_requests_instructions_length_check',
      sql`${t.returnInstructions} is null
          or (length(btrim(${t.returnInstructions})) >= 3
              and length(${t.returnInstructions}) <= ${sql.raw(String(BUYER_REQUEST_NOTE_MAX_LENGTH))})`,
    ),
    uniqueIndex('return_requests_open_order_key')
      .on(t.orderId)
      .where(sql`${t.state} in (${sql.raw(stateList(OPEN_RETURN_REQUEST_STATES))})`),
    uniqueIndex('return_requests_idempotency_key_key')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index('return_requests_order_idx').on(t.orderId, t.createdAt.desc()),
    index('return_requests_open_idx')
      .on(t.createdAt)
      .where(sql`${t.state} in (${sql.raw(stateList(OPEN_RETURN_REQUEST_STATES))})`),
    // The reconcile sweep's range: returns whose commerce refund committed and
    // whose rail has not finished. Narrow by construction, so the sweep is an
    // indexed read rather than a scan of every return ever filed.
    index('return_requests_refund_pending_idx')
      .on(t.updatedAt)
      .where(sql`${t.state} = 'refund_pending'`),
  ],
);

/** `return_request_lines` — the units being sent back. See the cancellation twin. */
export const returnRequestLines = pgTable(
  'return_request_lines',
  {
    id: generatedId(),
    requestId: text()
      .notNull()
      .references(() => returnRequests.id, { onDelete: 'cascade' }),
    variantId: text().notNull(),
    requestedQuantity: integer().notNull(),
    approvedQuantity: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('return_request_lines_request_variant_key').on(t.requestId, t.variantId),
    check('return_request_lines_requested_quantity_check', sql`${t.requestedQuantity} >= 1`),
    check(
      'return_request_lines_approved_quantity_check',
      sql`${t.approvedQuantity} is null
          or (${t.approvedQuantity} >= 0 and ${t.approvedQuantity} <= ${t.requestedQuantity})`,
    ),
  ],
);

/**
 * `return_request_evidence` — photographs a buyer declares, never files
 * Mercaria holds.
 *
 * A bare Oxy `file_id` and nothing else, exactly as `abuse_reports` evidence is
 * (#110 return field 4, "the approved media and privacy path"). Three
 * consequences, all deliberate:
 *
 *  - **Never a URL, and never a `mercaria.co` one.** The moderation domain
 *    already establishes why: a reviewer's browser fetching a Mercaria URL would
 *    tell this host when its content is being looked at. A seller's client
 *    fetches the file from Oxy with its own credential.
 *  - **No digest, and Mercaria says so.** Asserting a `sha256` it never computed
 *    would be worse than admitting it has none — and it has none, because
 *    Mercaria holds no Oxy service credential, so `getServiceAssetMetadataByIds`
 *    throws. That is the SAME gap `services/moderation/` documents, not a new
 *    one, and closing it closes both.
 *  - **No second upload channel.** The buyer's file already lives in their own
 *    Oxy storage. Two places establishing a photograph's provenance could
 *    disagree, which is exactly the reasoning #90 uses to refuse a second
 *    condition-photo channel.
 */
export const returnRequestEvidence = pgTable(
  'return_request_evidence',
  {
    id: generatedId(),
    requestId: text()
      .notNull()
      .references(() => returnRequests.id, { onDelete: 'cascade' }),
    /** The bare Oxy file id. Never a URL. See the table docblock. */
    fileId: text().notNull(),
    kind: text({ enum: asEnumValues(RETURN_EVIDENCE_KINDS) }).notNull(),
    position: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('return_request_evidence_request_file_key').on(t.requestId, t.fileId),
    index('return_request_evidence_request_position_idx').on(t.requestId, t.position),
    checkOneOf('return_request_evidence_kind_check', t.kind, RETURN_EVIDENCE_KINDS),
    check('return_request_evidence_position_check', sql`${t.position} >= 0`),
  ],
);

/* -------------------------------------------------------------------------- */
/*  Support threads                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `support_threads` — a bounded, transactional conversation about ONE order.
 *
 * #110 support rule 1 says a thread belongs to "one order or return request",
 * and both are modelled as one row: `order_id` is always present, and
 * `return_request_id` narrows it. A return-scoped thread is still about the
 * order the return is against, so making them alternatives would have meant a
 * polymorphic subject and a seller who cannot find the conversation from the
 * order they are fulfilling.
 *
 * ## What a thread deliberately is NOT
 *
 * Not an inbox: it has no recipient, no address and no delivery state — a
 * notification that a reply is waiting goes through `guest_portal_messages`,
 * which the recipient can suppress. Not a review: nothing here writes a
 * `reviews` row. Not a moderation case: nothing here writes an `abuse_reports`
 * row, and reporting abuse routes to `POST /reports`, which already exists.
 * `SUPPORT_FORBIDDEN_AUTOMATIC_OUTCOMES` names all three as values and
 * `buyer-request-isolation.test.ts` fails the build if a module here learns to
 * reach any of them (support rules 7 and 8).
 *
 * ## No attachments, and that is a decision rather than an omission
 *
 * #110 support rule 5 asks that attachments use "approved media validation,
 * malware scanning and retention". Mercaria has no malware scanning at all, and
 * no credential with which to read an uploaded file's metadata. Building an
 * unvalidated upload channel that a seller's browser then opens is the thing
 * rule 5 exists to prevent, so this domain has no attachment column and no
 * route that could accept one. A buyer with a photograph attaches it to the
 * RETURN REQUEST, where a seller's decision cites it — one provenance channel,
 * the #90 reasoning. `docs/buyer-requests.md` states the gap.
 */
export const supportThreads = pgTable(
  'support_threads',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    /** Narrows the thread to one return. NULL for an order-level conversation. */
    returnRequestId: text().references(() => returnRequests.id, { onDelete: 'restrict' }),
    state: text({ enum: asEnumValues(SUPPORT_THREAD_STATES) })
      .notNull()
      .default('open'),
    closedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('support_threads_state_check', t.state, SUPPORT_THREAD_STATES),
    check(
      'support_threads_closed_at_check',
      sql`(${t.state} = 'closed') = (${t.closedAt} is not null)`,
    ),
    // ONE order-level thread per order, and ONE per return request. Partial on
    // the NULL branch because Postgres treats NULLs as distinct, so a plain
    // two-column unique would let a buyer open unlimited order-level threads —
    // the `commerce_relationships` endpoint-key trap, one domain over.
    uniqueIndex('support_threads_order_key')
      .on(t.orderId)
      .where(sql`${t.returnRequestId} is null`),
    uniqueIndex('support_threads_return_request_key')
      .on(t.returnRequestId)
      .where(sql`${t.returnRequestId} is not null`),
    index('support_threads_order_idx').on(t.orderId, t.createdAt.desc()),
  ],
);

/**
 * `support_messages` — one message. APPEND-ONLY, against UPDATE and DELETE.
 *
 * The trigger refuses both, which is what makes a support thread usable as
 * evidence in a dispute: neither side can edit what they said, and neither can
 * remove it. #110 support rule 9 ("thread closure does not remove financial or
 * dispute records") is the weaker half of the same property — closing writes one
 * column on the THREAD and touches nothing here.
 *
 * The foreign key is `RESTRICT` rather than `CASCADE` for exactly that reason:
 * a cascade would be a way to delete messages by deleting a thread, and the
 * trigger would then either fire and break the delete or be bypassed by it.
 * Declaring `RESTRICT` makes the declaration and the trigger agree.
 *
 * ## The author is a KIND and a label, never a person
 *
 * `author_kind` is `buyer | seller | operator`, and the two buyer origins
 * collapse into one: a seller reading the thread must not learn whether they
 * are talking to a guest or an account holder, which is #106's `Guest` label
 * rule applied to a conversation and #110 merchant rule 7 ("do not label a guest
 * as lower trust merely because no Oxy account exists"). The Oxy id and the
 * grant id are recorded for the audit and are in `PROTECTED_COLUMNS`, so a
 * plain `select()` cannot serialize one into either side's view.
 */
export const supportMessages = pgTable(
  'support_messages',
  {
    id: generatedId(),
    threadId: text()
      .notNull()
      .references(() => supportThreads.id, { onDelete: 'restrict' }),
    authorKind: text({ enum: asEnumValues(SUPPORT_MESSAGE_AUTHOR_KINDS) }).notNull(),
    /** PROTECTED. The audit's account, never a value either side is shown. */
    authorOxyUserId: text(),
    /** PROTECTED. The portal grant that authorized a buyer's message. */
    authorGrantId: text().references(() => guestOrderAccessGrants.id, { onDelete: 'set null' }),
    /** The REDACTED body. The original is never stored — see `redaction.ts`. */
    body: text().notNull(),
    /** What a redaction pass removed, so a reader knows something was. */
    redactions: text().array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'support_messages_author_kind_check',
      t.authorKind,
      SUPPORT_MESSAGE_AUTHOR_KINDS,
    ),
    checkEveryElementOf('support_messages_redactions_check', t.redactions, SUPPORT_REDACTION_KINDS),
    // A seller or an operator is always a named account; a buyer is one or a
    // portal grant. The shape mirrors the request tables' requester CHECK.
    check(
      'support_messages_author_shape_check',
      sql`(${t.authorKind} in ('seller', 'operator')
           and ${t.authorOxyUserId} is not null and ${t.authorGrantId} is null)
          or ${t.authorKind} = 'buyer'`,
    ),
    check(
      'support_messages_body_length_check',
      sql`length(btrim(${t.body})) >= 1
          and length(${t.body}) <= ${sql.raw(String(SUPPORT_MESSAGE_MAX_LENGTH))}`,
    ),
    index('support_messages_thread_idx').on(t.threadId, t.createdAt),
  ],
);

/* -------------------------------------------------------------------------- */
/*  The shared audit trail                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `buyer_request_events` — one row per ATTEMPT, refusals included.
 *
 * APPEND-ONLY against UPDATE and DELETE, the `payment_repairs` posture, and the
 * refused attempts are the rows worth having: an audit that recorded only what
 * succeeded answers "did anybody try to cancel this" with silence.
 *
 * ## Two nullable request columns and a CHECK, never a polymorphic pair
 *
 * `cancellation_request_id` XOR `return_request_id`. The house rule
 * (`orders.store_id` XOR `seller_oxy_user_id`) rather than a `subject_type` plus
 * a `subject_id`, because a real foreign key on each half is what stops an event
 * naming a request that does not exist — which is precisely the row a
 * reconstructed timeline would be missing.
 */
export const buyerRequestEvents = pgTable(
  'buyer_request_events',
  {
    id: generatedId(),
    cancellationRequestId: text().references(() => cancellationRequests.id, {
      onDelete: 'restrict',
    }),
    returnRequestId: text().references(() => returnRequests.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(BUYER_REQUEST_EVENT_KINDS) }).notNull(),
    actorKind: text({ enum: asEnumValues(BUYER_REQUEST_ACTOR_KINDS) }).notNull(),
    actorOxyUserId: text(),
    /** PROTECTED. The portal grant that authorized a buyer's act. */
    actorGrantId: text().references(() => guestOrderAccessGrants.id, { onDelete: 'set null' }),
    /**
     * A BOUNDED code when something was refused or failed; NULL otherwise.
     *
     * Deliberately not free text and deliberately not the exception's message:
     * this trail is read by an operator during an incident, and a provider's
     * own words routinely carry an amount, an account or an address.
     */
    detail: text(),
    at: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('buyer_request_events_kind_check', t.kind, BUYER_REQUEST_EVENT_KINDS),
    checkOneOf('buyer_request_events_actor_kind_check', t.actorKind, BUYER_REQUEST_ACTOR_KINDS),
    actorShapeCheck(
      'buyer_request_events_actor_shape_check',
      t.actorKind,
      t.actorOxyUserId,
      t.actorGrantId,
    ),
    // Exactly one subject. `num_nonnulls(...) = 1` rather than two implications,
    // so an event belonging to neither is refused as loudly as one belonging to
    // both.
    check(
      'buyer_request_events_subject_check',
      sql`num_nonnulls(${t.cancellationRequestId}, ${t.returnRequestId}) = 1`,
    ),
    check(
      'buyer_request_events_detail_length_check',
      sql`${t.detail} is null or length(${t.detail}) <= 120`,
    ),
    index('buyer_request_events_cancellation_idx')
      .on(t.cancellationRequestId, t.at)
      .where(sql`${t.cancellationRequestId} is not null`),
    index('buyer_request_events_return_idx')
      .on(t.returnRequestId, t.at)
      .where(sql`${t.returnRequestId} is not null`),
  ],
);
