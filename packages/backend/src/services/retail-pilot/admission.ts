/**
 * WHETHER THE PILOT ADMITS THIS LINE (#125 "Pilot cohort", acceptance 7).
 *
 * PURE, and that is the point rather than a convenience: every bound #125 names
 * is checked here against values a caller already holds, so the whole of "is
 * this within the pilot" is one function a reader can check and one function a
 * test can drive over every boundary case without a database.
 *
 * ## The order of the checks is deliberate
 *
 * Cheapest and least disclosive first. The cohort's own existence, then the
 * market and currency, then the supplier, then the SKU, then the values, then
 * the audience, then the live stops, and funding LAST — because funding is the
 * one answer that depends on an observation whose age matters, and refusing on
 * a bound the buyer could actually act on (an order above the ceiling) is
 * better than refusing on Mercaria's cash position.
 *
 * It makes no difference to the BUYER, who sees one sentence naming none of the
 * thirteen reasons (#123's `retail_line_ineligible` decision, reused). It makes
 * a difference to the operator reading the log, and to the provider budget: an
 * admission that fails on the SKU allow-list has spent nothing.
 *
 * ## Unknown is never a soft yes, and there is no unbounded branch
 *
 * There is no `admitted` path that does not name a cohort version. A deployment
 * with no active cohort refuses every retail line — `no_active_cohort` — which
 * is the correct state for a deployment that has published no bounds, and is
 * why this domain does not need a kill switch of its own: an empty pilot IS the
 * off position. `MERCARIA_RETAIL_ENABLED` (#123) remains the flippable one.
 */

import type {
  RetailPilotAdmission,
  RetailPilotAudience,
  RetailPilotStopMetric,
  RetailPilotStopScope,
} from '@mercaria/shared-types';

/**
 * WHICH pilot. A code constant, never a variable.
 *
 * `RETAIL_ELIGIBILITY_POLICY_KEY`'s reasoning: a deployment able to point at a
 * different key could run under bounds nobody published, and the failure would
 * look like a working pilot rather than a misconfiguration.
 */
export const RETAIL_PILOT_COHORT_KEY = 'mercaria-retail-pilot';

/** One published cohort version's bounds, as the derivation reads them. */
export interface RetailPilotBounds {
  readonly cohortId: string;
  readonly version: number;
  readonly supplierId: string;
  readonly supplierAccountId: string;
  readonly marketCountry: string;
  readonly currency: string;
  readonly audience: RetailPilotAudience;
  readonly audiencePercentageBps: number | null;
  readonly maxItemTotalMinor: number;
  readonly maxOrderTotalMinor: number;
  readonly minOrderTotalMinor: number;
  readonly maxLineQuantity: number;
  readonly permittedShippingServiceCodes: readonly string[];
  readonly fundingFloorMinor: number;
  readonly fundingCurrency: string;
  readonly fundingObservationMaxAgeSeconds: number;
}

/** A stop that is live right now. */
export interface RetailPilotLiveStop {
  readonly metric: RetailPilotStopMetric;
  readonly scope: RetailPilotStopScope;
  /** Empty for a `pilot`-scoped stop, which covers everything. */
  readonly scopeRef: string;
}

/**
 * The most recent supplier-balance observation, or its absence.
 *
 * `null` means NOBODY HAS RECORDED ONE, which refuses — the
 * `SELLER_TRUST_RESTRICTED_TIERS` rule inverted, and deliberately: an absent
 * trust signal withholds nothing because restricting on absence turns an outage
 * into a delisting, whereas an absent BALANCE is Mercaria not knowing whether
 * it can pay, and charging a customer for goods it may not be able to buy is
 * the failure ADR 0004 D6's prefunded model exists to prevent.
 */
export interface RetailPilotFunding {
  readonly balanceMinor: number;
  readonly currency: string;
  readonly observedAt: Date;
}

/** One retail line, as checkout knows it. */
export interface RetailPilotRequest {
  readonly supplierId: string;
  readonly supplierAccountId: string;
  readonly supplierSku: string;
  readonly destinationCountry: string;
  readonly currency: string;
  readonly quantity: number;
  /** This line's own presentment total, in minor units. */
  readonly lineTotalMinor: number;
  /** The whole checkout's retail total, so an order ceiling means something. */
  readonly orderTotalMinor: number;
  readonly shippingServiceCode: string | null;
  /**
   * Which audience the buyer is in, decided by the caller.
   *
   * A VALUE rather than an actor, so this function cannot read an identity: the
   * pilot's cohort is a rollout bound and must never become a place where a
   * buyer's account, session or origin is inspected. #107's `guest-rollout.ts`
   * makes the same separation for the same reason.
   */
  readonly audience: RetailPilotAudience;
  readonly at: Date;
}

/** Everything the derivation reads, gathered by the service. */
export interface RetailPilotState {
  readonly bounds: RetailPilotBounds | null;
  readonly allowlistedSkus: ReadonlySet<string>;
  readonly liveStops: readonly RetailPilotLiveStop[];
  readonly funding: RetailPilotFunding | null;
}

/**
 * Whether a live stop covers this request.
 *
 * A `pilot`-scoped stop covers everything; the other three match their own
 * subject. The comparison is EXACT rather than a prefix test, for
 * `claim-scope.ts`' reason one domain over: a prefix would make a stop on
 * supplier `acme` also stop `acme-industries`, which is somebody else.
 */
