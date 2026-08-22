/**
 * What each table holding a fact about a PLACED ORDER, a PAYMENT or a REFUND
 * may still have rewritten — the declared half of epic #367's "Keep historical
 * order/payment/refund snapshots immutable".
 *
 * ## Why the payment domain needed a SECOND root
 *
 * The population used to be the foreign-key closure of `orders` alone, and the
 * payment domain is not in it — deliberately. `services/payments/order-linkage.ts`
 * is the ONE seam onto orders precisely so the payment tables do not reach into
 * them, so `payments` carries no foreign key to `orders` and a walk from `orders`
 * can never arrive. Measured: closure(`orders`) is 57 tables and contains none of
 * `payments`, `transfers`, `payouts`, `disputes`, `payment_attempts`,
 * `payment_provider_events`, `payment_outboxes` or `provider_accounts`.
 *
 * The roots are therefore `orders` PLUS every table the payment schema module
 * exports — module membership, not a name list, so a table added to
 * `schema/payments.ts` enters the population on the commit that adds it. That is
 * the same "derive the population, declare the disposition" arrangement the
 * `orders` half already used, with the boundary drawn where the domain's own
 * module boundary already is.
 *
 * `refunds` and `refund_line_items` were always inside the `orders` closure
 * (closure(`refunds`) is 23 tables, every one of them already reachable from
 * `orders`); what changed for them is the DISPOSITION, not the membership.
 *
 * ## Why a declaration rather than an assertion beside each table
 *
 * "Nothing rewrites history" is a claim about COMPLETENESS, and completeness is
 * the one thing nobody verifies by reading a schema: finding fewer
 * order-referencing tables looks exactly like there BEING fewer, and the miss is
 * silent — a migration edits a snapshot, every page still renders, and a buyer
 * finds it on a receipt two years later.
 *
 * So the POPULATION is derived and the DISPOSITION is declared, which is
 * `merge-plan.ts`'s arrangement one domain over. `commerce-history-census.test.ts`
 * walks the drizzle schema for the transitive foreign-key closure of the roots
 * below and asserts this list covers EXACTLY that set, so a new table naming an
 * order or a payment fails the build until somebody decides what may be
 * rewritten in it — at the moment the reference is added, by the person adding
 * it.
 * `commerce-history-immutability.realdb.test.ts` then EXECUTES each declaration
 * against a real server, so a declaration is never taken on trust.
 *
 * ## `allowed` with a reason is a decision; silence is not
 *
 * Most of this list is `allowed`, and that is the honest state of the schema
 * rather than a gap in the gate: a cancellation request is decided after it is
 * filed, a review aggregate is a projection that exists to be re-derived, and a
 * POS draft is not history at all until it converts. What the reason column
 * buys is that each of those is a recorded judgement, and that the handful which
 * are documented as immutable somewhere and enforced NOWHERE say so in the one
 * place a reader is already looking.
 *
 * ## The eight-table claim, and how it was closed
 *
 * `schema/orders.ts`'s own opening line calls eight tables "the immutable
 * commerce record" — `orders`, `order_items`, `order_item_option_values`,
 * `order_status_history`, `order_applied_discounts`, `order_tax_lines`,
 * `refunds`, `refund_line_items`. #868 enforced the payment and refund half and
 * recorded the rest as GAPs; #367 line 75 closed them, together with
 * `retail_procurement_intents`, which `schema/retailCheckout.ts` calls frozen at
 * checkout in two places and `schema/retailFulfilment.ts` cites as one of the
 * "immutable homes" that justify NOT copying six facts into
 * `retail_order_role_snapshots`.
 *
 * That last one is worth stating plainly, because it is the shape of the whole
 * hazard: a load-bearing architectural decision — do not duplicate this fact,
 * its other home is immutable — rested on an immutability the database did not
 * have. Measured before the fix, every column of `retail_procurement_intents`
 * was rewritable, `buyer_locked_total_amount` included, which is the figure
 * every variance comparison and every compensating refund is sized from.
 *
 * A claim is only withdrawn here when the column legitimately MOVES, and then
 * the schema's own comment is corrected in the same change rather than left
 * standing. A comment asserting an immutability the database does not have is
 * worse than no comment: it is read as a guarantee, and #367 line 75 found four of them.
 *
 * ## A column that MOVES is a decision, and the census accepts it
 *
 * The classification is by MEANING — is this a fact about a transaction as it
 * stood, or working state that legitimately moves — and NOT by which columns the
 * code happens to write today. Those are different questions, and deriving the
 * second from the first builds a gate that ratifies whatever the code currently
 * does: a column mutated by a defect would be classified `allowed` and the gate
 * would then assert it stays that way, which is the one thing it exists to
 * catch. Each classification was diffed against a census of every `.set()` and
 * `onConflictDoUpdate` in the domain, and the DISAGREEMENTS are recorded in the
 * reasons rather than resolved silently.
 *
 * ## Why NOTHING either issue touched refuses a DELETE
 *
 * Every entry #868 and #367 line 75 touched keeps `rowDelete: 'allowed'`, and that is
 * measured rather than conceded. `payment_provider_events` and
 * `payment_outboxes` are DELETE targets of the shared retention sweep
 * (`db/expiryTargets.ts`), so a DELETE trigger there would make retention fail
 * SILENTLY; `refund_line_items` is reached by the FK cascade from `refunds`;
 * and five realdb files plus `scripts/seed.ts` delete payments, refunds,
 * disputes and attempts in teardown. The ledger tables can refuse DELETE
 * because nothing deletes them — these cannot. (#90's condition photos set the
 * precedent: permit the DELETE so the cascade the foreign key already declares
 * still works.)
 *
 * The order side is the same answer with a wider blast radius. All six tables
 * #367 line 75 froze cascade from `orders` (or, for `order_item_option_values`, from
 * `order_items`); a cascaded DELETE issues a real row DELETE on the child and
 * FIRES its triggers. Eighteen realdb teardowns delete orders and
 * `scripts/seed.ts` clears the whole table, so a DELETE refusal on any ONE of
 * them breaks every one of those runs — including on the four tables nothing
 * deletes directly, which is exactly where the mistake would look safe.
 *
 * ## Why the freezes are WRITE-ONCE
 *
 * Every column-level freeze is `OLD IS NOT NULL AND NEW IS DISTINCT FROM OLD`,
 * so a NULL → value stamp is permitted and rewriting a recorded fact is not.
 * That is what makes a captured amount freezable at all: `platform_amount` is
 * NULL until the charge settles and is stamped once, and an at-least-once
 * redelivery that re-applies the SAME value is not a rewrite. On a NOT NULL
 * column it degenerates to a plain freeze, which is the intended reading there.
 */

