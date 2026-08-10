/**
 * Supplier-fulfilled Mercaria-retail fulfilment (#126, ADR 0004 D9.4/D9.6/D9.9,
 * D2.7, D10): `retail_order_role_snapshots`, `retail_fulfilment_intents`,
 * `retail_fulfilment_line_allocations`, `retail_delivery_promises`.
 *
 * Four tables, and the most useful thing to say about them is what they do NOT
 * contain. #126 acceptance 2 is *"Mercaria contains no carrier adapter,
 * tracking poller or carrier-state mapping for this flow"*, so there is no
 * carrier column, no package column, no label column, no scan column and no
 * poll cursor anywhere below — and `retail-logistics-isolation.test.ts` walks
 * these tables and fails the build if one appears. Moovo owns the physical
 * movement; this schema owns Mercaria's commercial intent about it.
 *
 * ## `retail_order_role_snapshots` — who sold this, under what terms
 *
 * #126 §"Immutable order-role snapshot" lists ten facts. Six of them ALREADY
 * have immutable homes and are deliberately not copied here: the product,
 * variant, quantity and accepted price are `order_items` (append-only, its
 * condition columns refusing UPDATE outright since #90); tax and the shipping
 * charge are `orders.totals`; the agreement, procurement offer and cost-quote
 * citations are `retail_procurement_intents` and its append-only lines (#123);
 * the purchase-order reference is `retail_procurement_intents.purchase_order_id`.
 *
 * Copying any of them would create a SECOND immutable record of one fact, which
 * is precisely the failure the snapshot exists to prevent — and the second copy
 * is the one nobody reconciles, so a divergence is discovered by a customer
 * reading a receipt. What this table carries is the remainder: the seller of
 * record, the disclosure that was shown, and the four consumer-rights windows
 * the buyer bought under. Nothing else had anywhere to live.
 *
 * ## `retail_fulfilment_intents` — how these lines get to the buyer
 *
 * #126 ownership items 6 and 10: *"whether the supplier or Moovo controls the
 * transport booking"* and *"exact mapping from customer order lines to
 * fulfilment intent"*. One row per (retail order, supplier procurement intent)
 * for the original obligation, plus a row per replacement.
 *
 * The two mode columns are the design decision to read twice.
 * `permitted_fulfilment_mode` is a CONTRACTUAL fact, knowable at checkout and
 * frozen there; `fulfilment_mode` is an OPERATIONAL one that cannot be known
 * until a supplier has accepted and confirmed package readiness (#126 Mode A
 * step 2). One column would have to either freeze a mode nobody could yet know
 * or leave the contractual grant rewritable after the sale. Two columns make
 * the containment a real intra-row CHECK, which is the only kind Postgres can
 * enforce, and a trigger makes the operational one write-once — the
 * `orders.claimed_by_oxy_user_id` NULL→value device (#106).
 *
 * `moovo_source_reference` is GENERATED from the row's own id. Deterministic
 * because #126 Mode A requirement 3 is *"booking is idempotent by Mercaria
 * fulfilment source reference"* and Mode B requirement 3 is *"duplicate
 * supplier callbacks converge on the same Moovo source reference"* — a value
 * minted per attempt would differ between two racers and defeat the property it
 * exists for. It is not a secret and authorizes nothing; what it does is make
 * an inbound Moovo event resolvable to exactly one intent and to nothing else,
 * which is #126 privacy 9 (*"supplier and Moovo events cannot enumerate
 * unrelated orders"*) held by the shape of the lookup rather than by a filter.
 *
 * Two nullable Moovo columns and no more: the transport request id and when it
 * was registered. Shipment counts, package contents, event ids, checkpoints,
 * estimates and projection freshness are #157's aggregate and #158's inbox, and
 * a column here that nothing could populate would be a second source of truth
 * for a fact Mercaria does not hold. The READ contract for them exists as a
 * TYPE (`MoovoTransportProjection`) so the derivations that consume it can be
 * written and tested today.
 *
 * ## `retail_fulfilment_line_allocations` — exact quantities, no duplicates
 *
 * #126 fulfilment mapping 1–8. The invariant that matters is 8,
 * *"reconciliation preventing duplicate or lost line allocation"*: the sum of
 * ORIGINAL allocations against one order item, over intents that are not
 * cancelled or superseded, may never exceed that item's quantity.
 *
 * That is cross-row, so no CHECK can hold it — the repository is the single
 * writer and refuses before issuing SQL, and a real-server test drives two
 * concurrent allocations at the same line. A `replacement` allocation is
 * deliberately outside the cap: it re-ships goods already allocated, so
 * counting it would make every replacement look like an over-allocation, and
 * the obvious remedy (raising the cap) makes a genuine double-ship invisible.
 *
 * ## `retail_delivery_promises` — append-only, and unknown is absence
 *
 * #126 §"Delivery promises and estimates", all ten rules. One append-only trail
 * rather than a mutable "current estimate" column, because rule 9 is *"never
 * silently rewrite past promises"* and a column that can be overwritten is
 * exactly the mechanism by which one is.
 *
 * A FAILED refresh is a row here too, and that is not bookkeeping: rule 6 asks
 * that estimates be *marked stale when supplier or Moovo updates fail*, and the
 * only way an append-only trail can say "we asked and could not find out" is to
 * record the asking. Rule 10 — *"unknown cost/estimate is not zero/on time"* —
 * is held by a CHECK: a row whose outcome is not `observed` carries no window
 * at all, so there is no column a zero could be written into.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  RETAIL_DELIVERY_OBSERVATION_OUTCOMES,
  RETAIL_DELIVERY_PROMISE_BASES,
  RETAIL_DELIVERY_PROMISE_KINDS,
  RETAIL_DELIVERY_PROMISE_SOURCES,
  RETAIL_FULFILMENT_INTENT_KINDS,
  RETAIL_FULFILMENT_INTENT_STATUSES,
  RETAIL_FULFILMENT_MODES,
  RETAIL_PERMITTED_FULFILMENT_MODES,
  RETAIL_SELLERS_OF_RECORD,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { orderItems, orders } from './orders';
import { retailProcurementIntents } from './retailCheckout';

/**
 * The prefix every `moovo_source_reference` carries.
 *
 * Namespaced with the application and the domain so a Moovo-side operator
 * reading a reference knows which Oxy service minted it and which of that
 * service's flows produced it — Moovo serves several, and an opaque id would
 * make a cross-application mix-up (#126 privacy 9) invisible at the point it
 * arrives.
 */