function stopCovers(stop: RetailPilotLiveStop, request: RetailPilotRequest): boolean {
  switch (stop.scope) {
    case 'pilot':
      return true;
    case 'supplier':
      return stop.scopeRef === request.supplierId || stop.scopeRef === request.supplierAccountId;
    case 'market':
      return stop.scopeRef === request.destinationCountry;
    case 'sku':
      return stop.scopeRef === request.supplierSku;
  }
}

/**
 * The pilot's verdict on one retail line.
 *
 * Every refusal is a REASON, never a boolean, because the caller logs which
 * bound fired and a boolean would make an operator guess between thirteen.
 */
export function deriveRetailPilotAdmission(
  state: RetailPilotState,
  request: RetailPilotRequest,
): RetailPilotAdmission {
  const { bounds } = state;
  if (bounds === null) return { outcome: 'refused', reason: 'no_active_cohort' };

  if (bounds.marketCountry !== request.destinationCountry) {
    return { outcome: 'refused', reason: 'market_not_in_pilot' };
  }
  if (bounds.currency !== request.currency) {
    return { outcome: 'refused', reason: 'currency_not_in_pilot' };
  }
  // BOTH halves. The account is what a purchase order is placed against and the
  // supplier is what an agreement is signed with; a cohort naming one and a
  // request carrying the other is a route nobody approved.
  if (
    bounds.supplierId !== request.supplierId ||
    bounds.supplierAccountId !== request.supplierAccountId
  ) {
    return { outcome: 'refused', reason: 'supplier_not_in_pilot' };
  }
  if (!state.allowlistedSkus.has(request.supplierSku)) {
    return { outcome: 'refused', reason: 'sku_not_allowlisted' };
  }

  if (request.quantity > bounds.maxLineQuantity) {
    return { outcome: 'refused', reason: 'quantity_above_cohort_limit' };
  }
  if (request.lineTotalMinor > bounds.maxItemTotalMinor) {
    return { outcome: 'refused', reason: 'item_value_above_cohort_limit' };
  }
  if (request.orderTotalMinor > bounds.maxOrderTotalMinor) {
    return { outcome: 'refused', reason: 'order_value_above_cohort_limit' };
  }
  // The MINIMUM is an honesty bound rather than a margin device (#119 §10):
  // below it a parcel's carriage dwarfs the goods, and a total that is mostly
  // shipping is a price nobody would defend as cost recovery.
  if (request.orderTotalMinor < bounds.minOrderTotalMinor) {
    return { outcome: 'refused', reason: 'order_value_below_cohort_minimum' };
  }

  // An EMPTY permitted list means NONE, and an absent service is not a match —
  // an unnamed shipping service cannot be checked against a list, and admitting
  // it would make the bound optional for whoever forgot to pin one.
  if (
    request.shippingServiceCode === null ||
    !bounds.permittedShippingServiceCodes.includes(request.shippingServiceCode)
  ) {
    return { outcome: 'refused', reason: 'shipping_service_not_permitted' };
  }

  if (!audienceAdmits(bounds.audience, request.audience)) {
    return { outcome: 'refused', reason: 'audience_not_in_cohort' };
  }

  for (const stop of state.liveStops) {
    if (stopCovers(stop, request)) {
      return { outcome: 'refused', reason: 'stop_threshold_active' };
    }
  }

  // Funding LAST, and refusing on absence. #125 provider funding 3: "prevent a
  // customer payment from proceeding when supplier funding is unavailable
  // according to policy".
  const { funding } = state;
  if (funding === null) return { outcome: 'refused', reason: 'supplier_funding_unavailable' };
  if (funding.currency !== bounds.fundingCurrency) {
    // A balance in another currency is not a smaller balance, it is an
    // UNCOMPARABLE one. This domain does no FX (#122's rule, and the retail
    // engine's), so the honest answer is that funding is unavailable rather
    // than a conversion nobody recorded.
    return { outcome: 'refused', reason: 'supplier_funding_unavailable' };
  }
  const ageSeconds = (request.at.getTime() - funding.observedAt.getTime()) / 1_000;
  if (ageSeconds > bounds.fundingObservationMaxAgeSeconds) {
    return { outcome: 'refused', reason: 'supplier_funding_unavailable' };
  }
  // The floor is compared against the balance MINUS what this order will draw:
  // a balance exactly at the floor does not stay there once the order is
  // procured, and a check that ignored the draw would admit the order that
  // empties the wallet.
  if (funding.balanceMinor - request.orderTotalMinor < bounds.fundingFloorMinor) {
    return { outcome: 'refused', reason: 'supplier_funding_unavailable' };
  }

  return { outcome: 'admitted', cohortVersion: bounds.version };
}

/**
 * Whether a cohort's audience admits a buyer's.
 *
 * The ladder is ORDERED and this is where the order means something: a `public`
 * cohort admits everyone, an `invited` one admits staff and invitees, a `staff`
 * one admits only staff. `percentage` is deliberately NOT a rung anybody climbs
 * into — the caller decides bucket membership and passes `percentage` when the
 * buyer is inside it, because bucketing needs a stable unit key this function
 * must never see (#77's experiment rule: an allocation that reads an identity
 * here would make the pilot's cohort a place a person is identified).
 */
function audienceAdmits(cohort: RetailPilotAudience, buyer: RetailPilotAudience): boolean {
  const rank: Record<RetailPilotAudience, number> = {
    staff: 0,
    invited: 1,
    percentage: 2,
    public: 3,
  };
  if (cohort === 'percentage') return buyer === 'percentage' || rank[buyer] < rank.percentage;
  return rank[buyer] <= rank[cohort];
}
