/**
 * Who may file a retail service request, and who may decide one.
 *
 * ## The buyer half is #110's, unchanged
 *
 * `authorizeBuyerRequest` already composes #106's `authorizeOrderAccess`, mints
 * an actor nothing outside its own module can construct, and checks the portal
 * scope and the step-up freshness. After the credential is resolved there is
 * nothing retail-shaped about asking for a remedy, so this domain calls it and
 * writes no second copy — it adds only the four retail ACTIONS to that module's
 * table, which is where a scope-to-action mapping belongs.
 *
 * ## The decider half is NOT #110's, and the difference is real
 *
 * #110's `BUYER_REQUEST_DECISIONS` maps each decision to a STORE PERMISSION,
 * because a marketplace request is decided by the seller who made the sale. A
 * `mercaria_retail` order has no store — `orders.store_id` is NULL on a
 * `platform` order by CHECK (#123) — so there is no permission to require and no
 * store membership to check. Mercaria decides, and the authority that decides
 * Mercaria's own money is the payment-operator allow-list #50 already
 * established.
 *
 * So there is a second brand here rather than a `permission?: never` member on
 * #110's table. A table whose column is meaningless for half its rows is a table
 * whose next reader gets it wrong.
 *
 * ## No seventh allow-list
 *
 * Two EXISTING lists, split by what each may disclose:
 *
 *  - `PAYMENT_OPERATOR_OXY_USER_IDS` decides a customer remedy and releases a
 *    refund suspension. It moves Mercaria's money, which is exactly what that
 *    list already gates.
 *  - `PROCUREMENT_OPERATOR_OXY_USER_IDS` reads and drives the SUPPLIER half.
 *    That list exists for "reading what Mercaria PAYS its suppliers", and the
 *    side-by-side trace is the only surface that discloses a wholesale figure.
 *
 * Splitting them is what makes #127's *"side by side without conflating them"*
 * a property of the routers rather than of a projection somebody has to
 * remember to filter.
 */

import type { RetailServiceActorKind } from '@mercaria/shared-types';

/**
 * The brand. Module-private, so nothing outside this file can construct a
 * {@link RetailServiceDecider} — #110's device, and a `unique symbol` rather
 * than a string field because a string field is something a hand-written object
 * can also have.
 */
const DECIDES = Symbol('mercaria.retailServiceDecision');

/** What a Mercaria operator is doing to a request. */
export const RETAIL_SERVICE_DECISIONS = {
  /** Accept or reject a customer's request, and name the outcome. */
  'request:decide': { list: 'payment' },
  /** Drive the accepted outcome — the refund, the cancellation, the closure. */
  'request:complete': { list: 'payment' },
  /** Release a refund suspension while a card dispute is open. */
  'suspension:release': { list: 'payment' },
  /** Open, advance or close a supplier RMA. */
  'rma:drive': { list: 'procurement' },
  /** Open, advance or close a supplier recovery. */
  'recovery:drive': { list: 'procurement' },
  /** Record a quantity movement against a return case. */
  'return:report': { list: 'procurement' },
} as const satisfies Record<string, { list: 'payment' | 'procurement' }>;

/** One of {@link RETAIL_SERVICE_DECISIONS}. */
export type RetailServiceDecisionAction = keyof typeof RETAIL_SERVICE_DECISIONS;

/**
 * An authorized Mercaria decider. Unforgeable outside this module.
 *
 * Carries the id the ROUTER's allow-list already verified and the action it was
 * verified FOR. Deliberately no order id: a decider's scope is the request they
 * were let through for, which every service takes separately.
 */
export interface RetailServiceDecider {
  readonly [DECIDES]: true;
  readonly kind: Extract<RetailServiceActorKind, 'operator' | 'system'>;
  /** Absent only for a `system` decider, which no HTTP path can produce. */
  readonly oxyUserId?: string;
  readonly action: RetailServiceDecisionAction;
}

/**
 * A Mercaria operator who cleared one of the two allow-lists.
 *
 * Named for the gate it must have cleared, so a reviewer comparing the router
 * and the service sees the same word twice. The router is what enforces it,
 * because an allow-list membership test inside the request domain would be a
 * second copy of `requirePaymentOperator`.
 */
export function retailOperatorDecider(
  oxyUserId: string,
  action: RetailServiceDecisionAction,
): RetailServiceDecider {
  return { [DECIDES]: true, kind: 'operator', oxyUserId, action };
}

/**
 * Mercaria's own machinery acting without a person — a dispute event opening a
 * coordination, a supplier callback recording a receipt.
 *
 * Not reachable from any HTTP handler: every route mints an OPERATOR decider
 * from a verified id, so a `system` decider can only come from a handler this
 * domain owns. That is what stops "the system decided it" being an answer an
 * operator surface can produce.
 */
export function retailSystemDecider(action: RetailServiceDecisionAction): RetailServiceDecider {
  return { [DECIDES]: true, kind: 'system', action };
}

/** The audit columns a decider writes, in the shape the CHECKs accept. */
export function retailDeciderAudit(decider: RetailServiceDecider): {
  actorKind: RetailServiceActorKind;
  actorOxyUserId?: string;
} {
  return {
    actorKind: decider.kind,
    ...(decider.oxyUserId === undefined ? {} : { actorOxyUserId: decider.oxyUserId }),
  };
}