export const MOOVO_SOURCE_REFERENCE_PREFIX = 'mercaria:retail-fulfilment:';

/**
 * `retail_order_role_snapshots` — one per `mercaria_retail` order, written in
 * the order's own transaction and never rewritten.
 */
export const retailOrderRoleSnapshots = pgTable(
  'retail_order_role_snapshots',
  {
    id: generatedId(),
    /**
     * CASCADE, matching `retail_procurement_intents`: a role snapshot has no
     * meaning without the order whose roles it records, and orders are never
     * deleted in this codebase — so this states ownership rather than a
     * deletion Mercaria performs. The append-only trigger refuses UPDATE
     * always and DELETE only while the order still exists, which is #90's
     * condition-revision device: the cascade the foreign key declares still
     * works, and an operator cannot remove one snapshot to hide it.
     */
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /**
     * ONE member, forever. ADR 0004's responsibility matrix puts the contract
     * of sale, the receipt and every consumer right on Mercaria, and no supply
     * agreement can move them — so "the supplier is the seller" must not be a
     * storable claim, because the first place it would be read is a receipt.
     */
    sellerOfRecord: text({ enum: asEnumValues(RETAIL_SELLERS_OF_RECORD) })
      .notNull()
      .default('mercaria'),
    sellerLegalEntityName: text().notNull(),
    /** ISO-3166-1 alpha-2 of the selling entity (ADR 0004 D9.9: Spain at launch). */
    sellerLegalEntityCountry: text().notNull(),
    /** The #117 supplier-fulfilment disclosure that was shown, by key and version. */
    supplierFulfilmentDisclosureKey: text().notNull(),
    supplierFulfilmentDisclosureVersion: integer().notNull(),
    /** The customer terms version the four windows below were read from. */
    customerTermsVersion: text().notNull(),
    /** Hours a buyer may cancel within before dispatch (ADR 0004 D2.6). */
    cancellationWindowHours: integer().notNull(),
    /** Days of statutory withdrawal — 14 in the EU at launch. */
    withdrawalWindowDays: integer().notNull(),
    /** Days of Mercaria's own return policy. */
    returnWindowDays: integer().notNull(),
    /** Months of legal conformity guarantee — 36 in ES at launch. */
    warrantyMonths: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'retail_order_role_snapshots_seller_check',
      t.sellerOfRecord,
      RETAIL_SELLERS_OF_RECORD,
    ),
    check(
      'retail_order_role_snapshots_country_check',
      sql`${t.sellerLegalEntityCountry} ~ '^[A-Z]{2}$'`,
    ),
    check(
      'retail_order_role_snapshots_entity_check',
      sql`length(btrim(${t.sellerLegalEntityName})) > 0`,
    ),
    check(
      'retail_order_role_snapshots_disclosure_check',
      sql`length(btrim(${t.supplierFulfilmentDisclosureKey})) > 0
          and ${t.supplierFulfilmentDisclosureVersion} >= 1`,
    ),
    check(
      'retail_order_role_snapshots_terms_check',
      sql`length(btrim(${t.customerTermsVersion})) > 0`,
    ),
    /**
     * Every window is a real duration. A zero withdrawal window is not a
     * shorter policy, it is a statutory right recorded as absent — and a
     * snapshot is the one place that would never be questioned afterwards.
     */
    check(
      'retail_order_role_snapshots_windows_check',
      sql`${t.cancellationWindowHours} >= 1
          and ${t.withdrawalWindowDays} >= 1
          and ${t.returnWindowDays} >= 1
          and ${t.warrantyMonths} >= 1`,
    ),
    uniqueIndex('retail_order_role_snapshots_order_key').on(t.orderId),
  ],
);

