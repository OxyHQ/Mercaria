/**
 * Offer and candidate fixtures for the #74 scenario tables.
 *
 * A builder rather than nine hand-written literals, because the thing under test
 * is almost always ONE fact differing between two offers — a price, an unknown
 * shipping cost, a rating below the floor — and a table of full literals makes
 * the difference invisible at exactly the point a reader is checking it.
 *
 * Every default is deliberately the BLAND case: priced, in stock, known
 * delivery, current freshness, no relationship, no rating. A test that wants an
 * unknown states it, so an unknown in a fixture is always a decision somebody
 * made rather than a field they forgot.
 */

import {
  OFFER_ELIGIBILITY_RULES,
  type CurrencyCode,
  type EligibleOffer,
  type ItemConditionKey,
  type Offer,
  type OfferAvailability,
  type OfferComparisonPrice,
  type OfferCustomerEligibility,
  type OfferFreshnessAssessment,
  type OfferKind,
  type OfferRankingFacts,
  type OfferRelationshipStanding,
  type OfferStatus,
} from '@mercaria/shared-types';
import { CONDITION_KEY_GROUP } from '@mercaria/shared-types';

/** A `current` source-backed freshness verdict with a bounded deadline. */
export function freshAssessment(elapsedSeconds = 60, lifetimeSeconds = 3_600): OfferFreshnessAssessment {
  const lastSeen = new Date(Date.UTC(2026, 7, 10, 12, 0, 0) - elapsedSeconds * 1_000);
  return {
    level: 'current',
    basis: 'source_policy',
    observedAt: lastSeen.toISOString(),
    firstSeenAt: lastSeen.toISOString(),
    lastSeenAt: lastSeen.toISOString(),
    ageSeconds: elapsedSeconds,
    checkedAgeSeconds: elapsedSeconds,
    expiry: {
      bounded: true,
      warnsAt: new Date(lastSeen.getTime() + (lifetimeSeconds * 2_000) / 3).toISOString(),
      expiresAt: new Date(lastSeen.getTime() + lifetimeSeconds * 1_000).toISOString(),
    },
  };
}

/** An `expired` verdict — the one that must leave a comparison (#68). */
export function expiredAssessment(): OfferFreshnessAssessment {
  const seen = new Date(Date.UTC(2026, 7, 10, 10, 0, 0));
  return {
    level: 'expired',
    basis: 'source_policy',
    observedAt: seen.toISOString(),
    firstSeenAt: seen.toISOString(),
    lastSeenAt: seen.toISOString(),
    ageSeconds: 7_200,
    checkedAgeSeconds: 7_200,
    expiredAt: new Date(Date.UTC(2026, 7, 10, 11, 0, 0)).toISOString(),
    reason: 'policy_lifetime_elapsed',
  };
}

export interface OfferOverrides {
  readonly id?: string;
  readonly kind?: OfferKind;
  readonly status?: OfferStatus;
  readonly canonicalVariantId?: string;
  readonly merchantId?: string;
  readonly storefrontId?: string;
  readonly priceMinor?: number | null;
  readonly priceCurrency?: string;
  readonly deliveryMinor?: number | null;
  readonly deliveryCurrency?: string;
  readonly deliveryMaxDays?: number;
  readonly availability?: OfferAvailability;
  readonly condition?: ItemConditionKey | 'unknown';
  readonly country?: string;
  readonly customerEligibility?: OfferCustomerEligibility;
  readonly destinationUrl?: string | null;
  readonly affiliateNetwork?: string;
  readonly returnWindowDays?: number;
  readonly mayDisplay?: boolean;
  readonly sourceRecordId?: string;
  readonly freshness?: OfferFreshnessAssessment;
  readonly checkoutEligible?: boolean;
}

/** One offer, bland by default. */
export function buildOffer(overrides: OfferOverrides = {}): Offer {
  const kind = overrides.kind ?? 'external';
  const conditionKey = overrides.condition ?? 'new';
  const group = conditionKey === 'unknown' ? undefined : CONDITION_KEY_GROUP[conditionKey];
  const priceMinor = overrides.priceMinor === undefined ? 10_000 : overrides.priceMinor;
  const deliveryMinor = overrides.deliveryMinor === undefined ? 500 : overrides.deliveryMinor;

  return {
    id: overrides.id ?? 'offer-1',
    kind,
    status: overrides.status ?? 'active',
    canonicalVariantId: overrides.canonicalVariantId ?? 'variant-1',
    ...(overrides.merchantId === undefined ? {} : { merchantId: overrides.merchantId }),
    ...(overrides.storefrontId === undefined ? {} : { storefrontId: overrides.storefrontId }),
    sellerRole: 'unknown',
    ...(priceMinor === null
      ? {}
      : { price: { amount: priceMinor, currency: overrides.priceCurrency ?? 'EUR' } }),
    availability: overrides.availability ?? 'in_stock',
    condition: {
      key: conditionKey,
      ...(group ? { group } : {}),
      mappingState: 'declared',
    },
    ...(overrides.destinationUrl === null
      ? {}
      : { destinationUrl: overrides.destinationUrl ?? 'https://retailer.example/p/1' }),
    ...(overrides.affiliateNetwork === undefined
      ? {}
      : { affiliate: { network: overrides.affiliateNetwork } }),
    ...(overrides.country === undefined ? {} : { country: overrides.country }),
    customerEligibility: overrides.customerEligibility ?? 'unknown',
    delivery:
      deliveryMinor === null
        ? { known: false, pickup: 'unknown' }
        : {
            known: true,
            cost: { amount: deliveryMinor, currency: overrides.deliveryCurrency ?? 'EUR' },
            ...(overrides.deliveryMaxDays === undefined
              ? {}
              : { maxDays: overrides.deliveryMaxDays }),
            pickup: 'unknown',
          },
    ...(overrides.returnWindowDays === undefined
      ? {}
      : { returnPolicy: { windowDays: overrides.returnWindowDays } }),
    provenance: {
      ...(overrides.sourceRecordId === undefined
        ? { sourceRecordId: 'record-1' }
        : { sourceRecordId: overrides.sourceRecordId }),
      ...(overrides.mayDisplay === undefined ? {} : { mayDisplay: overrides.mayDisplay }),
    },
    freshness: overrides.freshness ?? freshAssessment(),
    qualitySignals: [],
    checkout:
      overrides.checkoutEligible === true
        ? { eligible: true, listingId: 'listing-1', productVariantId: 'pv-1' }
        : { eligible: false, reasons: kind === 'native' ? ['out_of_stock'] : ['not_native'] },
  };
}

