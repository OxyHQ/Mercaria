/**
 * Mercaria-retail native checkout (#123, ADR 0004 D4/D5/D8):
 * `retail_offer_bindings`, `retail_procurement_intents`,
 * `retail_procurement_intent_lines`, `retail_cost_variance_records`.
 *
 * Four tables, each answering exactly one question no existing table can.
 *
 * ## `retail_offer_bindings` — WHICH catalogue variant Mercaria sells itself
 *
 * The cart holds a `product_variants` row and nothing else, and that is #57's
 * structural wall: "an external offer cannot enter the cart" is true precisely
 * because there is no id a cart line could hold for one. #123 does not widen
 * that wall — a retail line IS a variant line — so the retail-ness has to be a
 * fact ABOUT a variant, stored beside it, and this is that fact.
 *
 * A binding says: this exact catalogue variant is sold by MERCARIA, procured
 * from this exact `procurement_offers` row, under this supplier account and
 * agreement. It is created by an operator and never by a buyer or a feed —
 * which is #123 security 2 ("never trust client-selected supplier, cost
 * component or price") held by the fact that no public route writes here.
 *
 * `UNIQUE(product_variant_id) WHERE retired_at IS NULL` is the load-bearing
 * one: ONE authoritative procurement path per variant at a time. Two live
 * bindings would make "which supplier does this line come from" a question with
 * two answers, and the wrong answer is a purchase order placed with a supplier
 * whose cost was never the one the buyer was quoted. Retirement keeps the row —
 * a placed order's intent names its binding, and an operator asking why a
 * refund happened needs to see the binding that produced it.
 *
 * ## `retail_procurement_intents` — WHAT was promised, frozen at checkout
 *
 * #123's "create durable procurement intent before supplier submission", and
 * ADR 0004 D9.7's snapshot rule applied to the supply side. One row per
 * (retail order, supplier), written IN the order's transaction, carrying the
 * supplier account and the agreement, with one child line per catalogue line
 * citing the exact #120 lock and #122 quote it was priced under.
 *
 * It exists because the trigger and the checkout are separated by a webhook.
 * Composing the purchase order at trigger time from live catalogue state would
 * re-read a supplier offer, a policy version and an agreement that may all have
 * moved since the buyer paid — and the buyer's amount is frozen, so procuring
 * against anything but the frozen inputs is how a locked amount and an actual
 * cost silently stop describing the same purchase.
 *
 * `UNIQUE(order_id, supplier_id)` is ADR 0004 D5's "one PurchaseOrder per
 * supplier" one table earlier, and it is what makes the whole trigger path
 * idempotent: the outbox row id, the purchase order's own idempotency key
 * (`po:<orderId>:<supplierId>`) and this constraint all derive from the same
 * pair, so a redelivered success, a reclaimed lease and an operator retry
 * converge on one purchase order rather than three.
 *
 * ## `retail_cost_variance_records` — WHAT it actually cost, for #128
 *
 * Append-only by trigger, and it books NOTHING. See the DTO's docblock in
 * `@mercaria/shared-types` for why the observation and the recognition are
 * split; the schema half of that split is the absence of an account column, a
 * ledger-transaction pointer and any threshold verdict. There is deliberately
 * no `retail_margin` column and no signed "profit" figure — `direction` is a
 * closed three-member set precisely so a positive delta cannot be stored as
 * anything but money owed to the buyer.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  RETAIL_COST_VARIANCE_DIRECTIONS,
  RETAIL_COST_VARIANCE_SOURCES,
  RETAIL_PROCUREMENT_FAILURE_KINDS,
  RETAIL_PROCUREMENT_INTENT_STATUSES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, money } from './columns';
import { productVariants } from './catalog';
import { orders } from './orders';
import {
  procurementOffers,
  purchaseOrders,
  supplierAccounts,
  supplierAgreements,
  suppliers,
} from './procurement';
import { retailCostQuoteAcceptances, retailCostQuotes } from './retailPricing';

/**
 * `retail_offer_bindings` — one catalogue variant Mercaria sells itself, and
 * the procurement offer it is sourced from.
 */
