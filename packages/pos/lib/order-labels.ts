import type { LocationType, OrderSourceChannel, OrderStatus } from "@mercaria/shared-types";

/**
 * Translation keys for the wire enums the till renders (#398).
 *
 * These three were the last English left in the POS after the extraction, and
 * they were invisible because they did not LOOK like English: the screens read
 * `order.status.replace("_", " ")` under a `capitalize` class, which turns
 * `partially_refunded` into "Partially refunded" for a reader of English and
 * leaves it exactly as it is for everyone else. A guard over string literals
 * cannot see that, which is why it is written down here rather than trusted to
 * a review.
 *
 * KEYS in a module-scope map, not sentences: this file is evaluated at import,
 * before the locale store has rehydrated. Each map is an exhaustive `Record`
 * over its `@mercaria/shared-types` union, so a status added there fails THIS
 * package's typecheck rather than rendering a blank line at a counter.
 */
export const ORDER_STATUS_LABEL_KEYS: Record<OrderStatus, string> = {
  pending_payment: "orders.status.pendingPayment",
  paid: "orders.status.paid",
  processing: "orders.status.processing",
  shipped: "orders.status.shipped",
  delivered: "orders.status.delivered",
  cancelled: "orders.status.cancelled",
  refunded: "orders.status.refunded",
  partially_refunded: "orders.status.partiallyRefunded",
};

export const ORDER_CHANNEL_LABEL_KEYS: Record<OrderSourceChannel, string> = {
  storefront: "orders.channel.storefront",
  pos: "orders.channel.pos",
  draft: "orders.channel.draft",
};

export const LOCATION_TYPE_LABEL_KEYS: Record<LocationType, string> = {
  warehouse: "locations.type.warehouse",
  retail: "locations.type.retail",
  pop_up: "locations.type.popUp",
  virtual: "locations.type.virtual",
};
