/**
 * `orders` and its child tables — `order_items`, `order_item_option_values`,
 * `order_status_history`, `order_applied_discounts`, `order_tax_lines`, plus
 * the fee snapshot pair (`order_fee_snapshots` / `order_fee_snapshot_lines`,
 * schema in `../schema/fees.ts`) whose WRITE lives here so it commits with the
 * order.
 *
 * One Mongoose document became six tables, so this module is where "an order" is
 * assembled and taken apart again. {@link OrderRecord} is the row with all five
 * children attached, which is the shape `order-hydration`, `refund.service` and
 * the summary views all already wanted; nothing above this layer joins them.
 *
 * ## The write side speaks `Money`, the read side speaks columns
 *
 * A `DualMoney` is FOUR columns and an order carries six of them plus its lines,
 * so an insert that made every caller spell `totalsGrandTotalPresentmentCurrency`
 * would put the column layout in `checkout.service`, `draft-order.service` and
 * `connector-sync.service` at once. {@link insertOrder} therefore takes the
 * domain `Money` / `DualMoney` objects the pricing engine already produces and
 * flattens them here, in the one module that owns the layout.
 *
 * Reads go the other way and return the flat rows verbatim, matching every other
 * repository in `db/`. The asymmetry is deliberate: a write composes ONE
 * aggregate and a read feeds serializers that were already mapping field by
 * field.
 *
 * ## `paymentReference` is never selected
 *
 * `payment.reference` is the payment provider's own transaction id and is
 * registered in `db/protectedColumns.ts`. Every read here goes through
 * `publicColumns`, so {@link OrderRow} has no such property and a serializer that
 * reaches for one fails `tsc` rather than shipping it. A path that legitimately
 * needs it must name it explicitly, which stays greppable.
 *
 * ## The CAS is the whole point of {@link transitionOrderStatus}
 *
 * Mongo's `findOneAndUpdate({_id, status: current}, …)` made the guard and the
 * mutation one operation, which is what stopped a buyer's `cancel` racing the
 * expire-reservations sweep from running the inventory side-effects twice. The
 * Postgres form is `UPDATE … WHERE id = $1 AND status = $2 RETURNING`, and it has
 * the same property for the same reason: the row is locked for the statement, so
 * the predicate is re-checked against the winner's write. **A `null` return means
 * the guard refused**, never "nothing to do" — the caller raises CONFLICT.
 */