/**
 * `retail_fulfilment_intents` — Mercaria's commercial intent to fulfil some of
 * one retail order's lines from one supplier, and who books the transport.
 */
export const retailFulfilmentIntents = pgTable(
  'retail_fulfilment_intents',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /**
     * The #123 frozen procurement intent this fulfils. RESTRICT, not cascade:
     * the procurement intent is the record of what Mercaria agreed to buy, and
     * a fulfilment intent must not be the thing that permits deleting it.
     */
    procurementIntentId: text()
      .notNull()
      .references(() => retailProcurementIntents.id, { onDelete: 'restrict' }),
    intentKind: text({ enum: asEnumValues(RETAIL_FULFILMENT_INTENT_KINDS) })
      .notNull()
      .default('original'),
    /** The intent this one replaces, on a `replacement` row. */
    supersedesIntentId: text().references((): AnyPgColumn => retailFulfilmentIntents.id, {
      onDelete: 'restrict',
    }),
    status: text({ enum: asEnumValues(RETAIL_FULFILMENT_INTENT_STATUSES) })
      .notNull()
      .default('planned'),
    /** Why the intent is where it is, on the states an operator reads. */
    statusReason: text(),
    /**
     * What the supply agreement permitted at purchase. Frozen by trigger with
     * the rest of the row's contractual half.
     */
    permittedFulfilmentMode: text({ enum: asEnumValues(RETAIL_PERMITTED_FULFILMENT_MODES) })
      .notNull(),
    /**
     * Which mode is actually used. NULL until transport is arranged, then
     * write-once by trigger — a mode that could be flipped afterwards would
     * reinterpret every event already projected under the first one.
     */
    fulfilmentMode: text({ enum: asEnumValues(RETAIL_FULFILMENT_MODES) }),
    /**
     * Mercaria's application-scoped handle for this intent, GENERATED from the
     * row's id so it is deterministic and cannot be re-minted. See the module
     * docblock for why that is what makes a booking idempotent and an inbound
     * event unable to reach an unrelated order.
     */
    moovoSourceReference: text()
      .generatedAlwaysAs(sql`'${sql.raw(MOOVO_SOURCE_REFERENCE_PREFIX)}' || "id"`)
      .notNull(),
    /** Moovo's own transport id, once #159 has created one. Write-once. */
    moovoTransportRequestId: text(),
    moovoTransportRegisteredAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('retail_fulfilment_intents_kind_check', t.intentKind, RETAIL_FULFILMENT_INTENT_KINDS),
    checkOneOf(
      'retail_fulfilment_intents_status_check',
      t.status,
      RETAIL_FULFILMENT_INTENT_STATUSES,
    ),
    checkOneOf(
      'retail_fulfilment_intents_permitted_mode_check',
      t.permittedFulfilmentMode,
      RETAIL_PERMITTED_FULFILMENT_MODES,
    ),
    checkOneOf('retail_fulfilment_intents_mode_check', t.fulfilmentMode, RETAIL_FULFILMENT_MODES),
    /**
     * The chosen mode is one the agreement permitted. An intra-row CHECK
     * because both facts are on this row — which is the whole reason
     * `permitted_fulfilment_mode` is denormalized here rather than joined from
     * the agreement: a cross-table rule is a service comparison somebody can
     * forget, and this one decides whether Mercaria hands a third party a
     * logistics document it never agreed to handle.
     */
    check(
      'retail_fulfilment_intents_mode_permitted_check',
      sql`${t.fulfilmentMode} is null
          or ${t.permittedFulfilmentMode} = 'either'
          or ${t.fulfilmentMode} = ${t.permittedFulfilmentMode}`,
    ),
    /**
     * A `replacement` names what it replaces and an `original` names nothing.
     * Both directions matter: a replacement with no antecedent is an extra
     * shipment nobody authorised, and an original naming one is a replacement
     * wearing the kind that consumes an order line's quantity.
     */
    check(
      'retail_fulfilment_intents_replacement_shape_check',
      sql`(${t.intentKind} = 'replacement') = (${t.supersedesIntentId} is not null)`,
    ),
    /** A row cannot replace itself. */
    check(
      'retail_fulfilment_intents_self_supersede_check',
      sql`${t.supersedesIntentId} is null or ${t.supersedesIntentId} <> ${t.id}`,
    ),
    /**
     * A Moovo transport id appears with the instant it was registered, and a
     * mode. Without the mode the reference says a transport exists and not what
     * kind, which is the difference between "Moovo booked this" and "Moovo is
     * tracking what the supplier booked" — and those have opposite operator
     * remedies when a parcel goes missing.
     */
    check(
      'retail_fulfilment_intents_moovo_shape_check',
      sql`(${t.moovoTransportRequestId} is not null) = (${t.moovoTransportRegisteredAt} is not null)
          and (${t.moovoTransportRequestId} is null or ${t.fulfilmentMode} is not null)`,
    ),
    /**
     * ONE original fulfilment intent per procurement intent. PARTIAL, so
     * replacements are unconstrained — there is no bound on how many times a
     * lost parcel may be re-sent, and inventing one here would refuse the third
     * attempt for a buyer who has already waited through two.
     */
    uniqueIndex('retail_fulfilment_intents_procurement_original_key')
      .on(t.procurementIntentId)
      .where(sql`${t.intentKind} = 'original'`),
    uniqueIndex('retail_fulfilment_intents_source_reference_key').on(t.moovoSourceReference),
    index('retail_fulfilment_intents_order_idx').on(t.orderId),
    /** The operator queue: intents that have no transport and are still live. */
    index('retail_fulfilment_intents_awaiting_transport_idx')
      .on(t.createdAt)
      .where(sql`${t.moovoTransportRequestId} is null and ${t.status} in ('planned', 'active')`),
  ],
);

