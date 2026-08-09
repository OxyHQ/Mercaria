/**
 * The supplier adapter capability CONTRACT (#122 "Adapter capability
 * contract"), and the boundary that makes an undeclared capability have no
 * representable success.
 *
 * #124 writes the provider-specific adapters. This file is what they implement,
 * and — more importantly — what every one of their answers is passed through
 * before anything is stored or read.
 *
 * ## The rule this file exists to hold
 *
 * "The orchestration must not emulate a reservation by naming a local record
 * `reserved` when the supplier has made no commitment" generalizes: an adapter
 * that did not declare `live_stock_lookup` cannot produce an `orderable`
 * availability, one that did not declare `price_guarantee` cannot produce a
 * `guaranteed` price, one that did not declare `delivery_estimate` cannot
 * produce a delivery window, and one that did not declare
 * `inventory_reservation` cannot produce a reservation. Every one of those is a
 * SUCCESS STATE, and every one of them is removed here.
 *
 * That is enforced in three independent places, which is what makes it
 * structural rather than diligent:
 *
 *  1. **The type.** {@link SupplierReservationOutcome}'s only `reserved` branch
 *     carries a non-optional provider id and expiry, so there is no shape a
 *     caller could fill in from nothing.
 *  2. **This boundary.** {@link applyDeclaredCapabilities} runs on EVERY
 *     answer, in the one place answers enter the system, and downgrades each
 *     claim the declared set does not cover — naming the
 *     {@link SupplierEmulatedCommitment} it prevented rather than dropping the
 *     field silently, because a seam that looks like a real answer is worse
 *     than a refusal.
 *  3. **The database.** `supplier_reservations.declared_capabilities` must
 *     CONTAIN `inventory_reservation` and its provider id and expiry are NOT
 *     NULL, so even a write that bypassed this function has no row to land in.
 *
 * ## A downgrade is a CONTRACT VIOLATION, not a tidy-up
 *
 * An adapter claiming something it did not declare is a bug in that adapter,
 * and the answer says so: the returned notes carry
 * `provider_contract_violation`, the quote's status becomes `invalid`, and it
 * reaches an operator. Quietly accepting the claim would make an adapter's
 * declaration decorative; quietly discarding it would make the bug invisible.
 */

import type {
  SupplierAdapterCapability,
  SupplierEmulatedCommitment,
  SupplierPreflightAnswer,
  SupplierPreflightDestination,
  SupplierReservationReleaseReason,
} from '@mercaria/shared-types';
import { SUPPLIER_EMULATED_COMMITMENT_LABELS } from '@mercaria/shared-types';

/** What an adapter is asked. Carries no actor, session or buyer identity. */
export interface SupplierAdapterQuoteInput {
  /** The supplier account's own id on the provider platform. */
  providerAccountId: string;
  /** The environment this account lives in — a test account never reaches live. */
  environment: 'test' | 'live';
  supplierSku: string;
  /** The provider's own catalogue/object id, when the offer recorded one. */
  supplierExternalId: string | null;
  quantity: number;
  destination: SupplierPreflightDestination;
  currency: string;
  /** A service the caller pinned, when one was requested. */
  requestedShippingServiceCode: string | null;
  /**
   * Whether to ask for a supplier-side hold. An adapter that did not declare
   * `inventory_reservation` must ignore it; the boundary below removes any
   * reservation it returns anyway.
   */
  requestReservation: boolean;
  /** The deadline. An adapter exceeding it is a `timeout`, which is `unknown`. */
  timeoutMs: number;
}

/** What an adapter is asked when a hold is handed back. */
export interface SupplierAdapterReleaseInput {
  providerAccountId: string;
  environment: 'test' | 'live';
  providerReservationId: string;
  reason: SupplierReservationReleaseReason;
  timeoutMs: number;
}

/**
 * One supplier platform's implementation.
 *
 * `capabilities` is a DECLARATION, and everything downstream treats it as the
 * upper bound on what this adapter's answers may claim. `releaseReservation`
 * is optional because an adapter that never reserves has nothing to release —
 * and an adapter that DOES declare `inventory_reservation` without it is
 * refused at registration, since a hold nobody can hand back is a leak with a
 * supplier's stock in it.
 */
export interface SupplierPreflightAdapter {
  /** The `supplier_accounts.provider` slug this adapter serves. */
  readonly provider: string;
  readonly capabilities: readonly SupplierAdapterCapability[];
  quote(input: SupplierAdapterQuoteInput): Promise<SupplierPreflightAnswer>;
  releaseReservation?(input: SupplierAdapterReleaseInput): Promise<void>;
}

/** One claim this boundary removed, and the emulation it would have been. */
export interface SupplierCapabilityDowngrade {
  capability: SupplierAdapterCapability;
  commitment: SupplierEmulatedCommitment;
  /** The refusal text, from the shared label table — never composed here. */
  explanation: string;
}

/** An answer with every undeclared claim removed, plus what was removed. */
export interface DeclaredCapabilityResult {
  answer: SupplierPreflightAnswer;
  downgrades: readonly SupplierCapabilityDowngrade[];
}

function downgrade(
  capability: SupplierAdapterCapability,
  commitment: SupplierEmulatedCommitment,
): SupplierCapabilityDowngrade {
  return {
    capability,
    commitment,
    explanation: SUPPLIER_EMULATED_COMMITMENT_LABELS[commitment],
  };
}

