/**
 * The supplier ORDER half of the adapter contract, and the boundary that makes
 * an undeclared claim have no representable success (#124 "SupplierAdapter
 * contract", "Unsupported capabilities return an explicit result and are never
 * simulated").
 *
 * ## ONE adapter, not two
 *
 * {@link SupplierOrderAdapter} EXTENDS #122's `SupplierPreflightAdapter`, so a
 * provider integration (#125) is one object with one `provider` slug, one
 * declared capability array and one registry entry. The alternative — a second
 * adapter interface with its own registry — gives two lists describing one
 * supplier, and the direction two such lists disagree in is always the
 * permissive one: an adapter that "supports cancellation" according to the list
 * nobody enforces.
 *
 * ## The write boundary is the SIGNATURE
 *
 * An adapter is handed no database, no transaction, no repository and no
 * service, and every method returns a provider-neutral value type that has no
 * Mercaria id to put one in — there is no `purchaseOrderId` field on a
 * {@link SupplierOrderSubmission} and no place for one. `supplier-order-isolation.test.ts`
 * scans the `adapters/` directory, so the wall holds for adapters nobody has
 * written yet (#62's arrangement, one domain over).
 *
 * ## Every optional method is a capability, and the two are checked together
 *
 * `registerSupplierAdapter` refuses an adapter that declares a capability it
 * has no method for, exactly as #122 refuses one that declares
 * `inventory_reservation` without `releaseReservation`. So the declaration
 * cannot be decorative — and the reverse, an adapter that IMPLEMENTS a method
 * without declaring it, is handled by the orchestration simply never calling
 * it: the declared set is the upper bound on what may happen, and a method
 * nobody may call is inert.
 *
 * ## A downgrade is a CONTRACT VIOLATION, not a tidy-up
 *
 * {@link applyDeclaredOrderCapabilities} removes every claim the declared set
 * does not cover and REPORTS each removal, naming the
 * `SupplierEmulatedCommitment` it prevented. The orchestration turns a
 * non-empty report into a `capability_not_declared` exception an operator sees.
 * Quietly accepting the claim would make the declaration decorative; quietly
 * discarding it would make the bug invisible.
 *
 * Note the direction every downgrade takes — the #122 rule, applied to orders:
 * a `partially_accepted` becomes `unknown` and not `accepted`, a `delivered`
 * becomes `unknown` and not `shipped`, a shipment list becomes EMPTY and not a
 * fabricated parcel. Each lands on the value that BLOCKS rather than the one
 * that commits, because the supplier may well have accepted the order — what is
 * missing is Mercaria's right to tell a customer it did.
 */

import type {
  SupplierAdapterCapability,
  SupplierCancellation,
  SupplierCredit,
  SupplierEmulatedCommitment,
  SupplierInvoice,
  SupplierOrderDraft,
  SupplierOrderNormalizedState,
  SupplierOrderState,
  SupplierOrderSubmission,
  SupplierReturn,
  SupplierShipment,
} from '@mercaria/shared-types';
import { SUPPLIER_EMULATED_COMMITMENT_LABELS } from '@mercaria/shared-types';
import type { SupplierPreflightAdapter } from '../supplier-preflight/adapter.js';

/** What every order-side call carries, whatever it is asking. */
export interface SupplierOrderCallContext {
  /** The supplier account's own id on the provider platform. */
  providerAccountId: string;
  /** A test account never reaches live — the adapter refuses a mismatch. */
  environment: 'test' | 'live';
  /**
   * The secret behind the account's credential REFERENCE, resolved per call.
   *
   * Passed in rather than read by the adapter, so an adapter holds no secret
   * between calls, cannot cache one across a rotation, and has nothing to log.
   * The chokepoint refuses the call outright when the approved secret system
   * has no value for the reference (`credential_not_valid`), which is what
   * makes a deployment with no secret reader place no supplier orders at all.
   */
  credential: string;
  /** The deadline. An adapter exceeding it must fail, never answer late. */
  timeoutMs: number;
}

/** Submit or dry-run one order. */
export interface SupplierOrderSubmitInput extends SupplierOrderCallContext {
  draft: SupplierOrderDraft;
  /**
   * Mercaria's idempotency key for this submission, when the provider takes
   * one. Byte-identical across every retry of the same purchase order, so a
   * provider that honours it returns the order it already made.
   */
  idempotencyKey: string;
}

