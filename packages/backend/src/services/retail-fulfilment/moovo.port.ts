/**
 * Every call Mercaria makes to Moovo, as ONE port that currently refuses.
 *
 * #126 depends on four issues that are OPEN and unbuilt — #156 (the canonical
 * Oxy service client for Moovo), #157 (the fulfilment aggregate and its read
 * projection), #158 (the durable idempotent event inbox) and #159 (quotes,
 * bookings, labels and return transport). This module is the exact contract
 * those four satisfy, published now, refusing unconditionally until one of them
 * registers an implementation.
 *
 * ## Why a fail-closed port and not a stub that works
 *
 * The house precedents are `services/guest-portal/transport.ts` (#108, an empty
 * transport registry — *"a `console.log` transport looks like a working feature
 * in every test and sends nothing in production"*) and
 * `services/supplier-preflight`'s `authorizeSupplierFulfilment` (#122, one
 * `return` that #124 replaced). Both are the same argument: a seam that answers
 * plausibly is indistinguishable from a working one until a customer is
 * affected, and the moment it is discovered is the moment somebody is waiting
 * for a parcel.
 *
 * The refusal is therefore uniform, named, and carries the ISSUE that owes the
 * implementation — so an operator trace reads *"#159 has not landed"* rather
 * than *"logistics failed"*. That is #48's `deferred: #NN` device applied to a
 * port instead of to a webhook handler.
 *
 * ## What is NOT here, and why the absence is the point
 *
 * There is no carrier method, no label method, no tracking-poll method and no
 * carrier-status method. #126 acceptance 2 forbids Mercaria containing a carrier
 * adapter, a tracking poller or a carrier-state mapping, and the way to make
 * that structural rather than aspirational is for the only outbound logistics
 * interface to have no operation a carrier could be reached through.
 * {@link MOOVO_LOGISTICS_OPERATIONS} is the closed set, and
 * `retail-logistics-isolation.test.ts` fails the build if this domain grows an
 * HTTP client of its own.
 *
 * Inbound events are deliberately NOT a method here. #158 owns the inbox, and
 * what #126 owns of it is the resolution step —
 * `findRetailFulfilmentIntentBySourceReference`, which takes a source reference
 * and can reach exactly one intent. Publishing an `applyEvent` method would
 * invite a caller to apply a projection Mercaria does not store.
 */

import type {
  MoovoLogisticsOperation,
  MoovoOperationResult,
  MoovoTransportProjection,
  MoovoTransportRequest,
} from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';

/**
 * What Moovo answers when a transport is created or registered.
 *
 * The id and nothing else. A create response carrying a label URL, a carrier
 * name or a tracking number would put all three into Mercaria's call graph, and
 * the first author to persist one would have built the carrier store this
 * design exists to avoid. Everything about the movement is read back through
 * {@link MoovoLogisticsPort.readTransportProjection}, whose type is a coarse
 * buyer-facing summary.
 */
export interface MoovoTransportHandle {
  transportRequestId: string;
  /** ISO-8601, from Moovo. When the transport came into existence. */
  registeredAt: string;
}

/**
 * The five operations #126 needs.
 *
 * Each returns a {@link MoovoOperationResult}, so an unavailable Moovo is a
 * VALUE the caller must handle rather than an exception it might not. That is
 * deliberate: three of the five are called from paths where an exception would
 * abort something already committed — a paid order's fulfilment, an authorized
 * return — and the correct behaviour is to leave the intent without a transport
 * and let an operator or a retry pick it up.
 */
export interface MoovoLogisticsPort {
  /**
   * Mode B: the supplier already booked its own carrier; register a
   * TRACKING-ONLY transport so the buyer timeline has one authority (#159
   * capability 5). Idempotent on `request.sourceReference`.
   */
  registerTrackingOnlyTransport(
    request: MoovoTransportRequest,
  ): Promise<MoovoOperationResult<MoovoTransportHandle>>;

  /**
   * Mode A: Moovo books the fleet or carrier and produces the label and pickup
   * (#159 §"Booking, label and pickup operations"). Idempotent on
   * `request.sourceReference`.
   */
  bookTransport(
    request: MoovoTransportRequest,
  ): Promise<MoovoOperationResult<MoovoTransportHandle>>;

  /**
   * Read Moovo's own current state for one transport (#157's projection).
   *
   * This is the ONE way Mercaria learns where a parcel is. It returns Moovo's
   * coarse projection, already normalized by the authority that owns carrier
   * normalization — Mercaria maps nothing.
   */
  readTransportProjection(
    transportRequestId: string,
  ): Promise<MoovoOperationResult<MoovoTransportProjection>>;

  /**
   * Ask Moovo to cancel or void a transport (#159 §"Cancellation").
   *
   * Whether the order is COMMERCIALLY cancellable is Mercaria's decision and is
   * taken before this is called; whether the physical booking can still be
   * stopped is Moovo's, and the two answers are kept apart — #159 cancellation
   * rule 3. A refusal here is therefore an operational exception, never a
   * reason to un-cancel the commercial decision.
   */
  cancelTransport(transportRequestId: string): Promise<MoovoOperationResult<void>>;