export const retailOfferBindings = pgTable(
  'retail_offer_bindings',
  {
    id: generatedId(),
    /**
     * The catalogue variant a buyer adds to their cart. CASCADE, matching
     * `cart_items`: when the variant goes the binding is meaningless, and a
     * binding pointing at nothing would make an eligibility read fail at the
     * till rather than at the catalogue.
     */
    productVariantId: text()
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    /**
     * The supply side, RESTRICT throughout: a placed order's intent names this
     * binding, and an operator asking why a refund happened has to be able to
     * reach the offer that produced it.
     */
    procurementOfferId: text()
      .notNull()
      .references(() => procurementOffers.id, { onDelete: 'restrict' }),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    /**
     * The agreement that grants resale and blind dropship for this route (ADR
     * 0004 D2.10). NOT NULL: `createPurchaseOrderForOrder` refuses without one,
     * so a binding that could never produce a purchase order is a binding that
     * should never have been written.
     */
    agreementId: text()
      .notNull()
      .references(() => supplierAgreements.id, { onDelete: 'restrict' }),
    /** Who bound it — an Oxy operator account id, no foreign key (Oxy owns identity). */
    boundByOxyUserId: text().notNull(),
    /** Why, in the operator's own words. Read on every trace; never shown to a buyer. */
    boundReason: text().notNull(),
    /** NULL while live. Set once, and the row is never deleted. */
    retiredAt: timestamptz(),
    retiredByOxyUserId: text(),
    retiredReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('retail_offer_bindings_bound_reason_check', sql`length(btrim(${t.boundReason})) > 0`),
    /**
     * Retirement travels as a triple. A `retired_at` with no actor is an
     * unauditable withdrawal of a commercial route, and an actor with no
     * timestamp is a withdrawal at no time — the `claimed_by`/`claimed_at`
     * pairing on `orders`, with the reason inside the count because "why did
     * this stop being for sale" is the question a retirement exists to answer.
     */
    check(
      'retail_offer_bindings_retirement_check',
      sql`num_nonnulls(${t.retiredAt}, ${t.retiredByOxyUserId}, ${t.retiredReason}) in (0, 3)`,
    ),
    /**
     * ONE live binding per variant. PARTIAL, so a retired binding never blocks
     * a replacement — a supplier change is a retirement plus a new binding, and
     * the old row stays readable for every order it produced.
     */
    uniqueIndex('retail_offer_bindings_variant_live_key')
      .on(t.productVariantId)
      .where(sql`${t.retiredAt} is null`),
    index('retail_offer_bindings_offer_idx').on(t.procurementOfferId),
    index('retail_offer_bindings_supplier_idx').on(t.supplierId),
  ],
);

/**
 * `retail_procurement_intents` — one supplier's share of one retail order,
 * frozen at checkout.
 *
 * Frozen by COLUMN, since the row moves: `retail_procurement_intents_snapshot_immutable`
 * (#367 line 75) refuses a rewrite of everything the purchase order is COMPOSED from —
 * the order, the group, the supplier trio, the agreement, the supplier cost and
 * `buyer_locked_total`. `status`, `requested_at`, `failure_kind` and
 * `failure_detail` stay open because an intent is recorded, requested, then
 * resolved. `purchase_order_id` is frozen WRITE-ONCE, which admits
 * `attachRetailIntentPurchaseOrder`'s one CAS stamp and refuses a re-point.
 *
 * Until #367 line 75 the database enforced NONE of the "frozen at checkout" this
 * docblock and the module header both assert: measured,
 * `buyer_locked_total_amount` was freely rewritable, and it is the figure every
 * variance comparison and every compensating refund is sized from.
 */