/** Read one order back, by whichever handle the caller holds. */
export interface SupplierOrderReadInput extends SupplierOrderCallContext {
  externalOrderId: string;
}

/** Find one order by MERCARIA's reference — the ambiguity converger. */
export interface SupplierOrderLookupInput extends SupplierOrderCallContext {
  clientReference: string;
}

/** Ask the provider to cancel. */
export interface SupplierOrderCancelInput extends SupplierOrderCallContext {
  externalOrderId: string;
  /** Mercaria's reference, so a provider keyed on it can deduplicate the ask. */
  clientReference: string;
  /** Byte-identical across retries — one cancellation, however often asked. */
  idempotencyKey: string;
}

/** Create or inspect a supplier RMA. */
export interface SupplierReturnInput extends SupplierOrderCallContext {
  externalOrderId: string;
  /** Present when inspecting an existing RMA rather than creating one. */
  returnReference?: string;
  /** The lines being returned, by Mercaria's own purchase-order line ids. */
  lines?: readonly { clientLineReference: string; quantity: number }[];
  /** Mercaria's normalized reason. The provider's own vocabulary is theirs. */
  reason?: string;
}

/** Ask the provider what has changed — the polling path. */
export interface SupplierOrderPollInput extends SupplierOrderCallContext {
  /** Only orders whose state moved after this instant. */
  since: Date;
  /** Never ask for more than this — the provider's own page bound. */
  limit: number;
}

/** What a webhook verification is handed, and what it must answer. */
export interface SupplierWebhookInput {
  /** The RAW bytes, exactly as delivered. Never a re-serialization. */
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
  /** The shared secret or signing key, read from the approved secret store. */
  secret: string;
  /** The account the delivery claims to be for, once resolved from the path. */
  providerAccountId: string;
  environment: 'test' | 'live';
}

/**
 * A verified webhook, decomposed into what the framework stores.
 *
 * The refusal branch carries no parsed content AT ALL, which is what makes "do
 * not mark shipment or delivery from an unverified client callback" (#124
 * polling and webhooks 8) structural: there is nothing in the shape for the
 * ingress to store, so an unverified delivery cannot be persisted now and
 * applied later by a sweep that never re-checked.
 */
export type SupplierWebhookVerification =
  | {
      verified: true;
      /** How authenticity was established — recorded on the stored event. */
      verification: 'signature' | 'shared_secret' | 'mutual_tls';
      /** The provider's own event id. Required: a webhook without one cannot dedupe. */
      providerEventId: string;
      eventType: string;
      /** The order this event is about, when the provider names one. */
      externalOrderId: string | null;
      /** Mercaria's own reference, when the provider echoes it. */
      clientReference: string | null;
      state: SupplierOrderNormalizedState;
      providerState: string;
      /** The PROVIDER's clock for the observation. */
      observedAt: Date;
      /** The raw object, for the framework's ALLOW-LIST projection. Never stored whole. */
      payload: Record<string, unknown>;
      /** Parcels this delivery reported, when it reported any. */
      shipments: readonly SupplierShipment[];
    }
  | { verified: false; reason: string };

/**
 * One supplier platform's ORDER implementation, on top of its preflight one.
 *
 * Every method beyond `mapProviderState` is optional, and each pairs with a
 * declared capability that `registerSupplierAdapter` checks:
 *
 * | capability | method |
 * |---|---|
 * | `order_draft_submission` | `submitOrder` |
 * | `order_state_read` | `readOrder` |
 * | `order_reference_lookup` | `findOrderByClientReference` |
 * | `order_cancellation` | `cancelOrder` |
 * | `shipment_read` | `readShipments` |
 * | `invoice_retrieval` | `readInvoice` |
 * | `credit_note_retrieval` | `readCreditNotes` |
 * | `return_authorization` | `createReturn` and `readReturn` |
 * | `order_webhooks` | `verifyWebhook` |
 * | `order_polling` | `pollChanges` |
 *
 * `order_partial_acceptance` and `tracking_events` have no method of their own:
 * they license CONTENT other methods return (line outcomes, carrier scans), and
 * the capability boundary is where an undeclared one is removed.
 */