import { and, asc, count, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { InferSelectModel, SQL } from 'drizzle-orm';
import { type SelectedRow } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import type {
  AddressSnapshot,
  CommercialMode,
  ConditionAssertion,
  ConnectorProviderId,
  CurrencyCode,
  DualMoney,
  FeeBasis,
  FeeClamp,
  FeeSnapshotResult,
  FxRateSnapshot,
  ItemConditionKey,
  Money,
  OrderActorKind,
  OrderBuyerOrigin,
  OrderSellerType,
  OrderSourceChannel,
  OrderStatus,
  PaymentInfo,
  PaymentProviderId,
  ShippingMethod,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { orderFeeSnapshotLines, orderFeeSnapshots } from '../schema/fees.js';
import { guestCheckouts } from '../schema/guests.js';
import {
  orderAppliedDiscounts,
  orderItemOptionValues,
  orderItems,
  orderStatusHistory,
  orderTaxLines,
  orders,
} from '../schema/orders.js';

/** Zero-padding width of the numeric portion of an order number. */
const ORDER_NUMBER_PAD = 6;
/** Prefix prepended to every order number — printed on receipts. */
const ORDER_NUMBER_PREFIX = 'MRC-';

/** Every column of `orders` a client may see — `payment_reference` withheld. */
const PUBLIC_ORDER_COLUMNS = publicColumns(orders, PROTECTED_COLUMNS);

/**
 * Every column of `order_status_history` a client may see —
 * `actor_guest_session_id` withheld (#106, ADR 0003 D16).
 *
 * The trail is attached to EVERY order by {@link withChildren} and serialized
 * whole, so an ordinary `select()` here would put a guest's session row id in a
 * merchant's order response — the correlation key invariant I11 forbids. The
 * operator surface names the column explicitly instead, which reads differently
 * and stays greppable.
 */
const PUBLIC_STATUS_EVENT_COLUMNS = publicColumns(orderStatusHistory, PROTECTED_COLUMNS);

/** One row of `orders`, without the protected payment reference. */
export type OrderRow = SelectedRow<typeof PUBLIC_ORDER_COLUMNS>;

/** One row of `order_items`. */
export type OrderItemRow = InferSelectModel<typeof orderItems>;

/** One row of `order_item_option_values`. */
export type OrderItemOptionValueRow = InferSelectModel<typeof orderItemOptionValues>;

/** One row of `order_status_history`, without the protected guest session id. */
export type OrderStatusEventRow = SelectedRow<typeof PUBLIC_STATUS_EVENT_COLUMNS>;

/** One row of `order_applied_discounts`. */
export type OrderAppliedDiscountRow = InferSelectModel<typeof orderAppliedDiscounts>;

/** One row of `order_tax_lines`. */
export type OrderTaxLineRow = InferSelectModel<typeof orderTaxLines>;

/** A purchased line with its printed `{name, value}` pairs attached. */
export interface OrderItemRecord extends OrderItemRow {
  readonly optionValues: OrderItemOptionValueRow[];
}

/** An order row with all five child relations attached — what callers read. */
export interface OrderRecord extends OrderRow {
  readonly items: OrderItemRecord[];
  readonly statusHistory: OrderStatusEventRow[];
  readonly appliedDiscounts: OrderAppliedDiscountRow[];
  readonly taxLines: OrderTaxLineRow[];
}

/** A purchased line as a caller supplies it, before it has an id. */
export interface NewOrderItem {
  listingId: string;
  variantId: string;
  title: string;
  variantTitle: string;
  imageUrl?: string;
  optionValues: { name: string; value: string }[];
  unitPrice: DualMoney;
  quantity: number;
  lineTotal: DualMoney;
  discountTotal?: DualMoney;
  locationId?: string;
  /**
   * The condition AS PRESENTED AT CHECKOUT (#90 propagation rule 2).
   *
   * Optional because a POS sale and a connector-imported order have no
   * Mercaria-side condition to snapshot, and inventing one would be a claim
   * about goods this service never described. The CHECK pairs the key with its
   * assertion, so a caller supplying one and not the other is refused rather
   * than storing half a snapshot.
   */
  conditionKey?: ItemConditionKey;
  conditionAssertion?: ConditionAssertion;
  conditionNotes?: string;
}

/**
 * One lifecycle event as a caller supplies it.
 *
 * The actor is a KIND plus at most one id, and the kind is REQUIRED (ADR 0003
 * D16). Before #106 a caller could omit `byOxyUserId` and the row was
 * indistinguishable from a sweep's; now omitting the actor means stating
 * `actorKind: 'system'`, which is a claim about who acted rather than a gap.
 * `order_status_history_actor_check` refuses every mismatched combination, so a
 * writer that names an Oxy actor without an id, or a guest actor with one, is
 * rejected by the database rather than by review.
 */
export interface NewOrderStatusEvent {
  status: OrderStatus;
  at: Date;
  /** Which KIND of actor drove the transition. Never defaulted by a writer. */
  actorKind: OrderActorKind;
  /** Required for `oxy`/`operator`, forbidden otherwise. */
  byOxyUserId?: string;
  /** Required for `guest`, forbidden otherwise. The session ROW id, never a token. */
  actorGuestSessionId?: string;
  note?: string;
}

/** One discount's contribution as a caller supplies it (SHOP-currency `Money`). */
export interface NewOrderAppliedDiscount {
  discountId: string;
  code?: string;
  title: string;
  valueType: OrderAppliedDiscountRow['valueType'];
  amount: Money;
  target: 'order' | 'line';
  targetLineIndex?: number;
}

/** One applied tax rate's contribution as a caller supplies it. */
export interface NewOrderTaxLine {
  name: string;
  rateBps: number;
  amount: Money;
}

/**
 * The order's immutable marketplace-fee snapshot (#88), written with the order
 * in the SAME transaction. Composed by `services/fees/order-fees.service.ts` at
 * authoritative pricing time; the shape mirrors `order_fee_snapshots` and its
 * CHECKs decide which fields travel together.
 *
 * `lineAllocationsMinor` is aligned to `items` by INDEX, exactly as
 * `optionValues` is — the repository resolves the freshly-minted item ids.
 */
export interface NewOrderFeeSnapshot {
  commercialMode: CommercialMode;
  result: FeeSnapshotResult;
  scheduleKey?: string;
  scheduleVersion?: number;
  basis?: FeeBasis;
  basisAmount?: Money;
  percentageBps?: number;
  fixedFeeMinor?: number;
  clampApplied?: FeeClamp;
  fee?: Money;
  roundingAdjustmentMinor?: number;
  termsVersionAccepted?: string;
  scopeSellerType?: OrderSellerType;
  scopeCurrency?: CurrencyCode;
  lineAllocationsMinor?: number[];
}

/** Connector provenance for an order imported from an external platform. */
export interface NewOrderSource {
  connectionId: string;
  provider: ConnectorProviderId;
  externalId: string;
  externalUpdatedAt?: Date;
}

/** A whole order as a caller supplies it — the aggregate `insertOrder` writes. */
export interface NewOrder {
  orderNumber: string;
  /**
   * Where the buyer identity came from (ADR 0003 D6). Every writer states it
   * EXPLICITLY rather than leaning on the column default: the default exists so
   * the migration could fill a table of existing rows without a rewrite, and a
   * new writer that forgot would silently produce an `oxy` order for a guest.
   */
  buyerOrigin: OrderBuyerOrigin;
  /** Set iff `buyerOrigin` is `'oxy'` (or a legacy `'external'` `ext:` value). */
  buyerOxyUserId?: string;
  /** Set iff `buyerOrigin` is `'guest'` — the group's `guest_checkouts` row. */
  buyerGuestCheckoutId?: string;
  sellerType: OrderSellerType;
  sellerOxyUserId?: string;
  storeId?: string;
  customerId?: string;
  sourceChannel?: OrderSourceChannel;
  source?: NewOrderSource;
  shippingAddress: AddressSnapshot;
  shippingMethod: ShippingMethod;
  shippingLabel: string;
  shippingCost: DualMoney;
  totals: {
    subtotal: DualMoney;
    discountTotal: DualMoney;
    shipping: DualMoney;
    tax: DualMoney;
    grandTotal: DualMoney;
  };
  fxRate?: FxRateSnapshot;
  status: OrderStatus;
  paymentStatus: PaymentInfo['status'];
  /**
   * OPTIONAL, and normally omitted at insert. A freshly checked-out order has
   * reserved stock and no payment, so it has no rail either — the provider is
   * stamped by `linkPaymentToCheckoutGroup` when a payment appears. Only a path
   * that creates an ALREADY-paid order (a connector import, the seed) supplies
   * it up front.
   */
  paymentProvider?: PaymentProviderId;
  paymentPaidAt?: Date;
  checkoutGroupId: string;
  idempotencyKey?: string;
  items: NewOrderItem[];
  statusHistory: NewOrderStatusEvent[];
  appliedDiscounts: NewOrderAppliedDiscount[];
  taxLines: NewOrderTaxLine[];
  /**
   * OPTIONAL, and its absence is meaningful: an order with no snapshot row is
   * read everywhere as the pre-#88 zero-fee reality (POS drafts and connector
   * imports have no explicitly selected channel policy yet, and legacy orders
   * predate the table). Native checkout ALWAYS supplies one.
   */
  feeSnapshot?: NewOrderFeeSnapshot;
}

/**
 * The columns a lifecycle move sets besides `status`. No settlement fact appears
 * here: reaching `paid` records THAT an order was paid, never how the money
 * settles — provider, captured amount and any provider-side conversion belong to
 * the payment domain, which owns them per payment rather than per status flip.
 */
export interface OrderTransitionPatch {
  paymentStatus?: PaymentInfo['status'];
  paymentPaidAt?: Date;
  shippingTrackingNumber?: string;
}

/** Which orders a list query is scoped to. Exactly one owner field is set. */
export interface OrderListFilter {
  /**
   * The ORIGIN buyer column alone.
   *
   * Kept beside {@link OrderListFilter.buyerOrClaimantOxyUserId} rather than
   * replaced by it, because the two answer different questions and both are
   * asked: "which orders did this account PLACE" (reports, the customer
   * relation, anything that must not count somebody else's purchase as this
   * account's own) versus "which orders may this account SEE" (every buyer
   * surface). Collapsing them would silently widen the first.
   */
  buyerOxyUserId?: string;
  /**
   * The buyer-ACCESS predicate: `buyer_oxy_user_id = $1 OR
   * claimed_by_oxy_user_id = $1` (ADR 0003 D7, #106 DTO rule 6).
   *
   * Two indexed scans — `orders_buyer_created_at_idx` and
   * `orders_claimed_by_created_at_idx` — so a claimed guest order appears in
   * the claimant's history without a second query and without a join. Until any
   * claim exists it degenerates to exactly today's plan.
   */
  buyerOrClaimantOxyUserId?: string;
  sellerOxyUserId?: string;
  storeId?: string;
  customerId?: string;
  status?: OrderStatus;
}

/**
 * Attach every child relation to a batch of order rows, in FOUR queries for the
 * whole batch plus one for the option values — never one per order.
 *
 * Batched rather than joined for the reason the store repository states: a join
 * multiplies the order row by its line count and every scalar column has to be
 * de-duplicated back out, which is where a money rollup silently doubles.
 *
 * Every child is ordered by the column that reproduces the embedded array's
 * order — `position` for the three that had one, `at` for the append-only status
 * trail. `id` breaks a `position` tie so a page cannot wobble between requests.
 */
async function withChildren(
  rows: OrderRow[],
  db: DatabaseOrTransaction,
): Promise<OrderRecord[]> {
  if (rows.length === 0) return [];
  const orderIds = rows.map((row) => row.id);

  const [itemRows, historyRows, discountRows, taxRows] = await Promise.all([
    db
      .select()
      .from(orderItems)
      .where(inArray(orderItems.orderId, orderIds))
      .orderBy(asc(orderItems.position), asc(orderItems.id)),
    db
      .select(PUBLIC_STATUS_EVENT_COLUMNS)
      .from(orderStatusHistory)
      .where(inArray(orderStatusHistory.orderId, orderIds))
      .orderBy(asc(orderStatusHistory.at), asc(orderStatusHistory.id)),
    db
      .select()
      .from(orderAppliedDiscounts)
      .where(inArray(orderAppliedDiscounts.orderId, orderIds))
      .orderBy(asc(orderAppliedDiscounts.position), asc(orderAppliedDiscounts.id)),
    db
      .select()
      .from(orderTaxLines)
      .where(inArray(orderTaxLines.orderId, orderIds))
      .orderBy(asc(orderTaxLines.position), asc(orderTaxLines.id)),
  ]);

  const optionRows =
    itemRows.length > 0
      ? await db
          .select()
          .from(orderItemOptionValues)
          .where(
            inArray(
              orderItemOptionValues.orderItemId,
              itemRows.map((item) => item.id),
            ),
          )
          .orderBy(asc(orderItemOptionValues.position), asc(orderItemOptionValues.id))
      : [];

  const optionsByItem = groupBy(optionRows, (row) => row.orderItemId);
  const items = itemRows.map((item) => ({
    ...item,
    optionValues: optionsByItem.get(item.id) ?? [],
  }));

  const itemsByOrder = groupBy(items, (row) => row.orderId);
  const historyByOrder = groupBy(historyRows, (row) => row.orderId);
  const discountsByOrder = groupBy(discountRows, (row) => row.orderId);
  const taxByOrder = groupBy(taxRows, (row) => row.orderId);

  return rows.map((row) => ({
    ...row,
    items: itemsByOrder.get(row.id) ?? [],
    statusHistory: historyByOrder.get(row.id) ?? [],
    appliedDiscounts: discountsByOrder.get(row.id) ?? [],
    taxLines: taxByOrder.get(row.id) ?? [],
  }));
}

/** Bucket rows by a key, preserving the order the query returned them in. */
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const bucket = grouped.get(id);
    if (bucket) bucket.push(row);
    else grouped.set(id, [row]);
  }
  return grouped;
}