export const retailProcurementIntents = pgTable(
  'retail_procurement_intents',
  {
    id: generatedId(),
    /**
     * The retail order. CASCADE: an intent is meaningless without the order it
     * procures for, and orders are never deleted in this codebase — so this is
     * a statement about ownership rather than a deletion Mercaria performs.
     */
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** The group, restated so a trace can open from it without joining orders. */
    checkoutGroupId: text().notNull(),
    supplierId: text()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    supplierAccountId: text()
      .notNull()
      .references(() => supplierAccounts.id, { onDelete: 'restrict' }),
    agreementId: text()
      .notNull()
      .references(() => supplierAgreements.id, { onDelete: 'restrict' }),
    /**
     * The purchase order #124 created from this intent, once it exists. The
     * pointer, never a copy of its state: `purchase_orders.status` is the one
     * answer to "where does procurement stand".
     */
    purchaseOrderId: text().references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    status: text({ enum: asEnumValues(RETAIL_PROCUREMENT_INTENT_STATUSES) })
      .notNull()
      .default('recorded'),
    /** Why procurement could not be started, on a `failed` intent only. */
    failureKind: text({ enum: asEnumValues(RETAIL_PROCUREMENT_FAILURE_KINDS) }),
    failureDetail: text(),
    /**
     * The SUPPLIER-side cost this order was quoted at, in the SUPPLIER's own
     * billing currency — what the purchase order is created with, and the
     * baseline every variance record compares an actual against.
     *
     * Not the buyer's amount. The buyer's amount lives on the acceptance, in
     * the presentment currency, and conflating the two is how a supplier's
     * wholesale cost ends up on a customer-facing surface.
     */
    ...money('supplierCost'),
    /**
     * What the BUYER was locked at for this supplier's lines, presentment side
     * — the sum of this intent's lines' accepted totals.
     *
     * Denormalized from the child rows deliberately, and it is the figure every
     * variance comparison and every compensating refund is sized from. Summing
     * the children at each of those call sites would be three places one
     * arithmetic could go wrong, and the failure mode of a wrong one is a refund
     * for the wrong amount.
     */
    ...money('buyerLockedTotal'),
    requestedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'retail_procurement_intents_status_check',
      t.status,
      RETAIL_PROCUREMENT_INTENT_STATUSES,
    ),
    checkOneOf(
      'retail_procurement_intents_failure_kind_check',
      t.failureKind,
      RETAIL_PROCUREMENT_FAILURE_KINDS,
    ),
    ...currencyChecks('retail_procurement_intents', [
      t.supplierCostCurrency,
      t.buyerLockedTotalCurrency,
    ]),
    check(
      'retail_procurement_intents_cost_check',
      sql`${t.supplierCostAmount} >= 0 and ${t.buyerLockedTotalAmount} >= 0`,
    ),
    check(
      'retail_procurement_intents_group_check',
      sql`length(btrim(${t.checkoutGroupId})) > 0`,
    ),
    /**
     * A failure kind appears EXACTLY on a `failed` intent.
     *
     * Both directions are wrong in their own way: a `failed` intent with no
     * kind is a refusal nobody can act on, and a kind on a `purchase_order_created`
     * intent would tell the compensating-refund path that a successfully
     * procured order failed.
     */
    check(
      'retail_procurement_intents_failure_shape_check',
      sql`(${t.status} = 'failed') = (${t.failureKind} is not null)`,
    ),
    /**
     * A purchase-order pointer appears EXACTLY on a `purchase_order_created`
     * intent — the status and the pointer are two spellings of one fact, and
     * this is what stops them disagreeing.
     */
    check(
      'retail_procurement_intents_purchase_order_shape_check',
      sql`(${t.status} = 'purchase_order_created') = (${t.purchaseOrderId} is not null)`,
    ),
    /** ADR 0004 D5's "one PurchaseOrder per supplier", one table earlier. */
    uniqueIndex('retail_procurement_intents_order_supplier_key').on(t.orderId, t.supplierId),
    index('retail_procurement_intents_group_idx').on(t.checkoutGroupId),
    index('retail_procurement_intents_status_idx').on(t.status),
    index('retail_procurement_intents_purchase_order_idx')
      .on(t.purchaseOrderId)
      .where(sql`${t.purchaseOrderId} is not null`),
  ],
);

