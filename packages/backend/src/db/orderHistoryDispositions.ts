/**
 * What each table holding a fact about a PLACED ORDER may still have rewritten
 * — the declared half of epic #367's "No historical commerce snapshot is
 * rewritten".
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
 * `merge-plan.ts`'s arrangement one domain over. `order-history-census.test.ts`
 * walks the drizzle schema for the transitive foreign-key closure of `orders`
 * and asserts this list covers EXACTLY that set, so a new table naming an order
 * fails the build until somebody decides what may be rewritten in it — at the
 * moment the reference is added, by the person adding it.
 * `order-history-immutability.realdb.test.ts` then EXECUTES each declaration
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
 * ## Nine entries record a GAP or a PARTIAL rather than a guarantee
 *
 * `schema/orders.ts`'s own opening line calls eight tables "the immutable
 * commerce record" — `orders`, `order_items`, `order_item_option_values`,
 * `order_status_history`, `order_applied_discounts`, `order_tax_lines`,
 * `refunds`, `refund_line_items`. Two of the eight carry a trigger, and both are
 * scoped to a handful of COLUMNS: an order's buyer identity and a line's
 * recorded condition. The other six refuse nothing at all. Separately,
 * `retail_procurement_intents` is called frozen at checkout and cited elsewhere
 * as an immutable home, and only its LINES are enforced.
 *
 * Those nine are recorded as what the database ACTUALLY does, with the
 * discrepancy named in the reason. Declaring them `refused` to match the prose
 * would make this file the fiction instead of the schema — and the realdb half
 * would fail immediately, which is the property that keeps this honest.
 *
 * None of it is fixed here. Adding a trigger to a live commerce table is a
 * migration and a decision about existing writers (`refunds` in particular MUST
 * stay mutable — #49 keeps three states of one refund on the row), so the gap is
 * reported rather than papered over.
 */

/** What the database does to an UPDATE or a DELETE of a whole row. */
export type OrderHistoryVerdict = 'refused' | 'allowed';

/** One table's declared disposition. */
export interface OrderHistoryDisposition {
  /** The Postgres table name, as the migrations create it. */
  readonly table: string;
  /**
   * What an UPDATE that changes NO column does.
   *
   * A no-op deliberately: it separates a table whose every row is frozen from
   * one that merely freezes named columns, which a value-changing probe cannot
   * tell apart.
   */
  readonly rowUpdate: OrderHistoryVerdict;
  /** What `DELETE` of the row does. */
  readonly rowDelete: OrderHistoryVerdict;
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
 * The root the population is derived from.
 *
 * One root, not a list of tables: "a record about a placed order" is exactly
 * "reachable from `orders` by a foreign key", so the boundary is a property of
 * the schema rather than of anybody's memory.
 */
export const ORDER_HISTORY_ROOT_TABLE = 'orders';

/**
 * Every table in that closure, with what may still be rewritten in it.
 *
 * Ordered alphabetically so a diff adding one is a single insertion.
 */
export const ORDER_HISTORY_DISPOSITIONS: readonly OrderHistoryDisposition[] = [
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
    table: 'order_applied_discounts',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      "GAP: named in `schema/orders.ts`'s \"immutable commerce record\" list, and carrying no enforcement of any kind.",
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
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      "GAP: named in `schema/orders.ts`'s \"immutable commerce record\" list, and carrying no enforcement of any kind.",
  },
  {
    table: 'order_items',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: ['condition_key', 'condition_assertion', 'condition_notes'],
    reason:
      "PARTIAL: #90's three condition columns refuse UPDATE, but the `title`, `unit_price` and " +
      '`quantity` that `schema/orders.ts` calls frozen at checkout do not, and neither does DELETE.',
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
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      'GAP: `schema/orders.ts` calls it the append-only lifecycle trail and rests that on the ABSENCE of ' +
      'an `updated_at` column, which stops an ORM idiom rather than an UPDATE. No trigger exists.',
  },
  {
    table: 'order_tax_lines',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      "GAP: named in `schema/orders.ts`'s \"immutable commerce record\" list, and carrying no enforcement of any kind.",
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
    ],
    reason:
      'PARTIAL: the four buyer-identity columns are frozen (ADR 0003 D6/I7), which is right — but the ' +
      'status and every money column move by design, and nothing refuses a DELETE of an order.',
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
    table: 'refund_line_items',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      "GAP: named in `schema/orders.ts`'s \"immutable commerce record\" list, and carrying no enforcement of any kind.",
  },
  {
    table: 'refunds',
    rowUpdate: 'allowed',
    rowDelete: 'allowed',
    frozenColumns: [],
    reason:
      "CONFLICTED: #49 keeps three states of one refund here and the provider's own arrives late, so the " +
      'row must move — yet `schema/orders.ts` lists it as part of the immutable commerce record.',
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
    frozenColumns: [],
    reason:
      'GAP: `schema/retailCheckout.ts` calls it frozen at checkout and `retailFulfilment.ts` cites it as an ' +
      'immutable home, but only its LINES carry a trigger — `buyer_locked_total_amount` is freely updatable.',
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
];

/** Every declared table, for a caller that only needs the names. */
export const ORDER_HISTORY_TABLES: readonly string[] = ORDER_HISTORY_DISPOSITIONS.map(
  (entry) => entry.table,
);

/** One table's declaration, or `undefined` when it has none. */
export function orderHistoryDispositionFor(table: string): OrderHistoryDisposition | undefined {
  return ORDER_HISTORY_DISPOSITIONS.find((entry) => entry.table === table);
}