/**
 * Reduce an adapter's answer to what its DECLARED capabilities entitle it to
 * claim.
 *
 * Runs on every answer, before completeness is derived and before anything is
 * stored. Each removal is reported rather than applied silently, and the caller
 * turns a non-empty report into a `provider_contract_violation` — so an adapter
 * whose declaration and behaviour disagree becomes an operator's problem
 * instead of a quiet source of optimistic quotes.
 *
 * Note the direction every downgrade takes: `orderable` becomes `unknown` and
 * not `unavailable`, `guaranteed` becomes `advisory` and not absent, a window
 * becomes absent and not zero. Each lands on the value that BLOCKS rather than
 * the one that refuses, because the supplier may well have the stock — what is
 * missing is Mercaria's right to claim it does.
 */
export function applyDeclaredCapabilities(
  answer: SupplierPreflightAnswer,
  capabilities: readonly SupplierAdapterCapability[],
): DeclaredCapabilityResult {
  const declared = new Set(capabilities);
  const downgrades: SupplierCapabilityDowngrade[] = [];
  let next = answer;

  // A reservation nobody declared is THE emulation this domain exists to
  // prevent. It is removed first, and the removed shape has no id to leak.
  if (next.reservation.supported && !declared.has('inventory_reservation')) {
    downgrades.push(downgrade('inventory_reservation', 'emulated_reservation'));
    next = { ...next, reservation: { supported: false, reason: 'capability_not_declared' } };
  }

  // An `orderable` from an adapter that cannot look stock up is a catalogue
  // feed's opinion wearing a live answer — exactly what #122 acceptance 1
  // refuses as checkout authority.
  if (next.availability === 'orderable' && !declared.has('live_stock_lookup')) {
    downgrades.push(downgrade('live_stock_lookup', 'assumed_stock_on_timeout'));
    next = { ...next, availability: 'unknown', maxOrderableQuantity: null };
  }

  if (next.identity === 'confirmed' && !declared.has('live_product_lookup')) {
    downgrades.push(downgrade('live_product_lookup', 'assumed_stock_on_timeout'));
    next = { ...next, identity: 'unknown' };
  }

  if (!declared.has('destination_shipping_quote') && next.shipping.basis !== 'unknown') {
    downgrades.push(downgrade('destination_shipping_quote', 'assumed_zero_shipping'));
    next = {
      ...next,
      shipping: { basis: 'unknown', restrictions: next.destinationRestrictions },
      shippingOptions: [],
    };
  }

  if (next.priceGuarantee === 'guaranteed' && !declared.has('price_guarantee')) {
    downgrades.push(downgrade('price_guarantee', 'inferred_price_guarantee'));
    next = { ...next, priceGuarantee: 'advisory' };
  }
  if (next.stockGuarantee === 'guaranteed' && !declared.has('live_stock_lookup')) {
    downgrades.push(downgrade('live_stock_lookup', 'inferred_price_guarantee'));
    next = { ...next, stockGuarantee: 'advisory' };
  }

  if (!declared.has('delivery_estimate') && hasDeliveryWindow(next)) {
    downgrades.push(downgrade('delivery_estimate', 'synthetic_delivery_estimate'));
    next = {
      ...next,
      handlingDaysMin: null,
      handlingDaysMax: null,
      dispatchDaysMin: null,
      dispatchDaysMax: null,
      deliveryDaysMin: null,
      deliveryDaysMax: null,
    };
  }

  if (!declared.has('tax_duty_estimate') && (next.tax !== null || next.duty !== null)) {
    downgrades.push(downgrade('tax_duty_estimate', 'assumed_zero_tax'));
    next = { ...next, tax: null, duty: null, importResponsibility: null };
  }

  // An adapter that cannot report the supplier's own expiry gets Mercaria's
  // policy TTL instead, which the caller applies. Claiming the supplier stated
  // one it did not is the same class of invention as a delivery estimate.
  if (!declared.has('quote_expiry') && next.providerExpiresAt !== null) {
    downgrades.push(downgrade('quote_expiry', 'inferred_price_guarantee'));
    next = { ...next, providerExpiresAt: null };
  }

  return { answer: next, downgrades };
}

function hasDeliveryWindow(answer: SupplierPreflightAnswer): boolean {
  return (
    answer.handlingDaysMin !== null ||
    answer.handlingDaysMax !== null ||
    answer.dispatchDaysMin !== null ||
    answer.dispatchDaysMax !== null ||
    answer.deliveryDaysMin !== null ||
    answer.deliveryDaysMax !== null
  );
}

/**
 * The answer a call that never completed produces (#122 concurrency 7:
 * "timeout is `unknown`, not `in stock`").
 *
 * A single function, so the mapping exists in ONE place: a timeout, a transport
 * failure and an unparseable body all arrive here and all leave with
 * `availability: 'unknown'`, an unknown shipping basis, no costs and no
 * reservation. There is deliberately no parameter that could make it answer
 * anything else.
 */
export function unknownAnswer(): SupplierPreflightAnswer {
  return {
    identity: 'unknown',
    availability: 'unknown',
    maxOrderableQuantity: null,
    minimumOrderQuantity: null,
    packSize: null,
    unitCost: null,
    supplierFees: null,
    shipping: { basis: 'unknown', restrictions: [] },
    shippingOptions: [],
    handlingDaysMin: null,
    handlingDaysMax: null,
    dispatchDaysMin: null,
    dispatchDaysMax: null,
    deliveryDaysMin: null,
    deliveryDaysMax: null,
    tax: null,
    duty: null,
    importResponsibility: null,
    fulfilmentOriginCountry: null,
    destinationRestrictions: [],
    providerQuoteReference: null,
    providerExpiresAt: null,
    priceGuarantee: 'advisory',
    stockGuarantee: 'advisory',
    reservation: { supported: false, reason: 'not_requested' },
    reasonCodes: [],
    sourceRecordRef: null,
  };
}