/**
 * `retail_fulfilment_line_allocations` — exactly which units of which customer
 * order line one fulfilment intent covers.
 */
export const retailFulfilmentLineAllocations = pgTable(
  'retail_fulfilment_line_allocations',
  {
    id: generatedId(),
    fulfilmentIntentId: text()
      .notNull()
      .references(() => retailFulfilmentIntents.id, { onDelete: 'cascade' }),
    /**
     * RESTRICT: an order line is a commercial record and an allocation must not
     * be what permits removing one. In practice `order_items` cascades from its
     * order and orders are never deleted, so this is a statement about which
     * way ownership runs.
     */
    orderItemId: text()
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    quantity: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('retail_fulfilment_line_allocations_quantity_check', sql`${t.quantity} >= 1`),
    /**
     * One allocation per (intent, line). Two rows would let the same intent
     * claim the same units twice, and the cross-row cap the repository enforces
     * would still be satisfied by the sum — a duplicate that hides inside a
     * correct total is exactly what #126 mapping 8 asks to be prevented.
     */
    uniqueIndex('retail_fulfilment_line_allocations_intent_item_key').on(
      t.fulfilmentIntentId,
      t.orderItemId,
    ),
    /** The reconciliation read: every allocation against one customer line. */
    index('retail_fulfilment_line_allocations_item_idx').on(t.orderItemId),
  ],
);

/**
 * `retail_delivery_promises` — the append-only trail of what was promised and
 * what has since been observed.
 */
