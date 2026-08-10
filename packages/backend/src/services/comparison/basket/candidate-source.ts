/**
 * Turning one of #74's ranked offers into a solver candidate (#96).
 *
 * The ONE construction, shared by the solve and by the revalidation that
 * follows it. That sharing is the point rather than a convenience: revalidation
 * exists to answer "does this plan still describe what the shopper would pay",
 * and a second reading of an offer's terms would answer it about a slightly
 * different offer every time the two spellings drifted.
 *
 * It is also the ONE module in the domain that resolves FX rates. `render.ts`
 * formats what it is given and everything else is pure; a second `getRates`
 * call site would be a second answer to what a threshold is worth, which is
 * exactly the disagreement `comparison-isolation.test.ts` WALL 6 exists to
 * prevent.
 */

import { createHash } from 'node:crypto';
import {
  ALL_CURRENCY_CODES,
  type CurrencyCode,
  type FxRates,
  type Offer,
  type OfferRelationshipStanding,
  type RankedOffer,
} from '@mercaria/shared-types';
import { getRates } from '../../fx.service.js';
import { destinationHostOf } from '../../product-page/outbound.js';
import { convertOfferMoney } from '../../ranking/money.js';
import type { ComparisonRecordIndex } from '../record-refs.js';
import { toMoneyFact } from '../render.js';
import type { BasketCandidate } from './candidates.js';

/**
 * The rate map a comparison prices against.
 *
 * Every quotable currency, resolved once per solve. `getRates` never throws and
 * omits a pair it cannot serve, so an unquotable threshold becomes an UNKNOWN
 * free-over rather than a failed basket.
 */
export async function comparisonRates(currency: CurrencyCode): Promise<FxRates> {
  return getRates(currency, [...ALL_CURRENCY_CODES]);
}

export interface CandidateInput {
  readonly index: ComparisonRecordIndex;
  readonly lineId: string;
  readonly subjectRef: string;
  readonly offer: Offer;
  readonly rankedOffer: RankedOffer;
  readonly policyVersion: string;
  readonly currency: CurrencyCode;
  readonly rates: FxRates;
  readonly sellerLabel: string;
}

/** One ranked offer, as the solver reads it. */
export function toCandidate(input: CandidateInput): BasketCandidate {
  const { offer, rankedOffer } = input;
  const offerRef = input.index.register({
    kind: 'offer',
    recordId: offer.id,
    label: input.sellerLabel,
  });
  const merchantRef =
    offer.merchantId === undefined
      ? undefined
      : input.index.register({
          kind: 'merchant',
          recordId: offer.merchantId,
          label: input.sellerLabel,
        });

  const native = offer.checkout.eligible === true;
  // A NATIVE offer keys on one shared merchant — every native line goes into
  // one Mercaria cart and is one checkout for the shopper, which is what a
  // merchant COSTS them. See `candidates.ts` for the external cases.
  const merchantKey = native ? 'native' : (offer.merchantId ?? `offer:${offer.id}`);

  const freeOver =
    offer.delivery.known === true && offer.delivery.freeOver !== undefined
      ? toMoneyFact(convertOfferMoney(offer.delivery.freeOver, input.currency, input.rates))
      : ({ state: 'unknown', reason: 'not_published' } as const);

  return {
    lineId: input.lineId,
    subjectRef: input.subjectRef,
    offerRef,
    offerId: offer.id,
    merchantKey,
    ...(merchantRef === undefined ? {} : { merchantRef }),
    merchantLabel: input.sellerLabel,
    channel: native ? 'native_checkout' : 'external_merchant',
    unitItemPrice: toMoneyFact(rankedOffer.cost.itemPrice),
    delivery: toMoneyFact(rankedOffer.cost.deliveryCost),
    deliveryFreeOver: freeOver,
    ...(offer.delivery.known === true && offer.delivery.maxDays !== undefined
      ? { deliveryMaxDays: offer.delivery.maxDays }
      : {}),
    taxInclusion: rankedOffer.cost.taxInclusion,
    ...(offer.condition.group === undefined ? {} : { conditionGroup: offer.condition.group }),
    ...(standingOf(rankedOffer) === undefined ? {} : { relationship: standingOf(rankedOffer) }),
    ...(offer.availableQuantity === undefined
      ? {}
      : { availableQuantity: offer.availableQuantity }),
    freshness:
      offer.freshness.level === 'current'
        ? 'current'
        : offer.freshness.level === 'unknown'
          ? 'unknown'
          : 'ageing',
    nativeCheckoutEligible: native,
    ...(offer.checkout.eligible === true
      ? { productVariantId: offer.checkout.productVariantId }
      : {}),
    ...(destinationHostOf(offer) === undefined
      ? {}
      : { destinationHost: destinationHostOf(offer) }),
    tieBreak: createHash('sha256').update(`${input.policyVersion}:${offer.id}`).digest('hex'),
  };
}

/**
 * #74's verified standing, read off the LABELS.
 *
 * #71 reads it the same way and for the same reason: the labels are the
 * relationship layer's published answer for a comparison surface, and reaching
 * into `commerce_relationships` from here would be a second resolver over a
 * table this domain does not own.
 */
export function standingOf(
  rankedOffer: RankedOffer,
): Exclude<OfferRelationshipStanding, 'none'> | undefined {
  for (const award of rankedOffer.labels) {
    if (award.label === 'official_direct_store') return 'official_channel';
    if (award.label === 'authorized_reseller') return 'authorized_reseller';
  }
  return undefined;
}

/** A short seller name for a record label. Never a sentence, never an id. */
export function sellerLabelOf(seller: unknown): string {
  if (seller === undefined || seller === null || typeof seller !== 'object') return 'Seller';
  const value = seller as { kind?: string; name?: string; displayName?: string };
  if (value.kind === 'merchant' || value.kind === 'native_store') return value.name ?? 'Seller';
  if (value.kind === 'native_person') return value.displayName ?? 'Seller';
  return 'Seller';
}
