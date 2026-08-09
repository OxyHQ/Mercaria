/**
 * Turning what a provider says into what Mercaria's machine does — the
 * VERSIONED mapping, its monotonic guard, and the regression it refuses to
 * apply (#124 state machine, "Never overwrite history when a provider regresses
 * or corrects a state").
 *
 * ## Two vocabularies, on purpose
 *
 * `SupplierOrderNormalizedState` is what a provider is capable of saying.
 * `PurchaseOrderStatus` is ADR 0004 D9.2's machine, which Mercaria owns and
 * which has a state no provider has (`cancel_requested`, the overlay between a
 * cancellation ask and the supplier's answer). Collapsing them would let a
 * provider drive Mercaria's machine directly, and the versioned mapping between
 * them is precisely what stops that.
 *
 * ## The issue's sixteen states, and where each one lives
 *
 * #124's state list is longer than the machine ADR 0004 D9.2 SELECTED, and the
 * difference is not an omission — it is #118's decision, restated here because
 * this is where somebody would be tempted to add a status column:
 *
 * | #124 state | representation |
 * |---|---|
 * | Draft | `status = 'draft'` |
 * | Ready for submission | `draft` plus an enqueued `purchase_order_submission` row |
 * | Submitting | an `in_flight` row in `supplier_order_attempts` |
 * | Submitted | `status = 'submitted'` |
 * | Accepted | `status = 'accepted'` |
 * | Partially accepted | `accepted` plus `purchase_order_line_outcomes` |
 * | Allocating / processing | `allocated_at` — a supplier fact that moves nothing |
 * | Partially shipped | `status = 'shipped'` plus per-line `shipped` outcomes |
 * | Shipped | `status = 'shipped'` |
 * | Delivered | `status = 'delivered'` |
 * | Cancellation requested | `status = 'cancel_requested'` |
 * | Cancelled | `status = 'cancelled'` |
 * | Return / RMA | #127's flows; this domain records the adapter contract only |
 * | Credited | `purchase_order_documents` of kind `credit_note` |
 * | Rejected | `status = 'rejected'` |
 * | Exception / manual review | `operator_intervention_required` + `procurement_exceptions` |
 *
 * Adding `submitting` or `partially_accepted` as STATUSES would give the
 * machine two ways to say one thing — a status and an outcome trail — and the
 * two can disagree. Every row above is one representation of one fact.
 *
 * ## Monotonicity is on the PROVIDER's clock, and regression is a report
 *
 * `isStaleObservation` compares `observed_at` against what has already been
 * applied, because two deliveries racing produce two RECEIPT times whose order
 * says nothing about the world. `isStateRegression` then asks the separate
 * question — is this newer observation a step BACKWARDS — and a `true` answer
 * is recorded as an exception rather than forced onto the machine, because a
 * provider that says `accepted` after `shipped` is either correcting itself or
 * confused and neither is something to guess at.
 */

import type {
  PurchaseOrderStatus,
  SupplierOrderNormalizedState,
} from '@mercaria/shared-types';
import {
  SUPPLIER_ORDER_STATE_RANK,
  SUPPLIER_ORDER_TERMINAL_STATES,
} from '@mercaria/shared-types';

/**
 * Which purchase-order status one normalized provider state implies.
 *
 * `null` for the states that imply NO status change:
 *
 *  - `unknown` — nothing was understood, so nothing moves.
 *  - `received` — the provider has the order and has not decided; that is
 *    `submitted`, which is where the order already is.
 *  - `processing` — allocation is a supplier fact recorded on `allocated_at`
 *    and deliberately not a status (ADR 0004 D9.2).
 *  - `partially_accepted` and `partially_shipped` — the WHOLE-order status is
 *    `accepted` and `shipped` respectively, and the partiality is the line
 *    outcome trail. Mapping them to a distinct status would be the second
 *    representation this domain exists without.
 *
 * `partially_accepted` maps to `accepted` and `partially_shipped` to `shipped`
 * for that reason: what the ORDER is doing is being fulfilled, and which lines
 * is a different question with a different answer.
 */
export const PURCHASE_ORDER_STATUS_BY_PROVIDER_STATE: Readonly<
  Record<SupplierOrderNormalizedState, PurchaseOrderStatus | null>
> = {
  unknown: null,
  received: null,
  accepted: 'accepted',
  partially_accepted: 'accepted',
  processing: null,
  partially_shipped: 'shipped',
  shipped: 'shipped',
  delivered: 'delivered',
  rejected: 'rejected',
  cancelled: 'cancelled',
};

/** Whether nothing further can arrive from the provider about this order. */
export function isTerminalProviderState(state: SupplierOrderNormalizedState): boolean {
  return SUPPLIER_ORDER_TERMINAL_STATES.includes(state);
}

