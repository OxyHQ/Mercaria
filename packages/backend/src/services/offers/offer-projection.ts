/**
 * Row → `Offer` DTO (#57 acceptance 2 and 7).
 *
 * PURE: every fact it needs arrives in {@link OfferProjectionContext}, so the
 * three derivations that decide what a buyer is shown — marketplace-ness,
 * freshness and native checkout eligibility — are testable against exact inputs
 * and an exact clock rather than against whatever the database happened to
 * contain when the test ran.
 *
 * ## The context is LIVE facts, and that is the whole design
 *
 * `listingStatuses`, `variantStock` and `sellerReady` are read at projection
 * time from the tables that OWN them — `listings`, `product_variants`,
 * `provider_accounts` — not copied onto the offer when it was materialized. A
 * copy would be a second authority, and the window in which it is wrong is
 * exactly the window in which a jury has restricted a listing and a buyer must
 * not be able to check out (issue native rule 5, acceptance 6).
 *
 * A native offer whose listing could not be resolved projects as NOT eligible:
 * `deriveNativeCheckoutEligibility` treats an absent status as not-active, which
 * is the fail-closed direction and the only safe reading of "I could not find
 * out".
 */

import {
  deriveNativeCheckoutEligibility,
  deriveOfferCondition,
  deriveOfferDelivery,
  deriveOfferFreshness,
  deriveOfferSellerRole,
  type Offer,
  type OfferAffiliateRouting,
  type OfferConditionKey,
  type OfferProvenance,
  type OfferQualitySignal,
  type OfferReturnPolicy,
} from '@mercaria/shared-types';
import type { OfferRow } from '../../db/offers/offerRepository.js';

/** The live facts a projection reads, gathered once per page rather than per row. */
export interface OfferProjectionContext {
  /** `listings.status` RIGHT NOW, by listing id. A missing entry fails closed. */
  listingStatuses: ReadonlyMap<string, string>;
  /** `product_variants` stock RIGHT NOW, by variant id. A missing entry fails closed. */
  variantStock: ReadonlyMap<string, { inventoryTracked: boolean; inventoryAvailable: number }>;
  /** The seller key (`store:<id>` / `user:<id>`) that owns each listing. */
  listingSellerKeys: ReadonlyMap<string, string>;
  /** ADR 0001 D9's stored readiness verdict, by seller key. */
  sellerReady: ReadonlyMap<string, boolean>;
  /** `catalog_sources` rights, by SOURCE RECORD id — the registry owns them, never the offer. */
  sourceRights: ReadonlyMap<string, { mayDisplay: boolean; attributionRequired: boolean }>;
  /**
   * The #90 mapping-ruleset VERSION behind each `condition_mapping_ruleset_id`,
   * gathered once per page.
   *
   * The offer stores the ruleset's row id and the DTO publishes its version
   * number, because a version is the thing an operator corrects against and a
   * row id is a key nobody outside this service can use. A missing entry means
   * the version is simply omitted — an unresolvable ruleset must not become
   * version 0, which reads as a real published ruleset.
   */
  conditionRulesetVersions: ReadonlyMap<string, number>;
  now: Date;
}

/**
 * Narrow a stored offer condition to the taxonomy.
 *
 * The column's TypeScript type carries the transitional `'used'` until migration
 * `0031` narrows the CHECK — the `listings` counterpart of this lives in
 * `services/condition/condition-projection.ts` and both disappear together.
 */
function narrowStoredOfferCondition(stored: OfferConditionKey | 'used'): OfferConditionKey {
  return stored === 'used' ? 'used_good' : stored;
}

function toProvenance(
  row: OfferRow,
  rights: { mayDisplay: boolean; attributionRequired: boolean } | undefined,
): OfferProvenance {
  return {
    ...(row.sourceRecordId ? { sourceRecordId: row.sourceRecordId } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.sourceAccountRef ? { sourceAccountRef: row.sourceAccountRef } : {}),
    ...(row.externalOfferId ? { externalOfferId: row.externalOfferId } : {}),
    ...(row.sourceConfidence === null ? {} : { confidence: row.sourceConfidence }),
    ...(rights ? { mayDisplay: rights.mayDisplay, attributionRequired: rights.attributionRequired } : {}),
  };
}

/**
 * The affiliate routing, present only when a network is actually named.
 *
 * The composed tracked URL is deliberately absent from both the row and this
 * shape: #37 builds it at redirect time from these parts, so `destinationUrl`
 * stays the ORIGINAL destination and a routing change cannot orphan it.
 */
function toAffiliateRouting(row: OfferRow): OfferAffiliateRouting | undefined {
  if (!row.affiliateNetwork) return undefined;
  return {
    network: row.affiliateNetwork,
    ...(row.affiliateProgramRef ? { programRef: row.affiliateProgramRef } : {}),
    ...(row.affiliatePublisherRef ? { publisherRef: row.affiliatePublisherRef } : {}),
    ...(row.affiliateTrackingTemplate ? { trackingTemplate: row.affiliateTrackingTemplate } : {}),
  };
}

function toReturnPolicy(row: OfferRow): OfferReturnPolicy | undefined {
  if (!row.returnPolicyUrl && row.returnPolicyWindowDays === null && !row.returnPolicyRef) {
    return undefined;
  }
  return {
    ...(row.returnPolicyUrl ? { url: row.returnPolicyUrl } : {}),
    ...(row.returnPolicyWindowDays === null ? {} : { windowDays: row.returnPolicyWindowDays }),
    ...(row.returnPolicyRef ? { policyRef: row.returnPolicyRef } : {}),
  };
}