export interface SupplierOrderAdapter extends SupplierPreflightAdapter {
  /**
   * The version of this adapter's provider-state mapping.
   *
   * Every row read under it records the number, so a mapping corrected in a
   * later release is visible as a version difference between two orders instead
   * of silently reinterpreting the older one. It is a code CONSTANT the adapter
   * ships and deliberately not a table: the mapping is a procedure, and a table
   * would let somebody publish a version whose rules nobody shipped
   * (`CATALOG_BACKFILL_MAPPING_VERSION`'s reasoning, #60).
   */
  readonly stateMappingVersion: number;

  /**
   * The provider's own status string, mapped.
   *
   * An unrecognized value MUST answer `'unknown'` rather than a guess. The
   * orchestration then records an `unmapped_provider_state` exception and moves
   * nothing, which is how a provider adding a status is discovered rather than
   * silently mis-read as the nearest-looking one.
   */
  mapProviderState(providerState: string): SupplierOrderNormalizedState;

  validateDraft?(input: SupplierOrderSubmitInput): Promise<SupplierOrderSubmission>;
  submitOrder?(input: SupplierOrderSubmitInput): Promise<SupplierOrderSubmission>;
  readOrder?(input: SupplierOrderReadInput): Promise<SupplierOrderState>;
  /** `null` when the provider has no order under that reference — a real answer. */
  findOrderByClientReference?(input: SupplierOrderLookupInput): Promise<SupplierOrderState | null>;
  cancelOrder?(input: SupplierOrderCancelInput): Promise<SupplierCancellation>;
  readShipments?(input: SupplierOrderReadInput): Promise<readonly SupplierShipment[]>;
  /** `null` when the supplier has not issued one yet. */
  readInvoice?(input: SupplierOrderReadInput): Promise<SupplierInvoice | null>;
  readCreditNotes?(input: SupplierOrderReadInput): Promise<readonly SupplierCredit[]>;
  createReturn?(input: SupplierReturnInput): Promise<SupplierReturn>;
  readReturn?(input: SupplierReturnInput): Promise<SupplierReturn>;
  /** SYNCHRONOUS: verification is a signature check, never a network call. */
  verifyWebhook?(input: SupplierWebhookInput): SupplierWebhookVerification;
  pollChanges?(input: SupplierOrderPollInput): Promise<readonly SupplierOrderState[]>;
}

/** One claim this boundary removed, and the emulation it would have been. */
export interface SupplierOrderCapabilityDowngrade {
  capability: SupplierAdapterCapability;
  commitment: SupplierEmulatedCommitment;
  /** The refusal text, from the shared label table — never composed here. */
  explanation: string;
}

/** An answer with every undeclared claim removed, plus what was removed. */
export interface DeclaredOrderCapabilityResult<T> {
  answer: T;
  downgrades: readonly SupplierOrderCapabilityDowngrade[];
}

function downgrade(
  capability: SupplierAdapterCapability,
  commitment: SupplierEmulatedCommitment,
): SupplierOrderCapabilityDowngrade {
  return {
    capability,
    commitment,
    explanation: SUPPLIER_EMULATED_COMMITMENT_LABELS[commitment],
  };
}

/**
 * Reduce a submission or read answer to what the adapter's DECLARED
 * capabilities entitle it to claim.
 *
 * Runs on EVERY order answer, in the one place answers enter the system, before
 * anything is stored and before any state is applied.
 */