import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

import * as paymentsSchema from './schema/payments.js';

/** What the database does to an UPDATE or a DELETE of a whole row. */
export type CommerceHistoryVerdict = 'refused' | 'allowed';

/** One table's declared disposition. */
export interface CommerceHistoryDisposition {
  /** The Postgres table name, as the migrations create it. */
  readonly table: string;
  /**
   * What an UPDATE that changes NO column does.
   *
   * A no-op deliberately: it separates a table whose every row is frozen from
   * one that merely freezes named columns, which a value-changing probe cannot
   * tell apart.
   */
  readonly rowUpdate: CommerceHistoryVerdict;
  /** What `DELETE` of the row does. */
  readonly rowDelete: CommerceHistoryVerdict;
  /**
   * Columns that may not be changed once written, on a table whose row is
   * otherwise mutable.
   *
   * Each is probed by changing it from one value to another distinct value, so
   * both spellings the schema uses are covered: the plain `NEW IS DISTINCT FROM
   * OLD` freeze and the write-once `OLD IS NOT NULL AND NEW IS DISTINCT FROM
   * OLD`.
   */
  readonly frozenColumns: readonly string[];
  /** Why this is the right disposition, in one sentence. */
  readonly reason: string;
}

/**
 * The roots the population is derived from.
 *
 * `orders` is the commerce root: "a record about a placed order" is exactly
 * "reachable from `orders` by a foreign key". The payment domain needs its own
 * roots because it deliberately holds no foreign key to `orders` (see the
 * header), and they are taken from the payment schema module's OWN exports
 * rather than written out here — so the boundary stays a property of the schema
 * rather than of anybody's memory, and a table added to `schema/payments.ts`
 * joins the population on the commit that adds it.
 *
 * Sorted so the derivation is stable and a diff adding a root is one line.
 */