/**
 * "This account placed it, OR this account claimed it" — ADR 0003 D7's buyer
 * predicate, in ONE place.
 *
 * Written once and reused by every buyer-scoped read, because it is the
 * definition of buyer ACCESS and a second spelling of it somewhere else is how
 * a claimed order becomes visible on the list and invisible on the detail
 * route. `services/orders/order-access.service.ts` holds the same rule for a
 * loaded order; `order-access.realdb.test.ts` drives one matrix through both
 * and fails if they disagree.
 */
function buyerOrClaimantSql(oxyUserId: string): SQL {
  // `or` over two equalities rather than `coalesce(claimed_by, buyer) = $1`:
  // the latter is not an indexable predicate on either column, so it would turn
  // every buyer's order list into a sequential scan of the whole table.
  const predicate = or(
    eq(orders.buyerOxyUserId, oxyUserId),
    eq(orders.claimedByOxyUserId, oxyUserId),
  );
  if (!predicate) {
    // `or` is typed as possibly-undefined because it accepts a spread that
    // could be empty; both arguments here are always present, so this is
    // unreachable. Naming it beats a non-null assertion.
    throw new Error('buyerOrClaimantSql produced an empty predicate');
  }
  return predicate;
}

/** The `WHERE` an {@link OrderListFilter} describes, or `undefined` for all orders. */
function orderFilterSql(filter: OrderListFilter): SQL | undefined {
  const clauses: SQL[] = [];
  if (filter.buyerOxyUserId !== undefined) {
    clauses.push(eq(orders.buyerOxyUserId, filter.buyerOxyUserId));
  }
  if (filter.buyerOrClaimantOxyUserId !== undefined) {
    clauses.push(buyerOrClaimantSql(filter.buyerOrClaimantOxyUserId));
  }
  if (filter.sellerOxyUserId !== undefined) {
    // Paired with the seller TYPE, exactly as the Mongo filter was: a store order
    // never carries a seller user id, but stating both keeps the predicate the
    // same shape as the index it uses and as the query it replaces.
    clauses.push(eq(orders.sellerType, 'user'));
    clauses.push(eq(orders.sellerOxyUserId, filter.sellerOxyUserId));
  }
  if (filter.storeId !== undefined) clauses.push(eq(orders.storeId, filter.storeId));
  if (filter.customerId !== undefined) clauses.push(eq(orders.customerId, filter.customerId));
  if (filter.status !== undefined) clauses.push(eq(orders.status, filter.status));
  return clauses.length > 0 ? and(...clauses) : undefined;
}

/** One order with its children, or `null`. */
export async function findOrderById(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRecord | null> {
  const rows = await db
    .select(PUBLIC_ORDER_COLUMNS)
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  const [record] = await withChildren(rows, db);
  return record ?? null;
}

/**
 * One order by the number printed on it, or `null`.
 *
 * `UNIQUE(orders.order_number)` makes this a single row rather than a search.
 * The number is Mercaria-issued and appears on receipts, so it is the handle a
 * support conversation actually starts from — which is why #50's operator trace
 * accepts it, reaching it through `order-linkage.ts` like every other read the
 * payment domain makes of this table.
 */
export async function findOrderByOrderNumber(
  orderNumber: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRecord | null> {
  const rows = await db
    .select(PUBLIC_ORDER_COLUMNS)
    .from(orders)
    .where(eq(orders.orderNumber, orderNumber))
    .limit(1);
  const [record] = await withChildren(rows, db);
  return record ?? null;
}

/**
 * One order matching an ownership filter, or `null` — the load every mutating
 * route makes, where the SCOPING IS the authorization.
 */
export async function findOrderMatching(
  filter: OrderListFilter & { id: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRecord | null> {
  const scope = orderFilterSql(filter);
  const rows = await db
    .select(PUBLIC_ORDER_COLUMNS)
    .from(orders)
    .where(scope ? and(eq(orders.id, filter.id), scope) : eq(orders.id, filter.id))
    .limit(1);
  const [record] = await withChildren(rows, db);
  return record ?? null;
}

/** A page of orders, newest first, plus the total matching count. */
export async function findOrdersPage(
  filter: OrderListFilter,
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: OrderRecord[]; total: number }> {
  const where = orderFilterSql(filter);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select(PUBLIC_ORDER_COLUMNS)
      .from(orders)
      .where(where)
      // `desc nulls last` rather than `desc()`: a bare Postgres `DESC` is NULLS
      // FIRST, which neither matches `orders_*_created_at_idx` nor Mongo's
      // descending sort. `created_at` is NOT NULL so no row moves either way
      // today — this keeps the ordering usable by the index it was built for.
      .orderBy(sql`${orders.createdAt} desc nulls last`, sql`${orders.id} desc nulls last`)
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ total: count() }).from(orders).where(where),
  ]);
  return { rows: await withChildren(rows, db), total: totalRow?.total ?? 0 };
}