/**
 * `retail_procurement_intent_lines` — one catalogue line of one supplier's
 * share, and the exact #120 lock it was priced under.
 *
 * A child TABLE rather than a JSON column on the intent, and the deciding
 * property is that these rows are read by a join and not replayed as an opaque
 * blob: a variance comparison sums their accepted totals, an operator trace
 * lists them beside the purchase-order lines they became, and #128 will
 * reconcile a supplier invoice line against one. `db/schema/CONVENTIONS.md`'s
 * `jsonb` register admits a column only when nothing queries into it, and
 * everything queries into these.
 *
 * Each line cites BOTH its `retail_cost_quotes` row and the
 * `retail_cost_quote_acceptances` row that locked it, because they answer
 * different questions: the quote is what the cost was composed from and the
 * acceptance is what the buyer agreed to pay. Citing only the acceptance would
 * leave a reconciliation unable to reach the components; citing only the quote
 * would leave it unable to prove the buyer accepted this total rather than a
 * revision of it.
 */
export const retailProcurementIntentLines = pgTable(
  'retail_procurement_intent_lines',
  {
    id: generatedId(),
    intentId: text()
      .notNull()
      .references(() => retailProcurementIntents.id, { onDelete: 'cascade' }),
    /** The procurement offer this line is sourced from — the supply-side identity. */
    procurementOfferId: text()
      .notNull()
      .references(() => procurementOffers.id, { onDelete: 'restrict' }),
    /** The binding that made this catalogue line a retail one, for the trace. */
    bindingId: text()
      .notNull()
      .references(() => retailOfferBindings.id, { onDelete: 'restrict' }),
    /** The #120 lock, and the quote behind it. */
    acceptanceId: text()
      .notNull()
      .references(() => retailCostQuoteAcceptances.id, { onDelete: 'restrict' }),
    quoteId: text()
      .notNull()
      .references(() => retailCostQuotes.id, { onDelete: 'restrict' }),
    /**
     * The #122 supplier quote this line was preflighted against — an OPAQUE
     * ref with no foreign key, because the preflight domain purges its own
     * quotes on its own retention schedule and a placed order must not pin
     * them. It is in `PROTECTED_COLUMNS`: a supplier quote id is a
     * procurement handle and belongs in no buyer-facing DTO.
     */
    supplierQuoteRef: text(),
    /** The supplier's own SKU, snapshotted — the purchase order is created with it. */
    supplierSku: text().notNull(),
    canonicalProductId: text(),
    canonicalVariantId: text(),
    quantity: integer().notNull(),
    /** The SUPPLIER's unit cost and line total, in the supplier's billing currency. */
    ...money('supplierUnitCost'),
    ...money('supplierLineTotal'),
    /** What the BUYER accepted for this line, presentment side. */
    ...money('buyerAcceptedTotal'),
    createdAt: createdAt(),
  },
  (t) => [
    ...currencyChecks('retail_procurement_intent_lines', [
      t.supplierUnitCostCurrency,
      t.supplierLineTotalCurrency,
      t.buyerAcceptedTotalCurrency,
    ]),
    check('retail_procurement_intent_lines_quantity_check', sql`${t.quantity} >= 1`),
    check(
      'retail_procurement_intent_lines_amounts_check',
      sql`${t.supplierUnitCostAmount} >= 0 and ${t.supplierLineTotalAmount} >= 0
          and ${t.buyerAcceptedTotalAmount} >= 0`,
    ),
    check('retail_procurement_intent_lines_sku_check', sql`length(btrim(${t.supplierSku})) > 0`),
    /**
     * ONE line per acceptance. A #120 acceptance is a lock on ONE quote for ONE
     * checkout group, so two lines citing it would be two purchases sold under
     * one agreed price — and a variance comparison would then count the same
     * locked amount twice, which is a surplus recognized twice.
     */
    uniqueIndex('retail_procurement_intent_lines_acceptance_key').on(t.acceptanceId),
    index('retail_procurement_intent_lines_intent_idx').on(t.intentId),
    index('retail_procurement_intent_lines_offer_idx').on(t.procurementOfferId),
  ],
);