export const COMMERCE_HISTORY_ROOT_TABLES: readonly string[] = [
  'orders',
  ...Object.values(paymentsSchema).flatMap((value) =>
    is(value, PgTable) ? [getTableName(value)] : [],
  ),
].sort();

/**
 * Every table in that closure, with what may still be rewritten in it.
 *
 * Ordered alphabetically so a diff adding one is a single insertion.
 */
export const COMMERCE_HISTORY_DISPOSITIONS: readonly CommerceHistoryDisposition[] = [
  {
    table: 'affiliate_commission_postings',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason:
      'A ledger posting, append-only by `affiliate_commission_postings_append_only` — a correction is a ' +
      'REVERSING posting, never an edit, which is the rule the whole ledger layer is built on.',
  },
  {
    table: 'buyer_request_events',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason: "#110's audit trail of a post-purchase request, append-only by trigger.",
  },
  {
    table: 'cancellation_request_lines',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: ['variant_id', 'requested_quantity'],
    reason: 'What the buyer asked for is frozen; only `approved_quantity` moves, and it is what a refund reads.',
  },
  {
    table: 'cancellation_requests',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A live request: it is filed, decided, then completed, so its status column exists to move.',
  },
  {
    table: 'disputes',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: ['provider', 'provider_dispute_id', 'payment_id', 'opened_booked_at'],
    reason:
      'GAP (#867): the identity of the dispute and the instant its opening was BOOKED are frozen, but ' +
      "`amount_amount`, `amount_currency` and `fee_amount` are NOT — `disputeRepository`'s " +
      '`onConflictDoUpdate` restates all three unconditionally on every redelivery, which a real ' +
      'inquiry-to-chargeback escalation needs, yet the ledger is booked from them AFTER that upsert and ' +
      'nothing reconciles a later move. The fix is a guard on the upsert, not a freeze here.',
  },
  {
    table: 'draft_order_applied_discounts',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A POS draft is a basket being built and is not commerce history until `complete` converts it to an order.',
  },
  {
    table: 'draft_order_line_item_option_values',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A POS draft is a basket being built and is not commerce history until `complete` converts it to an order.',
  },
  {
    table: 'draft_order_line_items',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A POS draft is a basket being built and is not commerce history until `complete` converts it to an order.',
  },
  {
    table: 'draft_order_tax_lines',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A POS draft is a basket being built and is not commerce history until `complete` converts it to an order.',
  },
  {
    table: 'draft_orders',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A POS draft is a basket being built; the immutable record is the `orders` row it converts into.',
  },
  {
    table: 'ledger_entries',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason:
      'The ledger leg, append-only by `ledger_entries_append_only` since the payment domain landed — ' +
      'a correction is a REVERSING transaction and there is deliberately no `reverseTransaction(id)`.',
  },
  {
    table: 'ledger_transactions',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason:
      'The balanced posting itself, append-only by `ledger_transactions_append_only`. ADR 0001 D3 makes ' +
      "this the ONLY record of Mercaria's commission, so an edit here is the one that cannot be recomputed.",
  },
  {
    table: 'merchant_subscription_events',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason:
      'A billing event, append-only by `merchant_subscription_events_append_only` — the same posture as ' +
      'every other ledger-shaped table, and for the same reason.',
  },
  {
    table: 'order_applied_discounts',
    rowUpdate: 'refused',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      'What a discount actually took off THIS order, persisted so a refund is computed against exactly ' +
      'what was charged — append-only by `order_applied_discounts_append_only` (#367 line 75). Nothing in the ' +
      'tree updates one. DELETE stays open: it is reached by the FK cascade from `orders`.',
  },
  {
    table: 'order_fee_snapshot_lines',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason: "#88's per-line allocation of the marketplace fee the order was placed under, append-only by trigger.",
  },
  {
    table: 'order_fee_snapshots',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason: "#88's immutable fee snapshot, the only fee input the money path reads, append-only by trigger.",
  },
  {
    table: 'order_item_option_values',
    rowUpdate: 'refused',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      'The `{name, value}` pairs printed on the receipt, append-only by ' +
      '`order_item_option_values_append_only` (#367 line 75). Nothing in the tree updates one. DELETE stays ' +
      'open: it is reached by the FK cascade from `order_items`.',
  },
  {
    table: 'order_items',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [
      'condition_key',
      'condition_assertion',
      'condition_notes',
      'order_id',
      'listing_id',
      'variant_id',
      'title',
      'variant_title',
      'image_url',
      'quantity',
      'location_id',
      'unit_price_shop_amount',
      'unit_price_shop_currency',
      'unit_price_presentment_amount',
      'unit_price_presentment_currency',
      'line_total_shop_amount',
      'line_total_shop_currency',
      'line_total_presentment_amount',
      'line_total_presentment_currency',
      'discount_total_shop_amount',
      'discount_total_shop_currency',
      'discount_total_presentment_amount',
      'discount_total_presentment_currency',
    ],
    reason:
      'One purchased line as it stood at checkout: what was sold, at what price, how many, and where ' +
      "from. #90's three condition columns keep their own bespoke trigger and the other twenty are " +
      "`order_items_snapshot_immutable` (#367 line 75). NOT a whole-row freeze: `position` stays open because " +
      '`db/__tests__/condition.realdb.test.ts` asserts an ordinary UPDATE still succeeds there — a ' +
      "vacuity guard proving #90's trigger is column-scoped rather than a whole-row refusal, and one " +
      'worth keeping. DELETE stays open: the FK cascade from `orders`.',
  },
  {
    table: 'order_pickups',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [
      'order_id',
      'location_id',
      'publication_id',
      'display_name',
      'public_line1',
      'public_line2',
      'public_city',
      'public_region',
      'public_postal_code',
      'public_country',
      'timezone',
      'pickup_instructions',
      'identity_requirement',
      'payment_requirement',
    ],
    reason: "#93's snapshot of the collection point as the buyer was shown it is frozen; the collection STATE on the same row moves.",
  },
  {
    table: 'order_status_history',
    rowUpdate: 'refused',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      'The lifecycle trail, now append-only by `order_status_history_append_only` (#367 line 75) rather than by ' +
      'the ABSENCE of an `updated_at` column, which stopped an ORM idiom and nothing else — measured, ' +
      'the status, the instant, the acting account and the note were all rewritable, so an audit row ' +
      'could be reattributed to a different person. DELETE stays open: the FK cascade from `orders`.',
  },
  {
    table: 'order_tax_lines',
    rowUpdate: 'refused',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      "One applied rate's contribution to a placed order's tax — the figure a tax authority can ask " +
      'about years later — append-only by `order_tax_lines_append_only` (#367 line 75). Nothing in the tree ' +
      'updates one. DELETE stays open: it is reached by the FK cascade from `orders`.',
  },
  {
    table: 'orders',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [
      'buyer_origin',
      'buyer_guest_checkout_id',
      'buyer_oxy_user_id',
      'claimed_by_oxy_user_id',
      'order_number',
      'checkout_group_id',
      'idempotency_key',
      'seller_type',
      'seller_oxy_user_id',
      'store_id',
      'customer_id',
      'commercial_role',
      'source_channel',
      'shipping_address_label',
      'shipping_address_recipient_name',
      'shipping_address_line1',
      'shipping_address_line2',
      'shipping_address_city',
      'shipping_address_region',
      'shipping_address_postal_code',
      'shipping_address_country',
      'shipping_address_phone',
      'shipping_method',
      'shipping_label',
      'shipping_cost_shop_amount',
      'shipping_cost_shop_currency',
      'shipping_cost_presentment_amount',
      'shipping_cost_presentment_currency',
      'totals_subtotal_shop_amount',
      'totals_subtotal_shop_currency',
      'totals_subtotal_presentment_amount',
      'totals_subtotal_presentment_currency',
      'totals_discount_total_shop_amount',
      'totals_discount_total_shop_currency',
      'totals_discount_total_presentment_amount',
      'totals_discount_total_presentment_currency',
      'totals_shipping_shop_amount',
      'totals_shipping_shop_currency',
      'totals_shipping_presentment_amount',
      'totals_shipping_presentment_currency',
      'totals_tax_shop_amount',
      'totals_tax_shop_currency',
      'totals_tax_presentment_amount',
      'totals_tax_presentment_currency',
      'totals_grand_total_shop_amount',
      'totals_grand_total_shop_currency',
      'totals_grand_total_presentment_amount',
      'totals_grand_total_presentment_currency',
      'fx_rate_from',
      'fx_rate_to',
      'fx_rate_rate',
      'fx_rate_as_of',
      'fx_rate_provider',
    ],
    reason:
      'The row MUST move — the lifecycle status, the payment linkage, the tracking number, the ' +
      'moderation hold, the claim pair and the connector-sync columns are all written today — so what ' +
      'was SOLD is frozen by column instead: the order number, the group, who sold it, the commercial ' +
      'model, the destination address snapshot and every money and FX column ' +
      '(`orders_snapshot_immutable`, #367 line 75), on top of ADR 0003 D6/I7\'s four buyer-identity columns, ' +
      'which keep their own bespoke trigger because it must permit `claimed_by_oxy_user_id` value → ' +
      'NULL (an audited unclaim) and the write-once guard would refuse it. `created_at` is deliberately ' +
      'left open: it is the RESERVATION CLOCK that `checkout.stripe.realdb.test.ts` moves to travel ' +
      'past the reservation TTL. DELETE stays open — `scripts/seed.ts` clears the table and eighteen ' +
      'realdb teardowns delete orders, and every child cascade depends on it.',
  },
  {
    table: 'payment_attempts',
    rowUpdate: 'refused',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      'The append-only log of what Mercaria asked a rail and what it answered: `recordPaymentAttempt` ' +
      'INSERTS and nothing in the tree updates an attempt, so the whole row is frozen. DELETE stays ' +
      'open because realdb teardown removes attempts alongside the payments they belong to.',
  },
  {
    table: 'payment_outboxes',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: ['event_type', 'payload'],
    reason:
      'The ROW IS THE JOB, so the lease, the attempt count and the schedule all move; what the job IS — ' +
      'its type and its payload — does not. DELETE is the shared retention sweep, which must keep working.',
  },
  {
    table: 'payment_provider_events',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [
      'provider',
      'provider_account_id',
      'provider_event_id',
      'type',
      'livemode',
      'api_version',
      'object_ids',
      'payload_summary',
      'received_at',
      'payment_id',
    ],
    reason:
      'What the provider SAID is frozen — a stored event is the evidence a webhook was verified against ' +
      'and a replay reads it back; the claim columns beside it move because the row is also the job. ' +
      '`payment_id` is frozen write-once, which additionally closes a hole: three writers set it with no ' +
      'compare-and-swap, so a re-resolution to a DIFFERENT payment would silently reattribute the event.',
  },
  {
    table: 'payments',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [
      'checkout_group_id',
      'buyer_oxy_user_id',
      'provider',
      'order_id',
      'presentment_amount',
      'presentment_currency',
      'provider_object_id',
      'platform_amount',
      'platform_currency',
      'platform_rate_from',
      'platform_rate_to',
      'platform_rate_rate',
      'platform_rate_provider',
      'platform_rate_as_of',
    ],
    reason:
      'The lifecycle `status` legitimately moves and is the whole reason the row is not frozen; what the ' +
      'buyer was CHARGED, what actually LANDED and the FX snapshot that relates them do not. The platform ' +
      'columns are NULL until the charge settles, so write-once admits the one stamp and refuses a later ' +
      'restatement — including from the reconciliation sweep, which re-applies the same figures by design.',
  },
  {
    table: 'payouts',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [
      'provider',
      'provider_account_ref',
      'provider_object_id',
      'amount_amount',
      'amount_currency',
    ],
    reason:
      'A payout BOOKS nothing (ADR 0001 D6 settled the receivable at transfer time), so its status, ' +
      'arrival and failure code converge from the rail — but the amount the rail paid and the account it ' +
      "paid is a fact as it stood. `upsertPayout`'s conflict branch already omits all five.",
  },
  {
    table: 'pickup_collection_credentials',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A live credential: it is issued, rotated and revoked, and its collection EVENTS are the append-only record.',
  },
  {
    table: 'pickup_collection_events',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason: 'What happened at the counter, append-only by trigger.',
  },
  {
    table: 'provider_accounts',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [
      'provider',
      'owner_type',
      'owner_id',
      'provider_account_id',
      'country',
      'activated_at',
      'revoked_at',
    ],
    reason:
      'Readiness is ONE stored verdict and every requirement count beside it moves at each sync; WHOSE ' +
      'account this is does not. `UNIQUE(provider, owner_type, owner_id)` is the security boundary (#46), ' +
      'and a connected account cannot be un-created, so re-pointing the row at another owner or another ' +
      'Stripe account is the write that must be impossible rather than merely unusual.',
  },
  {
    table: 'referral_ledger_postings',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason:
      'A ledger posting, append-only by `referral_ledger_postings_append_only` — same posture, same ' +
      'reason, as every other ledger-shaped table.',
  },
  {
    table: 'refund_line_items',
    rowUpdate: 'refused',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      'What was refunded, per line: quantity, both money pairs, the restock flag and its location. ' +
      'Nothing in the tree updates one, and the table carries no `updated_at` at all, so the whole row ' +
      'is frozen. DELETE stays open because it is reached by the FK cascade from `refunds`.',
  },
  {
    table: 'refunds',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [
      'order_id',
      'store_id',
      'seller_oxy_user_id',
      'type',
      'refund_shipping_shop_amount',
      'refund_shipping_shop_currency',
      'refund_shipping_presentment_amount',
      'refund_shipping_presentment_currency',
      'total_refunded_shop_amount',
      'total_refunded_shop_currency',
      'total_refunded_presentment_amount',
      'total_refunded_presentment_currency',
      'restocked_at',
      'processed_by_oxy_user_id',
      'idempotency_key',
      'provider',
      'payment_id',
      'provider_refund_id',
      'provider_reversal_id',
    ],
    reason:
      'The row must move — #49 keeps THREE states of one refund on it and they run on different clocks — ' +
      'so `status`, `provider_state`, `reversal_state`, `provider_failure_code` and the reversal amount ' +
      'are all left open. What the refund WAS FOR is frozen: the order, the seller, the type, both money ' +
      'pairs and the idempotency key, which is the half `schema/orders.ts` means by "immutable commerce ' +
      'record". `status` is deliberately NOT frozen even though nothing writes it today — it is the ' +
      'commerce clock of a three-clock row, and freezing it would pin present silence as the contract.',
  },
  {
    table: 'retail_cost_variance_records',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason: "#123 observes a variance and #128 recognizes it; the observation is append-only by trigger.",
  },
  {
    table: 'retail_customer_adjustments',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A live adjustment: it is owed, then paid, so its settlement columns exist to move.',
  },
  {
    table: 'retail_delivery_promises',
    rowUpdate: 'refused',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      "#126's promise trail refuses UPDATE, which is what stops a past promise being quietly rewritten; a row may still be swept.",
  },
  {
    table: 'retail_dispute_coordinations',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A live coordination record between the card rail and the supplier, decided after it is opened.',
  },
  {
    table: 'retail_fulfilment_intents',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [
      'order_id',
      'procurement_intent_id',
      'intent_kind',
      'supersedes_intent_id',
      'permitted_fulfilment_mode',
      'fulfilment_mode',
      'moovo_transport_request_id',
    ],
    reason:
      "#126's contractual grant is frozen and its OPERATIONAL mode is write-once, which is why the row itself stays updatable.",
  },
  {
    table: 'retail_fulfilment_line_allocations',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      'A cancelled intent releases its claim, so an allocation is released rather than frozen; the over-allocation invariant is held by its repository.',
  },
  {
    table: 'retail_ledger_recognitions',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason: 'What was recognized against a retail order, append-only by trigger.',
  },
  {
    table: 'retail_order_role_snapshots',
    rowUpdate: 'refused',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      "#126's record of who sold one order and under which consumer terms refuses UPDATE; DELETE is refused only while the order still exists.",
  },
  {
    table: 'retail_procurement_intent_lines',
    rowUpdate: 'refused',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      "#123 freezes the line at checkout — a revised total is a new quote and a new acceptance, never an edited line.",
  },
  {
    table: 'retail_procurement_intents',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [
      'order_id',
      'checkout_group_id',
      'supplier_id',
      'supplier_account_id',
      'agreement_id',
      'purchase_order_id',
      'supplier_cost_amount',
      'supplier_cost_currency',
      'buyer_locked_total_amount',
      'buyer_locked_total_currency',
    ],
    reason:
      "#123's \"WHAT was promised, frozen at checkout\", which `schema/retailCheckout.ts` says twice and " +
      '`retailFulfilment.ts` cites as an immutable home. The row moves — an intent is recorded, ' +
      'requested, then resolved — so `status`, `requested_at`, `failure_kind` and `failure_detail` stay ' +
      'open and everything the purchase order is COMPOSED from is frozen ' +
      '(`retail_procurement_intents_snapshot_immutable`, #367 line 75). `purchase_order_id` is frozen ' +
      "write-once, which admits `attachRetailIntentPurchaseOrder`'s one CAS stamp and refuses a " +
      're-point — a second purchase order for one intent being the duplicate-supplier-order failure the ' +
      'whole domain is shaped around. DELETE stays open: the FK cascade from `orders`.',
  },
  {
    table: 'retail_reconciliation_components',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason: 'One component of what a supplier billed against an order, append-only by trigger.',
  },
  {
    table: 'retail_reconciliation_evidence',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason: 'The document a reconciliation was decided from, append-only by trigger.',
  },
  {
    table: 'retail_reconciliation_exceptions',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'An open case an operator closes attributably, so the row moves once and is not a snapshot.',
  },
  {
    table: 'retail_reconciliation_operator_actions',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason: 'One row per operator ATTEMPT, refusals included, append-only by trigger.',
  },
  {
    table: 'retail_reconciliations',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason: 'What was reconciled against a supplier invoice, append-only by trigger.',
  },
  {
    table: 'retail_return_case_lines',
    rowUpdate: 'refused',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'The units a return case covers are frozen once the case is opened.',
  },
  {
    table: 'retail_return_cases',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A live case: authorized, shipped, received, dispositioned, so its state columns exist to move.',
  },
  {
    table: 'retail_return_line_dispositions',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason: 'What was decided about the goods that came back, append-only by trigger.',
  },
  {
    table: 'retail_service_request_evidence',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'No database enforcement, and none is claimed; the request EVENTS beside it are the append-only record.',
  },
  {
    table: 'retail_service_request_events',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason: 'The trail of what happened to a retail service request, append-only by trigger.',
  },
  {
    table: 'retail_service_request_lines',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: ['request_id', 'order_item_id', 'requested_quantity'],
    reason: 'What the customer asked for is frozen; only `approved_quantity` may move.',
  },
  {
    table: 'retail_service_requests',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [
      'order_id',
      'kind',
      'origin',
      'requester_kind',
      'requester_oxy_user_id',
      'customer_terms_version',
      'policy_market',
      'statutory_deadline_at',
      'commercial_deadline_at',
      'outcome',
    ],
    reason:
      'The order, the requester and the policy snapshot are frozen and the outcome cannot be re-decided; the workflow status moves.',
  },
  {
    table: 'retail_supplier_credits',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason: 'What a supplier credited back, append-only by trigger.',
  },
  {
    table: 'retail_warranty_cases',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A live case whose state moves as the manufacturer answers.',
  },
  {
    table: 'return_request_evidence',
    rowUpdate: 'refused',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: "#110's return evidence refuses UPDATE, so what a buyer submitted cannot be swapped for something else.",
  },
  {
    table: 'return_request_lines',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: ['variant_id', 'requested_quantity'],
    reason: 'What the buyer asked to return is frozen; only `approved_quantity` moves, and it is what the refund reads.',
  },
  {
    table: 'return_requests',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A live request: filed, approved, received, completed, so its status column exists to move.',
  },
  {
    table: 'review_aggregates',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: "#76's aggregate is a PROJECTION that everything derives and nothing increments, so re-deriving it is the point.",
  },
  {
    table: 'review_dimension_aggregates',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A projection rebuilt from the reviews beneath it, for the same reason as `review_aggregates`.',
  },
  {
    table: 'review_dimensions',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A reviewer may correct their own scores while the review is theirs to edit.',
  },
  {
    table: 'review_eligibilities',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A grant that is consumed: the row records that it was used, so it moves once.',
  },
  {
    table: 'review_target_migrations',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason: "#76's record of every review whose target was re-decided, append-only by trigger.",
  },
  {
    table: 'reviews',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A review is the author\'s to edit and moderation may hide it, so the row moves by design.',
  },
  {
    table: 'supplier_recoveries',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason: 'A live recovery: opened, pursued, settled or written off.',
  },
  {
    table: 'support_messages',
    rowUpdate: 'refused',
    rowDelete: 'refused',
    frozenColumns: [],
    reason: "#110's support thread messages, append-only against UPDATE and DELETE by trigger.",
  },
  {
    table: 'support_threads',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      'A thread is opened and closed; its MESSAGES are the append-only record. `drizzle/0054`\'s comment ' +
      'reads as if the thread were covered too — it is not, and the trigger is on `support_messages`.',
  },
  {
    table: 'transfers',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [
      'payment_id',
      'order_id',
      'provider',
      'amount_amount',
      'amount_currency',
      'provider_object_id',
    ],
    reason:
      "The seller's share as Mercaria computed it, frozen — `seller-net-shares.ts` is the ONE definition " +
      'and re-deriving it later would let rounding residue move between a seller and the commission ' +
      'residual. `status` and `reversed_amount` stay open because reversals are cumulative and their ' +
      "events are unordered, so the figure only ever moves FORWARD under `greatest()`. The repository's " +
      'own comment already states the rule: never the amount, the payment or the order.',
  },
];

/** Every declared table, for a caller that only needs the names. */
export const COMMERCE_HISTORY_TABLES: readonly string[] = COMMERCE_HISTORY_DISPOSITIONS.map(
  (entry) => entry.table,
);

/** One table's declaration, or `undefined` when it has none. */
export function commerceHistoryDispositionFor(table: string): CommerceHistoryDisposition | undefined {
  return COMMERCE_HISTORY_DISPOSITIONS.find((entry) => entry.table === table);
}