export function applyDeclaredOrderCapabilities<T extends SupplierOrderSubmission>(
  answer: T,
  capabilities: readonly SupplierAdapterCapability[],
): DeclaredOrderCapabilityResult<T> {
  const declared = new Set(capabilities);
  const downgrades: SupplierOrderCapabilityDowngrade[] = [];
  let next = answer;

  // A partial acceptance from an adapter that cannot report line-level
  // acceptance is a whole-order answer wearing a split. It lands on `unknown`
  // rather than `accepted`: the supplier may well have accepted everything, but
  // nothing here establishes which lines, and telling a customer that half
  // their order is coming is the emulation this entry exists to name.
  if (next.state === 'partially_accepted' && !declared.has('order_partial_acceptance')) {
    downgrades.push(downgrade('order_partial_acceptance', 'assumed_partial_acceptance'));
    next = { ...next, state: 'unknown' };
  }
  if (next.lineOutcomes.length > 0 && !declared.has('order_partial_acceptance')) {
    downgrades.push(downgrade('order_partial_acceptance', 'assumed_partial_acceptance'));
    next = { ...next, lineOutcomes: [] };
  }

  // A `delivered` from an adapter that cannot read an order back has no source
  // it could have come from. Delivery starts the return window and closes the
  // customer's fulfilment expectation, so an invented one is the costliest
  // thing on this list.
  if (
    (next.state === 'delivered' || next.state === 'partially_shipped' || next.state === 'shipped') &&
    !declared.has('order_state_read') &&
    !declared.has('shipment_read')
  ) {
    downgrades.push(
      downgrade('order_state_read', next.state === 'delivered' ? 'assumed_delivery' : 'synthetic_shipment'),
    );
    next = { ...next, state: 'unknown' };
  }

  // A dedupe claim Mercaria cannot independently confirm is not a dedupe. It is
  // what closes an ambiguity, and closing an ambiguity on an unverifiable claim
  // is how one customer order becomes two supplier orders.
  if (next.duplicateOfExistingOrder && !declared.has('order_reference_lookup')) {
    downgrades.push(downgrade('order_reference_lookup', 'emulated_provider_idempotency'));
    next = { ...next, duplicateOfExistingOrder: false };
  }

  return { answer: next, downgrades };
}

/**
 * The same boundary for a full order READ, which carries parcels and a
 * cancellability claim the submission shape does not.
 */
export function applyDeclaredOrderStateCapabilities(
  answer: SupplierOrderState,
  capabilities: readonly SupplierAdapterCapability[],
): DeclaredOrderCapabilityResult<SupplierOrderState> {
  const declared = new Set(capabilities);
  const base = applyDeclaredOrderCapabilities(answer, capabilities);
  const downgrades = [...base.downgrades];
  let next = base.answer;

  if (next.shipments.length > 0 && !declared.has('shipment_read')) {
    downgrades.push(downgrade('shipment_read', 'synthetic_shipment'));
    next = { ...next, shipments: [] };
  }
  if (!declared.has('tracking_events')) {
    const withScans = next.shipments.filter((shipment) => shipment.trackingEvents.length > 0);
    if (withScans.length > 0) {
      downgrades.push(downgrade('tracking_events', 'synthetic_shipment'));
      next = {
        ...next,
        shipments: next.shipments.map((shipment) => ({ ...shipment, trackingEvents: [] })),
      };
    }
  }
  // "This order can still be cancelled" is only meaningful from an adapter that
  // can act on it. Left `true`, it would put a cancel button in front of a
  // customer whose cancellation nothing could ever send.
  if (next.cancellable && !declared.has('order_cancellation')) {
    downgrades.push(downgrade('order_cancellation', 'assumed_cancellation_accepted'));
    next = { ...next, cancellable: false };
  }

  return { answer: next, downgrades };
}

/**
 * The same boundary for a cancellation answer.
 *
 * The one entry: an `accepted` cancellation carrying line-level evidence from
 * an adapter that cannot report it. A whole-order cancellation reported as a
 * partial one would leave half the order looking live forever.
 */
export function applyDeclaredCancellationCapabilities(
  answer: SupplierCancellation,
  capabilities: readonly SupplierAdapterCapability[],
): DeclaredOrderCapabilityResult<SupplierCancellation> {
  const declared = new Set(capabilities);
  if (answer.lineOutcomes.length === 0 || declared.has('order_partial_acceptance')) {
    return { answer, downgrades: [] };
  }
  return {
    answer: { ...answer, lineOutcomes: [] },
    downgrades: [downgrade('order_partial_acceptance', 'assumed_partial_acceptance')],
  };
}

/**
 * The answer a submission that never completed produces, and the ONE place the
 * mapping lives (#122's `unknownAnswer` for the order side).
 *
 * A timeout, a transport failure and an unparseable body all arrive here, and
 * all leave with `state: 'unknown'` and no external order id — which is what
 * makes the outcome AMBIGUOUS rather than failed. There is deliberately no
 * parameter that could make it answer anything else.
 */
export function unknownSubmission(
  stateMappingVersion: number,
  observedAt: Date = new Date(),
): SupplierOrderSubmission {
  return {
    externalOrderId: null,
    state: 'unknown',
    providerState: '',
    stateMappingVersion,
    observedAt: observedAt.toISOString(),
    reasonCode: null,
    providerMessage: null,
    total: null,
    lineOutcomes: [],
    duplicateOfExistingOrder: false,
  };
}
