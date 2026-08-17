import type { OrderStatus } from "@mercaria/shared-types";

/**
 * Friendly label per order status, as translation KEYS (#560).
 *
 * ONE authority for the whole storefront. It was declared twice — the orders
 * list and the order detail each carried a private copy — and #560 added two
 * more callers (the guest claim screen and the guest portal), which is the
 * point at which four copies of one mapping stop being a duplication and start
 * being four things that can disagree. A status renamed in
 * `@mercaria/shared-types` fails `tsc` in one place now rather than in however
 * many copies somebody remembered to grep for.
 *
 * A `Record<OrderStatus, string>` rather than a lookup with a fallback: a
 * fallback would silently render the wire identifier again, which is exactly
 * the defect #560 exists to remove. A member added to `OrderStatus` fails the
 * build here.
 *
 * KEYS, and frozen on the NEXT line rather than `Object.freeze({ … })`: the
 * i18n guard's key reader matches a `const X = { … }` initializer, and a call
 * expression is not one, so freezing inline would hide these eight from its
 * referential check. A module-scope `const` is also evaluated at import, before
 * the locale store has rehydrated, so a sentence here would freeze whichever
 * language loaded first — the keys are resolved with `t(...)` at the render
 * site.
 */
export const ORDER_STATUS_LABEL_KEYS: Readonly<Record<OrderStatus, string>> = {
  pending_payment: "orders.status.pendingPayment",
  paid: "orders.status.paid",
  processing: "orders.status.processing",
  shipped: "orders.status.shipped",
  delivered: "orders.status.delivered",
  cancelled: "orders.status.cancelled",
  refunded: "orders.status.refunded",
  partially_refunded: "orders.status.partiallyRefunded",
};
Object.freeze(ORDER_STATUS_LABEL_KEYS);