/**
 * Whether an observation is older than what has already been applied.
 *
 * `<=` and not `<`: an observation bearing the SAME provider timestamp as the
 * one already applied carries no new information about ordering, and admitting
 * it would let a redelivery re-run every consequence of a state change. The
 * dedupe key catches an identical redelivery; this catches one whose payload
 * differs cosmetically (a re-serialisation, a field the provider added) but
 * whose instant does not.
 */
export function isStaleObservation(input: {
  appliedObservedAt: Date | null;
  observedAt: Date;
}): boolean {
  if (input.appliedObservedAt === null) return false;
  return input.observedAt.getTime() <= input.appliedObservedAt.getTime();
}

/**
 * Whether a NEWER observation moves the fulfilment backwards.
 *
 * Rank, not time — the two answer different questions and both are needed. A
 * provider whose latest word is `accepted` on an order it already said was
 * `shipped` is not stale (its clock moved forward) and is not applicable
 * either. The caller records `provider_state_regression` and leaves the machine
 * where it is.
 */
export function isStateRegression(input: {
  appliedState: SupplierOrderNormalizedState | null;
  observedState: SupplierOrderNormalizedState;
}): boolean {
  if (input.appliedState === null) return false;
  if (input.observedState === 'unknown') return false;
  return SUPPLIER_ORDER_STATE_RANK[input.observedState] < SUPPLIER_ORDER_STATE_RANK[input.appliedState];
}

/**
 * What applying one observation to one purchase order should DO.
 *
 * A pure decision over facts the caller already holds, so the rule can be
 * exercised without a database and cannot differ between the webhook path, the
 * poll path and the convergence path — three call sites that would otherwise
 * each grow their own version of it.
 */
export type ProviderObservationDecision =
  | { action: 'apply'; nextStatus: PurchaseOrderStatus }
  | { action: 'advance_only' }
  | { action: 'ignore_stale' }
  | { action: 'raise_regression' }
  | { action: 'raise_unmapped' }
  | { action: 'raise_illegal_transition'; nextStatus: PurchaseOrderStatus };

/** What the caller knows about the purchase order and the observation. */
export interface ProviderObservationInput {
  currentStatus: PurchaseOrderStatus;
  appliedState: SupplierOrderNormalizedState | null;
  appliedObservedAt: Date | null;
  observedState: SupplierOrderNormalizedState;
  observedAt: Date;
  /** ADR 0004 D9.2's legal edges, passed in so this module owns no map of its own. */
  legalNextStatuses: readonly PurchaseOrderStatus[];
}

/**
 * Decide what one provider observation does — the ONE place the answer lives.
 *
 * The ORDER of the checks is load-bearing, and each position is a decision:
 *
 *  1. **Staleness first.** A stale observation is not a regression: it is an
 *     old delivery arriving late, which an at-least-once webhook stream does
 *     routinely. Reporting it as a regression would fill the operator queue
 *     with ordinary behaviour.
 *  2. **`unknown` before anything about status**, because an unmapped state has
 *     no status to compare or check legality against.
 *  3. **A TERMINAL order receiving any further state change, before the rank
 *     check.** This is the position that matters most. A shipment arriving on
 *     a cancelled order outranks nothing — by rank it looks like an ordinary
 *     backwards step — but it is the dangerous case #124 cancellation 5 names,
 *     and it has to reach the caller as an illegal transition so it can be
 *     classified as `shipment_after_cancellation` rather than buried in the
 *     generic regression bucket.
 *  4. **The rank regression**, which is now unambiguously about a LIVE order
 *     whose provider corrected itself or is confused.
 */
export function decideProviderObservation(
  input: ProviderObservationInput,
): ProviderObservationDecision {
  if (isStaleObservation(input)) return { action: 'ignore_stale' };
  if (input.observedState === 'unknown') return { action: 'raise_unmapped' };

  const nextStatus = PURCHASE_ORDER_STATUS_BY_PROVIDER_STATE[input.observedState];
  // A state that implies no status change still moves the clock forward: the
  // provider has spoken more recently than the last thing we applied, and a
  // later redelivery of an OLDER observation must not re-open what this one
  // closed. Without this branch the guard would only advance on transitions.
  if (nextStatus === null) return { action: 'advance_only' };
  if (nextStatus === input.currentStatus) return { action: 'advance_only' };

  // Check 3. A terminal order has NO legal next status at all, so this is
  // exactly "something arrived after the end".
  if (input.legalNextStatuses.length === 0) {
    return { action: 'raise_illegal_transition', nextStatus };
  }
  if (isStateRegression(input)) return { action: 'raise_regression' };
  if (!input.legalNextStatuses.includes(nextStatus)) {
    return { action: 'raise_illegal_transition', nextStatus };
  }
  return { action: 'apply', nextStatus };
}