/**
 * Project one offer, with its channel operator and the live facts around it.
 *
 * `storefrontOperatorMerchantId` comes from a JOIN the repository performs and
 * is never a column on the offer: comparing it with `merchant_id` IS what makes
 * an offer a marketplace offer (ADR 0002 D8), and a stored copy of either side
 * could disagree with the other.
 */
export function projectOffer(
  row: OfferRow,
  storefrontOperatorMerchantId: string | null,
  context: OfferProjectionContext,
): Offer {
  const listingStatus = row.listingId ? context.listingStatuses.get(row.listingId) : undefined;
  const stock = row.productVariantId ? context.variantStock.get(row.productVariantId) : undefined;
  const sellerKey = row.listingId ? context.listingSellerKeys.get(row.listingId) : undefined;
  const sellerReady = sellerKey ? (context.sellerReady.get(sellerKey) ?? false) : false;

  const freshness = deriveOfferFreshness(
    {
      observedAt: row.observedAt,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      lastConfirmedAt: row.lastConfirmedAt,
      staleAt: row.staleAt,
    },
    context.now,
  );

  /**
   * `stale_observation` is added HERE rather than stored, for the reason the
   * schema states: staleness is a deadline against the clock, and a stored
   * signal beside that deadline is wrong for as long as nobody has swept it.
   * The stored signals are facts about what the source published; this one is a
   * fact about when.
   */
  const rulesetVersion = row.conditionMappingRulesetId
    ? context.conditionRulesetVersions.get(row.conditionMappingRulesetId)
    : undefined;

  const storedSignals = row.qualitySignals as OfferQualitySignal[];
  const qualitySignals: OfferQualitySignal[] =
    freshness.state === 'stale' && !storedSignals.includes('stale_observation')
      ? [...storedSignals, 'stale_observation']
      : storedSignals;

  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    ...(row.retirementReason ? { retirementReason: row.retirementReason } : {}),

    canonicalVariantId: row.canonicalVariantId,

    ...(row.merchantId ? { merchantId: row.merchantId } : {}),
    ...(row.storefrontId ? { storefrontId: row.storefrontId } : {}),
    ...(storefrontOperatorMerchantId
      ? { storefrontOperatorMerchantId: storefrontOperatorMerchantId }
      : {}),
    sellerRole: deriveOfferSellerRole(row.merchantId, storefrontOperatorMerchantId),

    ...(row.listingId ? { listingId: row.listingId } : {}),
    ...(row.productVariantId ? { productVariantId: row.productVariantId } : {}),

    ...(row.priceAmount !== null && row.priceCurrency
      ? { price: { amount: row.priceAmount, currency: row.priceCurrency } }
      : {}),
    ...(row.compareAtPriceAmount !== null && row.compareAtPriceCurrency
      ? {
          compareAtPrice: {
            amount: row.compareAtPriceAmount,
            currency: row.compareAtPriceCurrency,
          },
        }
      : {}),
    availability: row.availability,
    ...(row.availableQuantity === null ? {} : { availableQuantity: row.availableQuantity }),
    condition: deriveOfferCondition({
      condition: narrowStoredOfferCondition(row.condition),
      mappingState: row.conditionMappingState,
      sourceLabel: row.conditionSourceLabel,
      mappingRulesetVersion: rulesetVersion ?? null,
    }),

    ...(row.sellerSku ? { sellerSku: row.sellerSku } : {}),
    ...(row.merchantTitle ? { merchantTitle: row.merchantTitle } : {}),
    ...(row.merchantVariantText ? { merchantVariantText: row.merchantVariantText } : {}),

    ...(row.destinationUrl ? { destinationUrl: row.destinationUrl } : {}),
    ...((): { affiliate?: OfferAffiliateRouting } => {
      const affiliate = toAffiliateRouting(row);
      return affiliate ? { affiliate } : {};
    })(),

    ...(row.country ? { country: row.country } : {}),
    ...(row.region ? { region: row.region } : {}),
    ...(row.language ? { language: row.language } : {}),
    customerEligibility: row.customerEligibility,

    delivery: deriveOfferDelivery({
      costAmount: row.deliveryCostAmount,
      costCurrency: row.deliveryCostCurrency,
      freeOverAmount: row.deliveryFreeOverAmount,
      freeOverCurrency: row.deliveryFreeOverCurrency,
      minDays: row.deliveryMinDays,
      maxDays: row.deliveryMaxDays,
      pickup: row.pickupState,
    }),
    ...((): { returnPolicy?: OfferReturnPolicy } => {
      const returnPolicy = toReturnPolicy(row);
      return returnPolicy ? { returnPolicy } : {};
    })(),

    provenance: toProvenance(
      row,
      row.sourceRecordId ? context.sourceRights.get(row.sourceRecordId) : undefined,
    ),
    freshness,
    qualitySignals,

    checkout: deriveNativeCheckoutEligibility({
      kind: row.kind,
      status: row.status,
      listingId: row.listingId,
      productVariantId: row.productVariantId,
      listingStatus: listingStatus ?? null,
      inventoryTracked: stock?.inventoryTracked ?? null,
      inventoryAvailable: stock?.inventoryAvailable ?? null,
      sellerPaymentReady: sellerReady,
    }),
  };
}