  /**
   * Arrange reverse transport for an authorized return (#159 §"Return
   * transport", #127).
   *
   * A SEPARATE source reference from the outbound one, which is why this takes
   * a whole request rather than a transport id: a return is its own movement
   * with its own origin and destination, and reusing the outbound reference
   * would make a return event indistinguishable from a late outbound one.
   */
  requestReturnTransport(
    request: MoovoTransportRequest,
  ): Promise<MoovoOperationResult<MoovoTransportHandle>>;
}

/**
 * Which issue owes each operation.
 *
 * A `Record` over the closed operation set, so adding an operation without
 * saying who owes it fails `tsc` here rather than producing a refusal that
 * names nobody.
 */
const OPERATION_OWED_BY: Record<MoovoLogisticsOperation, string> = {
  register_tracking_only_transport: '#159',
  book_transport: '#159',
  read_transport_projection: '#157',
  cancel_transport: '#159',
  request_return_transport: '#159',
};

/** The unavailable answer for one operation, naming the issue that owes it. */
function unavailable<T>(operation: MoovoLogisticsOperation): MoovoOperationResult<T> {
  return {
    outcome: 'unavailable',
    reason: 'client_not_registered',
    owedBy: OPERATION_OWED_BY[operation],
  };
}

/**
 * The shipped implementation: refuse everything, and say which issue is owed.
 *
 * `debug` rather than `warn`, matching `unconsumedProcurementOutcome`: with
 * `MERCARIA_RETAIL_ENABLED` off — the shipped default — no retail order exists
 * to arrange transport for, so a warning per call would train whoever reads the
 * logs to ignore the level that matters. When retail is on, the intents sitting
 * without a transport are visible in `retail_fulfilment_intents_awaiting_transport_idx`
 * and on the operator surface, which is where somebody would actually look.
 */
export const unregisteredMoovoLogisticsPort: MoovoLogisticsPort = {
  async registerTrackingOnlyTransport(request) {
    log.general.debug(
      { sourceReference: request.sourceReference, owedBy: OPERATION_OWED_BY.register_tracking_only_transport },
      '[RetailFulfilment] no Moovo port is registered; tracking-only registration refused',
    );
    return Promise.resolve(unavailable<MoovoTransportHandle>('register_tracking_only_transport'));
  },
  async bookTransport(request) {
    log.general.debug(
      { sourceReference: request.sourceReference, owedBy: OPERATION_OWED_BY.book_transport },
      '[RetailFulfilment] no Moovo port is registered; booking refused',
    );
    return Promise.resolve(unavailable<MoovoTransportHandle>('book_transport'));
  },
  async readTransportProjection(transportRequestId) {
    log.general.debug(
      { transportRequestId, owedBy: OPERATION_OWED_BY.read_transport_projection },
      '[RetailFulfilment] no Moovo port is registered; projection unreadable',
    );
    return Promise.resolve(unavailable<MoovoTransportProjection>('read_transport_projection'));
  },
  async cancelTransport(transportRequestId) {
    log.general.debug(
      { transportRequestId, owedBy: OPERATION_OWED_BY.cancel_transport },
      '[RetailFulfilment] no Moovo port is registered; cancellation refused',
    );
    return Promise.resolve(unavailable<void>('cancel_transport'));
  },
  async requestReturnTransport(request) {
    log.general.debug(
      { sourceReference: request.sourceReference, owedBy: OPERATION_OWED_BY.request_return_transport },
      '[RetailFulfilment] no Moovo port is registered; return transport refused',
    );
    return Promise.resolve(unavailable<MoovoTransportHandle>('request_return_transport'));
  },
};

let port: MoovoLogisticsPort = unregisteredMoovoLogisticsPort;

/**
 * Register the real client.
 *
 * Re-registering REPLACES, matching every other port in this codebase and for
 * their reason: startup ordering across lazily imported modules is not
 * something a port should have an opinion about.
 */
export function registerMoovoLogisticsPort(next: MoovoLogisticsPort): void {
  port = next;
}

/** Restore the refusing default. Exists for tests, which must not leak a port. */
export function resetMoovoLogisticsPort(): void {
  port = unregisteredMoovoLogisticsPort;
}

/** The port in force. */
export function moovoLogisticsPort(): MoovoLogisticsPort {
  return port;
}

/**
 * Whether a booking path exists at all — the input `chooseFulfilmentMode` takes
 * as `moovoBookingAvailable`.
 *
 * Identity comparison against the refusing default rather than a boolean flag
 * somebody sets, so it cannot report `true` while the default is still
 * installed. A registered port that happens to refuse every call is still
 * "available" by this measure, correctly: the refusal then carries a reason the
 * caller can act on, which is a different situation from having no client.
 */
export function isMoovoBookingAvailable(): boolean {
  return port !== unregisteredMoovoLogisticsPort;
}