/** A known comparison price in the comparison currency, with an identity quote. */
export function knownPrice(minor: number, currency: CurrencyCode = 'EUR'): OfferComparisonPrice {
  return {
    known: true,
    amount: { amount: minor, currency },
    fx: {
      from: currency,
      to: currency,
      rate: 1,
      provider: 'identity',
      asOf: '2026-08-10T12:00:00.000Z',
    },
  };
}

/** An unknown comparison price. Carries no amount, which is the whole point. */
export function unknownPrice(reason: 'not_published' | 'not_convertible' = 'not_published'): OfferComparisonPrice {
  return { known: false, reason };
}

export interface FactOverrides {
  readonly itemPriceMinor?: number | null;
  readonly deliveryMinor?: number | null;
  readonly deliveryMaxDays?: number;
  readonly condition?: ItemConditionKey;
  readonly merchantRating?: number;
  readonly merchantReviewCount?: number;
  readonly returnWindowDays?: number;
  readonly availability?: OfferAvailability;
  readonly freshnessElapsedFraction?: number;
  readonly relationship?: OfferRelationshipStanding;
  readonly pickupDistanceMetres?: number;
  readonly nativeCheckoutEligible?: boolean;
}

/** One candidate's facts, bland by default and fully admitted. */
export function buildFacts(overrides: FactOverrides = {}): OfferRankingFacts {
  const itemPrice =
    overrides.itemPriceMinor === null
      ? unknownPrice()
      : knownPrice(overrides.itemPriceMinor ?? 10_000);
  const deliveryCost =
    overrides.deliveryMinor === null ? unknownPrice() : knownPrice(overrides.deliveryMinor ?? 500);
  const group = overrides.condition === undefined ? undefined : CONDITION_KEY_GROUP[overrides.condition];

  return {
    itemPrice,
    deliveryCost,
    total:
      itemPrice.known && deliveryCost.known
        ? { known: true, amount: { amount: itemPrice.amount.amount + deliveryCost.amount.amount, currency: itemPrice.amount.currency } }
        : {
            known: false,
            missing: [
              ...(itemPrice.known ? [] : (['item_price'] as const)),
              ...(deliveryCost.known ? [] : (['delivery_cost'] as const)),
            ],
          },
    taxInclusion: 'unknown',
    ...(overrides.deliveryMaxDays === undefined ? {} : { deliveryMaxDays: overrides.deliveryMaxDays }),
    ...(overrides.condition === undefined ? {} : { condition: overrides.condition }),
    ...(group === undefined ? {} : { conditionGroup: group }),
    ...(overrides.merchantRating === undefined ? {} : { merchantRating: overrides.merchantRating }),
    ...(overrides.merchantReviewCount === undefined
      ? {}
      : { merchantReviewCount: overrides.merchantReviewCount }),
    ...(overrides.returnWindowDays === undefined
      ? {}
      : { returnWindowDays: overrides.returnWindowDays }),
    availability: overrides.availability ?? 'in_stock',
    ...(overrides.freshnessElapsedFraction === undefined
      ? {}
      : { freshnessElapsedFraction: overrides.freshnessElapsedFraction }),
    ...(overrides.relationship === undefined ? {} : { relationship: overrides.relationship }),
    ...(overrides.pickupDistanceMetres === undefined
      ? {}
      : { pickupDistanceMetres: overrides.pickupDistanceMetres }),
    nativeCheckoutEligible: overrides.nativeCheckoutEligible ?? false,
  };
}

/** A fully-admitted candidate — every eligibility rule evaluated. */
export function buildCandidate(offerId: string, overrides: FactOverrides = {}): EligibleOffer {
  return {
    offerId,
    kind: 'external',
    admission: { rulesEvaluated: OFFER_ELIGIBILITY_RULES },
    facts: buildFacts(overrides),
  };
}