/**
 * `retail_cost_variance_records` — one observed actual against one locked
 * customer amount. Append-only; #128 books, #123 only observes.
 */
export const retailCostVarianceRecords = pgTable(
  'retail_cost_variance_records',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    purchaseOrderId: text().references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    /**
     * The intent whose lines' locks this compares against — the pointer that
     * makes the comparison reproducible.
     *
     * The INTENT rather than an acceptance, because a supplier's share may hold
     * several lines and therefore several acceptances, and a record naming one
     * of them would silently compare a supplier's whole actual cost against one
     * line's locked amount. Reaching the individual acceptances is one join
     * through `retail_procurement_intent_lines`.
     */
    intentId: text()
      .notNull()
      .references(() => retailProcurementIntents.id, { onDelete: 'restrict' }),
    source: text({ enum: asEnumValues(RETAIL_COST_VARIANCE_SOURCES) }).notNull(),
    direction: text({ enum: asEnumValues(RETAIL_COST_VARIANCE_DIRECTIONS) }).notNull(),
    /** The locked customer amount and the observed actual, in ONE currency. */
    ...money('locked'),
    actualAmount: integer().notNull(),
    /** `locked − actual`. Signed, and its sign must agree with `direction`. */
    deltaAmount: integer().notNull(),
    observedAt: timestamptz().notNull(),
    /** No `updated_at` — the row is append-only. */
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('retail_cost_variance_records_source_check', t.source, RETAIL_COST_VARIANCE_SOURCES),
    checkOneOf(
      'retail_cost_variance_records_direction_check',
      t.direction,
      RETAIL_COST_VARIANCE_DIRECTIONS,
    ),
    ...currencyChecks('retail_cost_variance_records', [t.lockedCurrency]),
    check(
      'retail_cost_variance_records_amounts_check',
      sql`${t.lockedAmount} >= 0 and ${t.actualAmount} >= 0`,
    ),
    /**
     * The delta is the subtraction, and its SIGN is the direction — one CHECK
     * rather than three, because the three facts are one fact.
     *
     * Written as a biconditional per direction so neither half can drift: a
     * `customer_owed` row whose actual EXCEEDED the lock would be a negative
     * amount owed to a buyer (a surcharge wearing a refund's name, which D8.4
     * forbids outright), and an `absorbed` row whose actual came in UNDER the
     * lock would be Mercaria keeping a surplus and calling it a loss.
     */
    check(
      'retail_cost_variance_records_delta_check',
      sql`${t.deltaAmount} = ${t.lockedAmount} - ${t.actualAmount}
          and (${t.direction} = 'customer_owed') = (${t.deltaAmount} > 0)
          and (${t.direction} = 'absorbed') = (${t.deltaAmount} < 0)
          and (${t.direction} = 'none') = (${t.deltaAmount} = 0)`,
    ),
    index('retail_cost_variance_records_order_idx').on(t.orderId),
    index('retail_cost_variance_records_direction_idx').on(t.direction, t.observedAt.desc()),
    /**
     * ONE record per (intent, source). A re-delivered supplier acceptance
     * describes the same actual, and a second row would make #128 recognize the
     * same surplus twice — which is a second refund of one overpayment.
     *
     * Keyed on the INTENT and not on the order plus a nullable purchase order:
     * a NULLABLE column in a unique key is exactly the trap `commerce_relationships`
     * documents, because Postgres treats NULLs as distinct and the index would
     * silently admit two records for a supplier whose purchase order had not
     * been created yet. Every intent has an id from the moment it is written.
     */
    uniqueIndex('retail_cost_variance_records_intent_source_key').on(t.intentId, t.source),
  ],
);
