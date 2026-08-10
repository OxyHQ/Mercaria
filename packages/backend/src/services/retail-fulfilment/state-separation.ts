/**
 * The seven states #126 §"State separation" requires to stay distinct, derived
 * from seven different sources and never from each other.
 *
 * A pure function over facts the caller has already read. The whole value of
 * this module is negative — it is the place where somebody would otherwise
 * write *"the carrier says delivered, so the order is delivered"* — so the
 * shape is chosen to make each such move a visible edit rather than a natural
 * one:
 *
 *  - {@link RetailFulfilmentStateInputs} has one member per axis and no member
 *    that feeds two, so no derivation can read another axis's evidence.
 *  - Every axis is derived in its own function, each taking only its own input.
 *  - `RetailFulfilmentAxisState`'s `known: false` branch has NO `state`
 *    property, so an unknown axis cannot be rendered as a state at all.
 *
 * ## The six examples the issue names, and where each is held
 *
 *  1. *Supplier accepted does not mean shipped.* `supplier_procurement` reads
 *     `purchase_orders.status`; `transport_projection` reads Moovo. There is no
 *     input from which the first could produce the second.
 *  2. *Label created does not necessarily mean carrier pickup.*
 *     `MOOVO_TRANSPORT_PROJECTION_STATES` keeps `label_created` and
 *     `awaiting_collection` as separate members and this module maps a
 *     projection state to itself — there is no widening step in between.
 *  3. *Carrier delivered does not settle a buyer dispute automatically.*
 *     `refund_reconciliation` reads the order's refund state and nothing else.
 *  4. *Return delivered to supplier does not automatically complete a refund.*
 *     `return_transport` and `refund_reconciliation` are separate axes with
 *     separate inputs.
 *  5. *Unknown supplier or Moovo state remains unknown/stale.* An absent input
 *     produces `{ known: false }`, which has no state to display.
 *  6. *Return-to-sender is not ordinary cancellation.* `returned_to_sender` is
 *     a transport-projection state; `customer_order_payment` reads
 *     `orders.status`, which this module never writes and never infers.
 *
 * All six are tests (`state-separation.test.ts` for the pure cases,
 * `retail-fulfilment.realdb.test.ts` for the ones that need real rows).
 *
 * ## Staleness is derived against the reader's clock
 *
 * #126 rule 6 and §"State separation" example 5. A projection Moovo last
 * confirmed hours ago is reported `stale: true` without any sweep having run,
 * which is the #68 posture: the stored deadline is a pre-filter and the
 * derivation is the authority, so a projection that stopped being refreshed
 * degrades on its own rather than waiting to be marked.
 */

import type {
  MoovoTransportProjection,
  RetailFulfilmentAxisState,
  RetailFulfilmentStateView,
} from '@mercaria/shared-types';

/**
 * How old a Moovo observation may be before it is reported stale.
 *
 * Six hours, which is a display decision rather than a logistics one: the
 * question this answers is *"may Mercaria still show this to a buyer as
 * current"*, and the cost of getting it slightly wrong is a "last updated"
 * caption, not a wrong parcel. Moovo owns how often it refreshes; this owns how
 * long Mercaria repeats what it was told. A per-carrier or per-service value
 * would be Mercaria modelling carrier behaviour, which is exactly what #126
 * acceptance 2 keeps out.
 */
export const MOOVO_PROJECTION_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * The seven axes' evidence, one member each.
 *
 * Every optional member means "Mercaria does not currently know", and every one
 * of them produces `{ known: false }` — never a default state. Four are
 * optional today for structural reasons rather than incidental ones:
 * `transportProjection` and `returnTransportProjection` need #157/#158,
 * `returnAuthorization` needs #127, and a retail order with no fulfilment
 * intent yet genuinely has no preparation state.
 */
export interface RetailFulfilmentStateInputs {
  /** `orders.status` and `orders.payment_status`, as stored. */
  orderStatus: string;
  orderPaymentStatus: string;
  /** `purchase_orders.status` for this order's procurement, when one exists. */
  procurementStatus?: string;
  /** `retail_fulfilment_intents.status`, when a fulfilment intent exists. */
  preparationStatus?: string;
  /** Moovo's outbound projection, read through the port (#157). */
  transportProjection?: MoovoTransportProjection;
  /** #127's RMA state, when one exists. */
  returnAuthorizationStatus?: string;
  /** Moovo's reverse-transport projection (#157/#159). */
  returnTransportProjection?: MoovoTransportProjection;
  /** The order's refund state — `orders.status` reaching a refund vocabulary. */
  refundStatus?: string;
  /** The reader's clock, passed in so staleness is testable. */
  now: Date;
}

/** An axis Mercaria cannot answer, with the reason a surface may show. */
function unknownAxis(reason: string): RetailFulfilmentAxisState {
  return { known: false, reason };
}

/**
 * A Moovo projection, as one axis.
 *
 * The state is Moovo's own, copied verbatim. There is no mapping table here and
 * there must never be one: Moovo owns *versioned carrier status normalization*
 * (its ownership item 5), so a Mercaria translation of its output would be a
 * SECOND normalization of one physical event, and two normalizations disagree
 * in the direction nobody notices.
 */
function transportAxis(
  projection: MoovoTransportProjection | undefined,
  now: Date,
  absentReason: string,
): RetailFulfilmentAxisState {
  if (!projection) return unknownAxis(absentReason);
  const observed = Date.parse(projection.observedAt);
  if (Number.isNaN(observed)) {
    // An unparseable timestamp is not a fresher projection than one that is
    // late; it is a projection whose age is unknown, and the axis says so
    // rather than silently treating it as now.
    return unknownAxis('moovo_observation_time_unreadable');
  }
  return {
    known: true,
    state: projection.state,
    observedAt: projection.observedAt,
    stale: now.getTime() - observed > MOOVO_PROJECTION_STALE_AFTER_MS,
  };
}

/**
 * Derive all seven axes.
 *
 * The `observedAt` on the three Mercaria-owned axes is the reader's clock,
 * because those states are read live from rows that are always current — there
 * is no staleness to report about a value that was just selected. The three
 * Moovo axes carry Moovo's own observation time, which is the whole point of
 * separating them.
 */
export function deriveRetailFulfilmentStates(
  inputs: RetailFulfilmentStateInputs,
): RetailFulfilmentStateView {
  const nowIso = inputs.now.toISOString();
  const live = (state: string): RetailFulfilmentAxisState => ({
    known: true,
    state,
    observedAt: nowIso,
    stale: false,
  });

  return {
    // The commercial order and its payment. Read together because #126 lists
    // them as one axis, and because `orders` is the one row that carries both.
    customer_order_payment: live(`${inputs.orderStatus}/${inputs.orderPaymentStatus}`),

    supplier_procurement: inputs.procurementStatus
      ? live(inputs.procurementStatus)
      : unknownAxis('no_purchase_order'),

    preparation_fulfilment: inputs.preparationStatus
      ? live(inputs.preparationStatus)
      : unknownAxis('no_fulfilment_intent'),

    transport_projection: transportAxis(
      inputs.transportProjection,
      inputs.now,
      'moovo_projection_unavailable',
    ),

    return_authorization: inputs.returnAuthorizationStatus
      ? live(inputs.returnAuthorizationStatus)
      : unknownAxis('no_return_authorization'),

    return_transport: transportAxis(
      inputs.returnTransportProjection,
      inputs.now,
      'moovo_return_projection_unavailable',
    ),

    refund_reconciliation: inputs.refundStatus
      ? live(inputs.refundStatus)
      : unknownAxis('no_refund'),
  };
}