/** Every order of a list filter, newest first — the un-paged customer history. */
export async function findOrders(
  filter: OrderListFilter,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRecord[]> {
  const rows = await db
    .select(PUBLIC_ORDER_COLUMNS)
    .from(orders)
    .where(orderFilterSql(filter))
    .orderBy(sql`${orders.createdAt} desc nulls last`, sql`${orders.id} desc nulls last`);
  return withChildren(rows, db);
}

/**
 * Who a checkout group belongs to, for the reads that ARE the authorization.
 *
 * The two id spaces need different joins, not just different columns: an Oxy
 * buyer is on the order row itself, while a guest reaches their orders through
 * the contact record their session created (`orders.buyer_guest_checkout_id` →
 * `guest_checkouts.guest_session_id`). Modelling that as one nullable string
 * plus a boolean would be exactly the aliasing ADR 0003 I1 exists to prevent;
 * the discriminated union forces the caller to say which it holds and the
 * compiler forces this function to switch.
 */
export type CheckoutGroupOwner =
  | { kind: 'oxy_user'; oxyUserId: string }
  | { kind: 'guest_session'; guestSessionId: string };

/**
 * Every order of one checkout group belonging to one buyer — the replay read,
 * and the authorization behind `GET /checkout/:groupId/payment-status`.
 *
 * A checkout group id is a server-issued uuid v7 and the orders under it are
 * the only thing that proves whose it is, so this predicate IS the access
 * check: a group belonging to somebody else comes back empty and the caller
 * answers 404 rather than confirming it exists.
 */
export async function findOrdersByCheckoutGroup(
  checkoutGroupId: string,
  owner: CheckoutGroupOwner,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRecord[]> {
  if (owner.kind === 'guest_session') {
    // An INNER join, so an order with no contact record cannot match — which is
    // every `oxy` and `external` order, by the identity CHECK. A guest sees the
    // orders their own session's contact record names and nothing else.
    const joined = await db
      .select({ order: PUBLIC_ORDER_COLUMNS })
      .from(orders)
      .innerJoin(guestCheckouts, eq(orders.buyerGuestCheckoutId, guestCheckouts.id))
      .where(
        and(
          eq(orders.checkoutGroupId, checkoutGroupId),
          eq(guestCheckouts.guestSessionId, owner.guestSessionId),
        ),
      )
      .orderBy(asc(orders.createdAt), asc(orders.id));
    return withChildren(
      joined.map((row) => row.order),
      db,
    );
  }

  const rows = await db
    .select(PUBLIC_ORDER_COLUMNS)
    .from(orders)
    // Buyer ACCESS, not the origin column: an Oxy account that claimed a guest
    // group (#109) must be able to read that group's payment status, and
    // scoping on `buyer_oxy_user_id` alone would answer 404 for an order it
    // legitimately owns.
    .where(and(eq(orders.checkoutGroupId, checkoutGroupId), buyerOrClaimantSql(owner.oxyUserId)))
    .orderBy(asc(orders.createdAt), asc(orders.id));
  return withChildren(rows, db);
}

/**
 * Every order of one checkout group, whoever it belongs to — the PAYMENT read.
 *
 * Deliberately a second function rather than an optional buyer on the one above:
 * there the buyer id IS the authorization, and making it optional would let a
 * caller drop the scope by forgetting an argument. The payment domain has no
 * buyer to scope by — a payment outbox event carries ids, not a session — so it
 * needs the unscoped read, and reaching it has to be an explicit choice that
 * greps differently.
 */
export async function findOrdersInCheckoutGroup(
  checkoutGroupId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRecord[]> {
  const rows = await db
    .select(PUBLIC_ORDER_COLUMNS)
    .from(orders)
    .where(eq(orders.checkoutGroupId, checkoutGroupId))
    .orderBy(asc(orders.createdAt), asc(orders.id));
  return withChildren(rows, db);
}

/** One buyer-identity invariant, counted, with a bounded sample of offenders. */
export interface BuyerIdentityFinding {
  /** How many rows violate it, over the whole table. */
  readonly count: number;
  /** Up to {@link BUYER_CONSISTENCY_SAMPLE} offending ids, so a person can look. */
  readonly sample: string[];
}

/** Hard ceiling on ids one consistency finding returns. */
const BUYER_CONSISTENCY_SAMPLE = 20;

/**
 * The four cross-row buyer invariants no CHECK can express (#106 migration
 * rule 10, acceptance 9).
 *
 * `orders_buyer_identity_check` sees ONE row, which is why it catches every
 * illegal COMBINATION and none of these: each compares a row against another
 * row, or against a convention no constraint can encode. All four should always
 * answer zero, and each is worth asking for a different reason.
 */
export interface BuyerIdentityConsistency {
  /**
   * `'oxy'` orders whose buyer id carries the legacy connector prefix.
   *
   * ADR 0003 M4's discriminating count, named there and kept as a standing
   * check rather than a one-off migration assertion: the backfill keys on
   * `source_connection_id`, so a connector import that arrived WITHOUT a
   * connection row would still be misclassified — and it would look exactly
   * like a real Oxy buyer to every report that groups by origin.
   */
  readonly legacyExternalMisclassified: BuyerIdentityFinding;
  /**
   * Checkout groups whose sibling orders disagree about `buyer_origin`.
   *
   * One cart is one buyer. The orders of a group are written in one transaction
   * from one actor, so a disagreement means a write path composed a group from
   * two actors — which would let a guest's order sit beside an authenticated
   * one under a single payment.
   */
  readonly mixedOriginGroups: BuyerIdentityFinding;
  /**
   * Checkout groups PARTIALLY claimed — some orders carry a claimant, some do
   * not, or they name different accounts.
   *
   * ADR 0003 D14 makes a claim group-atomic ("a group can never be split"), and
   * the atomicity is a transaction rather than a constraint, so this is the
   * only thing that can observe it failing. A partial claim is the state in
   * which one order of a purchase is visible in an account's history and its
   * sibling is not.
   */
  readonly partiallyClaimedGroups: BuyerIdentityFinding;
  /**
   * Guest contact records with no order at all.
   *
   * `orders.buyer_guest_checkout_id`'s `RESTRICT` foreign key makes the reverse
   * (an order pointing at a missing contact) unrepresentable; this is the
   * direction the database cannot state. A contact row for a checkout that
   * never produced an order is a person's email retained for nothing, which is
   * a retention defect rather than a correctness one — and it is exactly what a
   * checkout that wrote the contact OUTSIDE the orders' transaction would leave
   * behind (#105's transaction boundary is what prevents it).
   */
  readonly orphanedGuestCheckouts: BuyerIdentityFinding;
}

/**
 * Turn one probe's rows into a finding.
 *
 * `count(*) over ()` in each statement below rather than a second `count`
 * query: the window is evaluated BEFORE the `LIMIT`, so one statement yields
 * the whole count alongside the bounded sample — and one statement cannot see
 * two different table states the way two statements can.
 */
function toFinding(rows: readonly { id: string; total: string }[]): BuyerIdentityFinding {
  return { count: Number(rows[0]?.total ?? 0), sample: rows.map((row) => row.id) };
}

/**
 * Every buyer-identity invariant, counted.
 *
 * READ-ONLY and deliberately so: this is the guest-commerce operator surface's
 * posture (`internal-guest-commerce.ts`) and there is nothing here to repair
 * automatically. A misclassified origin, a mixed group and a partial claim are
 * each a decision about a commercial record, and #50's rule — "nothing
 * auto-deletes or rewrites financial history to hide a mismatch" — applies to a
 * buyer identity for the same reason it applies to a ledger entry.
 */
export async function readBuyerIdentityConsistency(
  db: DatabaseOrTransaction = getDb(),
): Promise<BuyerIdentityConsistency> {
  const [misclassified, mixedOrigin, partialClaim, orphanedContacts] = await Promise.all([
    db.execute<{ id: string; total: string }>(
      sql`select id, count(*) over () as total
            from orders
           where buyer_origin = 'oxy' and buyer_oxy_user_id like 'ext:%'
           limit ${BUYER_CONSISTENCY_SAMPLE}`,
    ),
    db.execute<{ id: string; total: string }>(
      sql`select checkout_group_id as id, count(*) over () as total
            from (select checkout_group_id
                    from orders
                   where checkout_group_id is not null
                   group by checkout_group_id
                  having count(distinct buyer_origin) > 1) as mixed
           limit ${BUYER_CONSISTENCY_SAMPLE}`,
    ),
    db.execute<{ id: string; total: string }>(
      // `coalesce(…, '')` folds NULL into a comparable value so an unclaimed
      // order and a claimed sibling count as TWO distinct claimants — which is
      // exactly the partial claim being looked for. Without it Postgres would
      // ignore the NULL and report a half-claimed group as consistent.
      sql`select checkout_group_id as id, count(*) over () as total
            from (select checkout_group_id
                    from orders
                   where checkout_group_id is not null
                   group by checkout_group_id
                  having count(distinct coalesce(claimed_by_oxy_user_id, '')) > 1) as partial
           limit ${BUYER_CONSISTENCY_SAMPLE}`,
    ),
    db.execute<{ id: string; total: string }>(
      sql`select id, count(*) over () as total
            from guest_checkouts
           where not exists (select 1
                               from orders
                              where orders.buyer_guest_checkout_id = guest_checkouts.id)
           limit ${BUYER_CONSISTENCY_SAMPLE}`,
    ),
  ]);

  return {
    legacyExternalMisclassified: toFinding(misclassified),
    mixedOriginGroups: toFinding(mixedOrigin),
    partiallyClaimedGroups: toFinding(partialClaim),
    orphanedGuestCheckouts: toFinding(orphanedContacts),
  };
}

/**
 * One order by its idempotency key, or `null` — the durable convergence read
 * after a unique-violation on `orders_idempotency_key_key`.
 */
export async function findOrderByIdempotencyKey(
  idempotencyKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRecord | null> {
  const rows = await db
    .select(PUBLIC_ORDER_COLUMNS)
    .from(orders)
    .where(eq(orders.idempotencyKey, idempotencyKey))
    .limit(1);
  const [record] = await withChildren(rows, db);
  return record ?? null;
}

/**
 * Orders still `pending_payment` and older than `cutoff` — the expire-reservations
 * sweep, served by `orders_status_created_at_idx`.
 */
export async function findStalePendingOrders(
  cutoff: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRecord[]> {
  const rows = await db
    .select(PUBLIC_ORDER_COLUMNS)
    .from(orders)
    .where(and(eq(orders.status, 'pending_payment'), lt(orders.createdAt, cutoff)))
    .orderBy(asc(orders.createdAt), asc(orders.id));
  return withChildren(rows, db);
}

/**
 * One order of a connection, resolved by the external platform's own order id —
 * the connector's idempotent import lookup.
 */
export async function findOrderBySourceExternalId(
  storeId: string,
  connectionId: string,
  externalId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ id: string; status: OrderStatus } | null> {
  const [row] = await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(
      and(
        eq(orders.storeId, storeId),
        eq(orders.sourceConnectionId, connectionId),
        eq(orders.sourceExternalId, externalId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Whether this buyer has ANY order in one of `statuses` that carries the given
 * listing — the review service's verified-purchase check.
 *
 * A join rather than a correlated subquery: `order_items` is in the statement's
 * own FROM, so there is no bare-column hazard, and `order_items_listing_id_idx`
 * serves the line side directly.
 *
 * Claim-aware since #106 (ADR 0003 D7): a purchase claimed into an Oxy account
 * IS that account's purchase, so a claimant may review what they bought as a
 * guest. That is the read half; the WRITE half — minting a
 * `review_eligibilities` row for a claimed order — stays refused until #109
 * supplies a claim record to verify against (`review-eligibility.service.ts`).
 */
export async function buyerHasOrderForListing(
  buyerOxyUserId: string,
  listingId: string,
  statuses: readonly OrderStatus[],
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(
      and(
        buyerOrClaimantSql(buyerOxyUserId),
        eq(orderItems.listingId, listingId),
        inArray(orders.status, [...statuses]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Whether this buyer has ANY order in one of `statuses` from a given seller.
 *
 * Claim-aware for {@link buyerHasOrderForListing}'s reason.
 */
export async function buyerHasOrderFromSeller(
  buyerOxyUserId: string,
  seller: { storeId: string } | { sellerOxyUserId: string },
  statuses: readonly OrderStatus[],
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const sellerClause =
    'storeId' in seller
      ? and(eq(orders.sellerType, 'store'), eq(orders.storeId, seller.storeId))
      : and(eq(orders.sellerType, 'user'), eq(orders.sellerOxyUserId, seller.sellerOxyUserId));

  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        buyerOrClaimantSql(buyerOxyUserId),
        inArray(orders.status, [...statuses]),
        sellerClause,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The ids of every live, not-yet-held order carrying a listing — the set a
 * `freeze_transaction` decision takes hold of.
 *
 * `selectDistinct` because an order that bought the same listing on two lines
 * would otherwise be held (and later released) twice, and the id list is
 * persisted as the enforcement's `previousState` so the release puts back exactly
 * this set.
 */
export async function findFreezableOrderIdsForListing(
  listingId: string,
  statuses: readonly OrderStatus[],
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: orders.id })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orderItems.listingId, listingId),
        inArray(orders.status, [...statuses]),
        // `moderation_hold` is nullable and `<> true` is NULL for a NULL row, so
        // the null branch has to be spelled out — a bare `ne` would silently
        // exclude every order that has never been held, which is all of them.
        or(eq(orders.moderationHold, false), sql`${orders.moderationHold} is null`),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * Set or clear the moderation freeze on a set of orders.
 *
 * Cleared to NULL rather than `false`, matching the `$unset` this replaces: the
 * column's three states are "never held", "held" and "released", and only the
 * middle one refuses a transition.
 */
export async function setOrderModerationHold(
  orderIds: readonly string[],
  held: boolean,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (orderIds.length === 0) return 0;
  const rows = await db
    .update(orders)
    .set({ moderationHold: held ? true : null, updatedAt: new Date() })
    .where(inArray(orders.id, [...orderIds]))
    .returning({ id: orders.id });
  return rows.length;
}

/**
 * The next order number, `MRC-000123`.
 *
 * `nextval` rather than the contended `Counter` row it replaces: it takes no
 * transaction-scoped lock, so two concurrent checkouts never wait on each other,
 * and a number is never handed out twice. A rolled-back transaction does NOT
 * return its number — the same gaps the `$inc` already left in production, for
 * the same reason.
 *
 * The `MRC-` prefix and the padding stay in the application: they are the
 * printed format of a receipt, not a fact about the sequence.
 */
export async function nextOrderNumber(db: DatabaseOrTransaction = getDb()): Promise<string> {
  const rows = await db.execute<{ n: string }>(sql`select nextval('order_number_seq') as n`);
  const seq = Number(rows[0]?.n ?? 0);
  return `${ORDER_NUMBER_PREFIX}${String(seq).padStart(ORDER_NUMBER_PAD, '0')}`;
}

/**
 * Create an order and all of its child relations in ONE transaction.
 *
 * Atomic because a partially-written order is not a degraded record, it is a
 * charge with no lines: `order-hydration` would serve it with an empty `items`,
 * every report would count its revenue, and no refund could ever be computed
 * against it.
 *
 * @throws A unique-violation on `orders_idempotency_key_key` when a concurrent or
 *   replayed checkout already created this order. The caller converges on the
 *   prior group rather than treating it as a failure.
 */
export async function insertOrder(
  input: NewOrder,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderRecord> {
  const run = async (tx: DatabaseOrTransaction): Promise<OrderRecord> => {
    const [row] = await tx
      .insert(orders)
      .values({
        orderNumber: input.orderNumber,
        buyerOrigin: input.buyerOrigin,
        buyerOxyUserId: input.buyerOxyUserId ?? null,
        buyerGuestCheckoutId: input.buyerGuestCheckoutId ?? null,
        sellerType: input.sellerType,
        sellerOxyUserId: input.sellerOxyUserId ?? null,
        storeId: input.storeId ?? null,
        customerId: input.customerId ?? null,
        sourceChannel: input.sourceChannel ?? 'storefront',

        sourceConnectionId: input.source?.connectionId ?? null,
        sourceProvider: input.source?.provider ?? null,
        sourceExternalId: input.source?.externalId ?? null,
        sourceExternalUpdatedAt: input.source?.externalUpdatedAt ?? null,

        shippingAddressLabel: input.shippingAddress.label ?? null,
        shippingAddressRecipientName: input.shippingAddress.recipientName,
        shippingAddressLine1: input.shippingAddress.line1,
        shippingAddressLine2: input.shippingAddress.line2 ?? null,
        shippingAddressCity: input.shippingAddress.city,
        shippingAddressRegion: input.shippingAddress.region ?? null,
        shippingAddressPostalCode: input.shippingAddress.postalCode,
        shippingAddressCountry: input.shippingAddress.country,
        shippingAddressPhone: input.shippingAddress.phone ?? null,

        shippingMethod: input.shippingMethod,
        shippingLabel: input.shippingLabel,
        shippingCostShopAmount: input.shippingCost.shop.amount,
        shippingCostShopCurrency: input.shippingCost.shop.currency,
        shippingCostPresentmentAmount: input.shippingCost.presentment.amount,
        shippingCostPresentmentCurrency: input.shippingCost.presentment.currency,
        shippingTrackingNumber: null,

        totalsSubtotalShopAmount: input.totals.subtotal.shop.amount,
        totalsSubtotalShopCurrency: input.totals.subtotal.shop.currency,
        totalsSubtotalPresentmentAmount: input.totals.subtotal.presentment.amount,
        totalsSubtotalPresentmentCurrency: input.totals.subtotal.presentment.currency,
        totalsDiscountTotalShopAmount: input.totals.discountTotal.shop.amount,
        totalsDiscountTotalShopCurrency: input.totals.discountTotal.shop.currency,
        totalsDiscountTotalPresentmentAmount: input.totals.discountTotal.presentment.amount,
        totalsDiscountTotalPresentmentCurrency: input.totals.discountTotal.presentment.currency,
        totalsShippingShopAmount: input.totals.shipping.shop.amount,
        totalsShippingShopCurrency: input.totals.shipping.shop.currency,
        totalsShippingPresentmentAmount: input.totals.shipping.presentment.amount,
        totalsShippingPresentmentCurrency: input.totals.shipping.presentment.currency,
        totalsTaxShopAmount: input.totals.tax.shop.amount,
        totalsTaxShopCurrency: input.totals.tax.shop.currency,
        totalsTaxPresentmentAmount: input.totals.tax.presentment.amount,
        totalsTaxPresentmentCurrency: input.totals.tax.presentment.currency,
        totalsGrandTotalShopAmount: input.totals.grandTotal.shop.amount,
        totalsGrandTotalShopCurrency: input.totals.grandTotal.shop.currency,
        totalsGrandTotalPresentmentAmount: input.totals.grandTotal.presentment.amount,
        totalsGrandTotalPresentmentCurrency: input.totals.grandTotal.presentment.currency,

        // All five fx columns move together — `orders_fx_rate_complete_check`
        // refuses a partially-filled snapshot, which would be an unreproducible
        // conversion rather than a missing one. `provider` is part of that set:
        // a rate with no named source cannot be audited against the quote it
        // came from.
        fxRateFrom: input.fxRate?.from ?? null,
        fxRateTo: input.fxRate?.to ?? null,
        fxRateRate: input.fxRate?.rate ?? null,
        fxRateProvider: input.fxRate?.provider ?? null,
        fxRateAsOf: input.fxRate?.asOf ?? null,

        status: input.status,
        paymentStatus: input.paymentStatus,
        paymentProvider: input.paymentProvider ?? null,
        paymentPaidAt: input.paymentPaidAt ?? null,
        checkoutGroupId: input.checkoutGroupId,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning(PUBLIC_ORDER_COLUMNS);

    await insertOrderChildren(row.id, input, tx);
    const [record] = await withChildren([row], tx);
    return record;
  };

  // A caller already inside a transaction joins it; drizzle has no nested
  // `transaction` on a `Transaction` handle that would let us open a second one.
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/** Write an order's six child relations. Split out only to keep `insertOrder` readable. */
async function insertOrderChildren(
  orderId: string,
  input: NewOrder,
  tx: DatabaseOrTransaction,
): Promise<void> {
  let itemRows: { id: string }[] = [];
  if (input.items.length > 0) {
    itemRows = await tx
      .insert(orderItems)
      .values(
        input.items.map((item, position) => ({
          orderId,
          listingId: item.listingId,
          variantId: item.variantId,
          title: item.title,
          variantTitle: item.variantTitle,
          imageUrl: item.imageUrl ?? null,
          unitPriceShopAmount: item.unitPrice.shop.amount,
          unitPriceShopCurrency: item.unitPrice.shop.currency,
          unitPricePresentmentAmount: item.unitPrice.presentment.amount,
          unitPricePresentmentCurrency: item.unitPrice.presentment.currency,
          quantity: item.quantity,
          lineTotalShopAmount: item.lineTotal.shop.amount,
          lineTotalShopCurrency: item.lineTotal.shop.currency,
          lineTotalPresentmentAmount: item.lineTotal.presentment.amount,
          lineTotalPresentmentCurrency: item.lineTotal.presentment.currency,
          // All four discount columns are present or absent together —
          // `order_items_discount_total_complete_check`.
          discountTotalShopAmount: item.discountTotal?.shop.amount ?? null,
          discountTotalShopCurrency: item.discountTotal?.shop.currency ?? null,
          discountTotalPresentmentAmount: item.discountTotal?.presentment.amount ?? null,
          discountTotalPresentmentCurrency: item.discountTotal?.presentment.currency ?? null,
          locationId: item.locationId ?? null,
          // #90: the condition snapshot. Written ONCE, at insert; the
          // `mercaria_order_item_condition_immutable` trigger refuses every
          // subsequent UPDATE of these three columns, so there is no repository
          // path — and no future backfill — that can rewrite a placed order.
          conditionKey: item.conditionKey ?? null,
          conditionAssertion: item.conditionAssertion ?? null,
          conditionNotes: item.conditionNotes ?? null,
          position,
        })),
      )
      .returning({ id: orderItems.id });

    const optionValues = input.items.flatMap((item, index) =>
      item.optionValues.map((option, position) => ({
        orderItemId: itemRows[index].id,
        name: option.name,
        value: option.value,
        position,
      })),
    );
    if (optionValues.length > 0) {
      await tx.insert(orderItemOptionValues).values(optionValues);
    }
  }

  if (input.statusHistory.length > 0) {
    await tx.insert(orderStatusHistory).values(
      input.statusHistory.map((event) => ({
        orderId,
        status: event.status,
        at: event.at,
        actorKind: event.actorKind,
        byOxyUserId: event.byOxyUserId ?? null,
        actorGuestSessionId: event.actorGuestSessionId ?? null,
        note: event.note ?? null,
      })),
    );
  }

  if (input.appliedDiscounts.length > 0) {
    await tx.insert(orderAppliedDiscounts).values(
      input.appliedDiscounts.map((allocation, position) => ({
        orderId,
        discountId: allocation.discountId,
        code: allocation.code ?? null,
        title: allocation.title,
        valueType: allocation.valueType,
        amountAmount: allocation.amount.amount,
        amountCurrency: allocation.amount.currency,
        target: allocation.target,
        targetLineIndex: allocation.targetLineIndex ?? null,
        position,
      })),
    );
  }

  if (input.taxLines.length > 0) {
    await tx.insert(orderTaxLines).values(
      input.taxLines.map((line, position) => ({
        orderId,
        name: line.name,
        rateBps: line.rateBps,
        amountAmount: line.amount.amount,
        amountCurrency: line.amount.currency,
        position,
      })),
    );
  }

  // The immutable fee snapshot (#88) — in THIS transaction, deliberately: an
  // order that committed without its snapshot would silently price under the
  // zero-fee era, and a snapshot without its order is an unexplained commission
  // record. `db/fees/orderFeeSnapshotRepository.ts` is reads-only for the same
  // reason. The table's own CHECKs decide which fields must travel together;
  // nothing is defaulted here beyond spelling absence as NULL.
  if (input.feeSnapshot) {
    const snapshot = input.feeSnapshot;
    const [snapshotRow] = await tx
      .insert(orderFeeSnapshots)
      .values({
        orderId,
        commercialMode: snapshot.commercialMode,
        result: snapshot.result,
        scheduleKey: snapshot.scheduleKey ?? null,
        scheduleVersion: snapshot.scheduleVersion ?? null,
        basis: snapshot.basis ?? null,
        basisAmountAmount: snapshot.basisAmount?.amount ?? null,
        basisAmountCurrency: snapshot.basisAmount?.currency ?? null,
        percentageBps: snapshot.percentageBps ?? null,
        fixedFeeMinor: snapshot.fixedFeeMinor ?? null,
        clampApplied: snapshot.clampApplied ?? null,
        feeAmount: snapshot.fee?.amount ?? null,
        feeCurrency: snapshot.fee?.currency ?? null,
        roundingAdjustmentMinor: snapshot.roundingAdjustmentMinor ?? null,
        termsVersionAccepted: snapshot.termsVersionAccepted ?? null,
        scopeSellerType: snapshot.scopeSellerType ?? null,
        scopeCurrency: snapshot.scopeCurrency ?? null,
      })
      .returning({ id: orderFeeSnapshots.id });

    const allocations = snapshot.lineAllocationsMinor ?? [];
    if (allocations.length > 0) {
      if (allocations.length !== itemRows.length) {
        throw new Error(
          `Order ${orderId} carries ${String(allocations.length)} fee line allocations for ` +
            `${String(itemRows.length)} items; the two are aligned by index and must match.`,
        );
      }
      await tx.insert(orderFeeSnapshotLines).values(
        allocations.map((amountMinor, position) => ({
          snapshotId: snapshotRow.id,
          orderItemId: itemRows[position].id,
          amountMinor,
          position,
        })),
      );
    }
  }
}

/** What a successful status move produces: the new row and the event it appended. */
export interface OrderTransitionResult {
  readonly order: OrderRow;
  readonly event: OrderStatusEventRow;
}

/**
 * Move an order to `next` ONLY IF it is still at `expected`, appending the
 * lifecycle event in the same transaction.
 *
 * @returns The updated row and the appended event, or `null` when the guard
 *   refused — which means the order was concurrently transitioned, never
 *   "nothing to do". The caller runs the inventory side-effects exactly when this
 *   returns a result, which is what makes a buyer `cancel` racing the expiry
 *   sweep run them AT MOST ONCE.
 *
 * The EVENT comes back rather than being re-composed by the caller: it is the row
 * as inserted, ids and all, so a caller that hydrates the result serves the trail
 * the database actually holds instead of a plausible reconstruction of it.
 */
export async function transitionOrderStatus(
  orderId: string,
  expected: OrderStatus,
  next: OrderStatus,
  patch: OrderTransitionPatch,
  event: NewOrderStatusEvent,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderTransitionResult | null> {
  const run = async (tx: DatabaseOrTransaction): Promise<OrderTransitionResult | null> => {
    const [row] = await tx
      .update(orders)
      .set(transitionColumns(next, patch))
      .where(and(eq(orders.id, orderId), eq(orders.status, expected)))
      .returning(PUBLIC_ORDER_COLUMNS);
    if (!row) return null;
    return { order: row, event: await appendStatusEvent(orderId, event, tx) };
  };
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/**
 * Set an order's status UNCONDITIONALLY, appending the lifecycle event.
 *
 * The refund path's write, and the absence of a CAS is deliberate rather than an
 * oversight: `refund.service` is the sole authority for refund-driven restock and
 * has already computed the new status from the CUMULATIVE refunded total, so
 * there is no "from" status to guard against — a partial refund arriving while
 * the order is `paid` and one arriving while it is `partially_refunded` must both
 * land. Going through `transition` instead would run the inventory effects a
 * second time, on units the refund already restocked per line.
 */
export async function setOrderStatus(
  orderId: string,
  next: OrderStatus,
  patch: OrderTransitionPatch,
  event: NewOrderStatusEvent,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const run = async (tx: DatabaseOrTransaction): Promise<void> => {
    await tx
      .update(orders)
      .set(transitionColumns(next, patch))
      .where(eq(orders.id, orderId));
    await appendStatusEvent(orderId, event, tx);
  };
  if ('transaction' in db) await db.transaction(run);
  else await run(db);
}

/** The column patch a status move writes. Shared by the guarded and direct paths. */
function transitionColumns(
  next: OrderStatus,
  patch: OrderTransitionPatch,
): Partial<InferSelectModel<typeof orders>> {
  return {
    status: next,
    ...(patch.paymentStatus !== undefined ? { paymentStatus: patch.paymentStatus } : {}),
    ...(patch.paymentPaidAt !== undefined ? { paymentPaidAt: patch.paymentPaidAt } : {}),
    ...(patch.shippingTrackingNumber !== undefined
      ? { shippingTrackingNumber: patch.shippingTrackingNumber }
      : {}),
    updatedAt: new Date(),
  };
}

/** Append one row to the append-only lifecycle trail, returning it as stored. */
async function appendStatusEvent(
  orderId: string,
  event: NewOrderStatusEvent,
  tx: DatabaseOrTransaction,
): Promise<OrderStatusEventRow> {
  const [row] = await tx
    .insert(orderStatusHistory)
    .values({
      orderId,
      status: event.status,
      at: event.at,
      actorKind: event.actorKind,
      byOxyUserId: event.byOxyUserId ?? null,
      actorGuestSessionId: event.actorGuestSessionId ?? null,
      note: event.note ?? null,
    })
    // NAMED columns, not a bare `.returning()`: the protected
    // `actor_guest_session_id` must not travel back out on the row a caller
    // hydrates. `PUBLIC_STATUS_EVENT_COLUMNS` is the same withholding the read
    // path uses, so the appended event and a re-read of it are the same shape.
    .returning(PUBLIC_STATUS_EVENT_COLUMNS);
  return row;
}

/**
 * Refresh the mutable half of an externally-synced order — the connector's
 * re-import of an order it already holds.
 *
 * Only status, payment status and the provenance stamp move: the lines, totals
 * and address are the snapshot of what was sold and are never re-written.
 */
export async function updateOrderFromSource(
  orderId: string,
  patch: { status: OrderStatus; paymentStatus: PaymentInfo['status']; source: NewOrderSource },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(orders)
    .set({
      status: patch.status,
      paymentStatus: patch.paymentStatus,
      sourceConnectionId: patch.source.connectionId,
      sourceProvider: patch.source.provider,
      sourceExternalId: patch.source.externalId,
      sourceExternalUpdatedAt: patch.source.externalUpdatedAt ?? null,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, orderId));
}

/**
 * Stamp the payment pointer onto every order of a checkout group.
 *
 * Only the POINTER, the provider and (optionally) the provider's reference —
 * never `payment_status`, never an amount. `paymentStatus` is moved by
 * `order.service.transition`, which owns the inventory effects that go with it;
 * writing it here would produce an order marked paid whose stock was never
 * committed.
 */
export async function linkPaymentToCheckoutGroup(
  input: {
    checkoutGroupId: string;
    paymentId: string;
    provider: PaymentProviderId;
    reference?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .update(orders)
    .set({
      paymentId: input.paymentId,
      paymentProvider: input.provider,
      ...(input.reference ? { paymentReference: input.reference } : {}),
      updatedAt: new Date(),
    })
    .where(eq(orders.checkoutGroupId, input.checkoutGroupId))
    .returning({ id: orders.id });
  return rows.length;
}

/**
 * Stamp the payment pointer onto ONE order.
 *
 * The `external` case: an imported payment stands for exactly one order, and its
 * checkout group is a synthetic `ext:<provider>:<externalId>` that two connected
 * shops can legitimately collide on. Linking by group there would point one
 * shop's order at another shop's payment.
 */
export async function linkPaymentToOrderId(
  input: { orderId: string; paymentId: string; provider: PaymentProviderId },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(orders)
    .set({
      paymentId: input.paymentId,
      paymentProvider: input.provider,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, input.orderId))
    .returning({ id: orders.id });
  return rows.length === 1;
}

/** Whether an order carries connector provenance — gates the fulfillment push-back. */
export async function orderHasSource(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.id, orderId), isNotNull(orders.sourceExternalId)))
    .limit(1);
  return rows.length > 0;
}

/** Per-status order counts for one store — the dashboard tile, computed in SQL. */
export async function countOrdersByStatus(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<OrderStatus, number>> {
  const rows = await db
    .select({ status: orders.status, n: count() })
    .from(orders)
    .where(eq(orders.storeId, storeId))
    .groupBy(orders.status);
  return new Map(rows.map((row) => [row.status, row.n]));
}

/**
 * A store's PAID revenue, summed in SQL and filtered to ONE currency.
 *
 * The currency filter is a real predicate on a real column, which is exactly why
 * `CONVENTIONS.md` keeps the money flat rather than in `jsonb`: the Mongo version
 * loaded every paid order into the process and filtered the mixed-currency ones
 * out in JavaScript, so a store with a hundred thousand paid orders pulled all of
 * them back to produce one number.
 *
 * `count(*)` comes back with the sum because the average order value is derived
 * from the same filtered set, and computing it from a second query could divide
 * by a count that moved in between.
 */
export async function sumPaidRevenue(
  storeId: string,
  shopCurrency: CurrencyCode,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ revenue: number; paidOrderCount: number }> {
  const [row] = await db
    .select({
      revenue: sql<number>`coalesce(sum(${orders.totalsGrandTotalShopAmount}), 0)::bigint`,
      paidOrderCount: count(),
    })
    .from(orders)
    .where(
      and(
        eq(orders.storeId, storeId),
        eq(orders.paymentStatus, 'paid'),
        eq(orders.totalsGrandTotalShopCurrency, shopCurrency),
      ),
    );
  return { revenue: Number(row?.revenue ?? 0), paidOrderCount: row?.paidOrderCount ?? 0 };
}

/** PAID-order counts split by source channel — the report summary's breakdown. */
export async function countPaidOrdersBySourceChannel(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<OrderSourceChannel, number>> {
  const rows = await db
    .select({ channel: orders.sourceChannel, n: count() })
    .from(orders)
    .where(and(eq(orders.storeId, storeId), eq(orders.paymentStatus, 'paid')))
    .groupBy(orders.sourceChannel);
  return new Map(rows.map((row) => [row.channel, row.n]));
}

/** One bucket of the time-series sales report. */
export interface SalesBucket {
  bucket: Date;
  orders: number;
  revenue: number;
}

/**
 * PAID orders bucketed by `interval` over a window, ascending — the sales report.
 *
 * `date_trunc` is the port of Mongo's `$dateTrunc`, and the timeline anchor is the
 * same `coalesce(paid_at, created_at)`: an order imported from a platform that
 * reported no settlement time still lands in the bucket it was created in rather
 * than vanishing from the report.
 *
 * ## The window bounds are ISO strings with an explicit cast, not `Date` objects
 *
 * The timeline anchor is an EXPRESSION rather than a column, so drizzle has no
 * column type to encode the comparison's right-hand side with, and postgres.js is
 * handed a raw `Date` it refuses with `ERR_INVALID_ARG_TYPE` — a hard failure at
 * query time, on a report that type-checks perfectly. `toISOString()` plus
 * `::timestamptz` gives the parameter an unambiguous type and keeps it a bound
 * parameter rather than statement text. Caught by `commerce.realdb.test.ts`; the
 * mocked report tests could not have seen it.
 */
export async function sumPaidRevenueByBucket(
  storeId: string,
  shopCurrency: CurrencyCode,
  window: { from: Date; to: Date },
  interval: 'hour' | 'day' | 'week' | 'month',
  db: DatabaseOrTransaction = getDb(),
): Promise<SalesBucket[]> {
  // The unit is one of four literals from a closed union, so it is rendered as
  // SQL text rather than bound — `date_trunc`'s first argument may not be a
  // parameter in an index-usable position, and the union is what keeps it safe.
  const paidMoment = sql`coalesce(${orders.paymentPaidAt}, ${orders.createdAt})`;
  // `.mapWith` is what makes the `Date` in `sql<Date>` true rather than merely
  // asserted. drizzle maps a real column's driver value through that column's own
  // `mapFromDriverValue`; a raw `sql` EXPRESSION has no column to take one from,
  // so a `timestamptz` arrives as the driver's raw string — and the generic
  // parameter is a claim TypeScript accepts without checking. `SalesBucket.bucket`
  // then says `Date`, holds a string, and `report.service` throws
  // `bucket.toISOString is not a function` on the first store with a paid order.
  //
  // Borrowing `createdAt`'s decoder rather than writing `new Date(value)` keeps
  // one conversion for every `timestamptz` in this schema, so a change to the
  // column builder cannot leave this expression behind.
  //
  // This is CONVENTIONS.md's third naming trap in its read direction, which is
  // the dangerous one: the WRITE direction throws `ERR_INVALID_ARG_TYPE` at the
  // driver, while the read direction hands back a plausible value and fails
  // somewhere else entirely.
  const bucket = sql<Date>`date_trunc(${sql.raw(`'${interval}'`)}, ${paidMoment})`.mapWith(
    orders.createdAt,
  );

  const rows = await db
    .select({
      bucket,
      orders: count(),
      revenue: sql<number>`coalesce(sum(${orders.totalsGrandTotalShopAmount}), 0)::bigint`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.storeId, storeId),
        eq(orders.paymentStatus, 'paid'),
        eq(orders.totalsGrandTotalShopCurrency, shopCurrency),
        sql`${paidMoment} >= ${window.from.toISOString()}::timestamptz`,
        sql`${paidMoment} <= ${window.to.toISOString()}::timestamptz`,
      ),
    )
    .groupBy(bucket)
    .orderBy(sql`${bucket} asc`);

  return rows.map((row) => ({
    bucket: row.bucket,
    orders: row.orders,
    revenue: Number(row.revenue),
  }));
}

/** One row of the top-products report. */
export interface TopProductRow {
  listingId: string;
  title: string;
  unitsSold: number;
  revenue: number;
}

/**
 * The best-selling listings of a store over a window, ranked by units then revenue.
 *
 * A join to `order_items` replaces Mongo's `$unwind`, and the title comes from
 * `max(title)` rather than `$last`: a listing renamed between two sales has two
 * titles in the snapshot set, and `$last` returned whichever the storage engine
 * happened to emit last — an ordering Mongo never promised. `max` is at least
 * deterministic for the same input.
 */
export async function findTopProducts(
  storeId: string,
  shopCurrency: CurrencyCode,
  window: { from: Date; to: Date },
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<TopProductRow[]> {
  const paidMoment = sql`coalesce(${orders.paymentPaidAt}, ${orders.createdAt})`;
  const unitsSold = sql<number>`coalesce(sum(${orderItems.quantity}), 0)::bigint`;
  const revenue = sql<number>`coalesce(sum(${orderItems.lineTotalShopAmount}), 0)::bigint`;

  const rows = await db
    .select({
      listingId: orderItems.listingId,
      title: sql<string>`max(${orderItems.title})`,
      unitsSold,
      revenue,
    })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.storeId, storeId),
        eq(orders.paymentStatus, 'paid'),
        eq(orders.totalsGrandTotalShopCurrency, shopCurrency),
        // Same ISO-string-plus-cast binding as the bucketed report — see it for
        // why a raw `Date` against an EXPRESSION is refused by the driver.
        sql`${paidMoment} >= ${window.from.toISOString()}::timestamptz`,
        sql`${paidMoment} <= ${window.to.toISOString()}::timestamptz`,
      ),
    )
    .groupBy(orderItems.listingId)
    .orderBy(sql`${unitsSold} desc`, sql`${revenue} desc`, asc(orderItems.listingId))
    .limit(limit);

  return rows.map((row) => ({
    listingId: row.listingId,
    title: row.title,
    unitsSold: Number(row.unitsSold),
    revenue: Number(row.revenue),
  }));
}