export const retailDeliveryPromises = pgTable(
  'retail_delivery_promises',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /**
     * NULL on the accepted-at-checkout promise, which is the ORDER's and exists
     * before any fulfilment intent does; set on every later observation, which
     * is about one supplier's share.
     */
    fulfilmentIntentId: text().references(() => retailFulfilmentIntents.id, {
      onDelete: 'cascade',
    }),
    promiseKind: text({ enum: asEnumValues(RETAIL_DELIVERY_PROMISE_KINDS) }).notNull(),
    source: text({ enum: asEnumValues(RETAIL_DELIVERY_PROMISE_SOURCES) }).notNull(),
    /**
     * The source's own handle for what it told us — a supplier quote reference,
     * a Moovo transport id. PROTECTED: a supplier quote handle is a procurement
     * reference and belongs in no buyer-facing DTO.
     */
    sourceRef: text(),
    outcome: text({ enum: asEnumValues(RETAIL_DELIVERY_OBSERVATION_OUTCOMES) }).notNull(),
    /** Present exactly on an `observed` row — see the CHECK below. */
    basis: text({ enum: asEnumValues(RETAIL_DELIVERY_PROMISE_BASES) }),
    earliestAt: timestamptz(),
    latestAt: timestamptz(),
    /** Present exactly on a `refresh_failed` row. A CODE, never provider text. */
    failureReason: text(),
    /** When the SOURCE observed it, not when Mercaria stored it (#126 rule 7). */
    observedAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('retail_delivery_promises_kind_check', t.promiseKind, RETAIL_DELIVERY_PROMISE_KINDS),
    checkOneOf('retail_delivery_promises_source_check', t.source, RETAIL_DELIVERY_PROMISE_SOURCES),
    checkOneOf(
      'retail_delivery_promises_outcome_check',
      t.outcome,
      RETAIL_DELIVERY_OBSERVATION_OUTCOMES,
    ),
    checkOneOf('retail_delivery_promises_basis_check', t.basis, RETAIL_DELIVERY_PROMISE_BASES),
    /**
     * #126 rule 10, as a shape: only an `observed` row may carry a window or a
     * basis, so there is no column an unknown estimate could be written into as
     * a zero, and no way to record "we could not find out" as "advisory, today".
     *
     * TWO biconditionals rather than one over their conjunction, and the
     * difference is not stylistic — it was a real bug the real-server suite
     * caught. `(outcome = 'observed') = (basis is not null AND a window is
     * present)` is satisfied by `outcome = 'unknown'` with a window and NO
     * basis: both sides evaluate false, so the CHECK passes and an unknown
     * estimate stores a delivery date. That is precisely the row rule 10
     * exists to make unrepresentable, admitted by the obvious spelling.
     */
    check(
      'retail_delivery_promises_observed_shape_check',
      sql`(${t.outcome} = 'observed') = (${t.basis} is not null)
          and (${t.outcome} = 'observed')
              = (${t.earliestAt} is not null or ${t.latestAt} is not null)`,
    ),
    check(
      'retail_delivery_promises_window_order_check',
      sql`${t.earliestAt} is null or ${t.latestAt} is null or ${t.latestAt} >= ${t.earliestAt}`,
    ),
    check(
      'retail_delivery_promises_failure_shape_check',
      sql`(${t.outcome} = 'refresh_failed') = (${t.failureReason} is not null)`,
    ),
    /**
     * The accepted promise is Mercaria's own, about the whole order, and it is
     * always a real window. A guaranteed promise sourced from a supplier
     * adapter would be #126 rule 5's prohibited upgrade written straight into
     * the table.
     */
    check(
      'retail_delivery_promises_accepted_shape_check',
      sql`${t.promiseKind} <> 'accepted_at_checkout'
          or (${t.source} = 'mercaria_checkout'
              and ${t.outcome} = 'observed'
              and ${t.fulfilmentIntentId} is null)`,
    ),
    /** A supplier or a carrier never authors the accepted promise; nor does a
     * later Moovo observation get to claim it. One per order, and immutable. */
    uniqueIndex('retail_delivery_promises_accepted_key')
      .on(t.orderId)
      .where(sql`${t.promiseKind} = 'accepted_at_checkout'`),
    /** The current-estimate read: newest observation of one kind, per intent. */
    index('retail_delivery_promises_intent_observed_idx').on(
      t.fulfilmentIntentId,
      t.promiseKind,
      t.observedAt,
    ),
    index('retail_delivery_promises_order_observed_idx').on(t.orderId, t.observedAt),
  ],
);
