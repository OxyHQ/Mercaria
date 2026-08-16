/**
 * Turning what a shopper picked into requirements, partitioned by the grain each
 * one binds at (#367 Workstream 10).
 *
 * PURE. This is where same-variant and same-offer are DECIDED — the repository
 * is where they are spelled. A selection arrives naming a facet; the plan says
 * which {@link FacetLevel} that facet is; and this module drops it into the
 * `product`, `variant` or `offer` bucket of a {@link FacetRequirements}. The
 * repository then nests those three sets, and there is no path from a selection
 * to SQL that does not go through this partition.
 *
 * ## Lifting a facet's own selection
 *
 * A multi-select rail asks "how many are left if I pick blue INSTEAD of red",
 * not "…AS WELL AS red". So each facet's counts are taken with its own selection
 * removed and every other selection applied — {@link liftFacet}. Doing it the
 * other way round produces a rail where every unselected answer reads zero the
 * moment one answer is picked, which is a rail nobody can use.
 *
 * It is also what makes "selected filters preserved even when the count is zero"
 * possible rather than special-cased: with its own selection lifted, a facet's
 * chosen bucket still gets a real count from the OTHER filters, and a zero there
 * is a true statement about the intersection rather than an artefact of asking
 * the wrong question.
 */

import type {
  ConditionGroup,
  CurrencyCode,
  FacetCommerceDimension,
  FacetLevel,
  FacetSelectionEntry,
} from '@mercaria/shared-types';
import { FACET_TAXONOMY_KEY, isFacetCommerceDimension } from '@mercaria/shared-types';
import type {
  FacetAttributeRequirement,
  FacetOfferRequirements,
  FacetPriceBound,
  FacetRequirements,
} from '../../db/facets/facetRepository.js';

/** What the caller must know about a facet to place its selection. */
export interface FacetLevelLookup {
  /** `undefined` for a facet key nothing generated — the caller refuses those. */
  levelOf(facetKey: string): FacetLevel | undefined;
}

/**
 * The commerce dimension → grain map.
 *
 * Every one of them is `offer`, and that is the point rather than a coincidence:
 * a price, a stock state, a condition, a market and a channel are all properties
 * of ONE seller's ONE listing of the thing, and the failure this workstream
 * exists to fix is reading them off different sellers. There is no commerce
 * dimension at product grain, so the map has no other value to take.
 */
export const FACET_COMMERCE_LEVEL: FacetLevel = 'offer';

/** The taxonomy facet narrows which products are in scope, not which variants. */
export const FACET_TAXONOMY_LEVEL: FacetLevel = 'product';

/** A price bound as the shopper stated it, before conversion. */
export interface FacetRequestedPriceBound {
  readonly currency: CurrencyCode;
  readonly minMinor?: number;
  readonly maxMinor?: number;
}

/** The partition, plus what the caller still has to resolve. */
export interface PartitionedSelection {
  readonly requirements: FacetRequirements;
  /**
   * The price bound in the currency the shopper named, if any. The service
   * converts it into every currency present in scope through `fx.convert` — SQL
   * cannot, and the repository takes the results rather than the request.
   */
  readonly requestedPrice?: FacetRequestedPriceBound;
  /** Selections naming a facet nothing generated, so a caller can report them. */
  readonly unknownFacetKeys: readonly string[];
}

/** One attribute selection as a requirement, or `null` when it constrains nothing. */
function attributeRequirement(
  entry: Extract<FacetSelectionEntry, { origin: 'attribute' }>,
): FacetAttributeRequirement | null {
  const hasValues = entry.values !== undefined && entry.values.length > 0;
  if (!hasValues && entry.min === undefined && entry.max === undefined) return null;
  return {
    key: entry.facetKey,
    ...(hasValues ? { values: entry.values } : {}),
    ...(entry.min === undefined ? {} : { min: entry.min }),
    ...(entry.max === undefined ? {} : { max: entry.max }),
  };
}

/**
 * Fold one commerce selection into the offer requirement set.
 *
 * Every dimension lands on the SAME {@link FacetOfferRequirements} object, which
 * is the shape that makes same-offer unavoidable downstream: there is no
 * per-dimension requirement type for the repository to evaluate independently.
 */
function foldCommerce(
  into: {
    availability: string[];
    conditionGroups: ConditionGroup[];
    markets: string[];
    channels: ('native' | 'external')[];
  },
  entry: Extract<FacetSelectionEntry, { origin: 'commerce' }>,
): void {
  const values = entry.values ?? [];
  if (values.length === 0) return;
  switch (entry.facetKey) {
    case 'availability':
      into.availability.push(...values);
      return;
    case 'condition':
      into.conditionGroups.push(...(values as ConditionGroup[]));
      return;
    case 'market':
      into.markets.push(...values);
      return;
    case 'offer_channel':
      into.channels.push(...values.filter((v): v is 'native' | 'external' =>
        v === 'native' || v === 'external',
      ));
      return;
    case 'offer_price':
      // The price bound is not a value list; it is carried separately because
      // it needs FX before it can be a predicate.
      return;
    default:
      return;
  }
}

/** Partition a whole selection into the three grains plus the taxonomy narrowing. */
export function partitionSelection(
  entries: readonly FacetSelectionEntry[],
  lookup: FacetLevelLookup,
): PartitionedSelection {
  const product: FacetAttributeRequirement[] = [];
  const variant: FacetAttributeRequirement[] = [];
  const commerce = {
    availability: [] as string[],
    conditionGroups: [] as ConditionGroup[],
    markets: [] as string[],
    channels: [] as ('native' | 'external')[],
  };
  const categoryIds: string[] = [];
  const unknownFacetKeys: string[] = [];
  let requestedPrice: FacetRequestedPriceBound | undefined;

  for (const entry of entries) {
    if (entry.origin === 'taxonomy') {
      categoryIds.push(...entry.values);
      continue;
    }
    if (entry.origin === 'commerce') {
      if (!isFacetCommerceDimension(entry.facetKey)) {
        unknownFacetKeys.push(entry.facetKey);
        continue;
      }
      if (entry.facetKey === 'offer_price') {
        if (entry.currency !== undefined && (entry.minMinor !== undefined || entry.maxMinor !== undefined)) {
          requestedPrice = {
            currency: entry.currency,
            ...(entry.minMinor === undefined ? {} : { minMinor: entry.minMinor }),
            ...(entry.maxMinor === undefined ? {} : { maxMinor: entry.maxMinor }),
          };
        }
        continue;
      }
      foldCommerce(commerce, entry);
      continue;
    }

    const level = lookup.levelOf(entry.facetKey);
    if (level === undefined) {
      unknownFacetKeys.push(entry.facetKey);
      continue;
    }
    const requirement = attributeRequirement(entry);
    if (requirement === null) continue;
    // An attribute facet is never at offer grain — a registry key and a commerce
    // dimension are disjoint by `RESERVED_OFFER_FACT_KEYS` (#94), which is a
    // CHECK on `attribute_definitions`, so `price` cannot be an attribute at all.
    if (level === 'variant') variant.push(requirement);
    else product.push(requirement);
  }

  const offer: FacetOfferRequirements = {
    ...(commerce.availability.length === 0 ? {} : { availability: unique(commerce.availability) }),
    ...(commerce.conditionGroups.length === 0
      ? {}
      : { conditionGroups: unique(commerce.conditionGroups) }),
    ...(commerce.markets.length === 0 ? {} : { markets: unique(commerce.markets) }),
    ...(commerce.channels.length === 0 ? {} : { channels: unique(commerce.channels) }),
  };

  return {
    requirements: {
      product,
      variant,
      offer,
      ...(categoryIds.length === 0 ? {} : { categoryIds: unique(categoryIds) }),
    },
    ...(requestedPrice === undefined ? {} : { requestedPrice }),
    unknownFacetKeys,
  };
}

/**
 * The same requirements with ONE facet's own contribution removed.
 *
 * Keyed on the facet key and the grain together, because a commerce dimension
 * and an attribute may not collide but a caller should not have to know that.
 * The price bound is lifted by key as well, so the price facet's own span is
 * measured over everything the other filters admit.
 */
export function liftFacet(
  requirements: FacetRequirements,
  facetKey: string,
  level: FacetLevel,
): FacetRequirements {
  if (facetKey === FACET_TAXONOMY_KEY) {
    const { categoryIds: _dropped, ...rest } = requirements;
    return rest;
  }
  if (level === 'offer') {
    return { ...requirements, offer: liftOfferDimension(requirements.offer, facetKey) };
  }
  if (level === 'variant') {
    return { ...requirements, variant: requirements.variant.filter((r) => r.key !== facetKey) };
  }
  return { ...requirements, product: requirements.product.filter((r) => r.key !== facetKey) };
}

/** Drop one commerce dimension from an offer requirement set. */
export function liftOfferDimension(
  offer: FacetOfferRequirements,
  facetKey: string,
): FacetOfferRequirements {
  switch (facetKey as FacetCommerceDimension) {
    case 'availability': {
      const { availability: _a, ...rest } = offer;
      return rest;
    }
    case 'condition': {
      const { conditionGroups: _c, ...rest } = offer;
      return rest;
    }
    case 'market': {
      const { markets: _m, ...rest } = offer;
      return rest;
    }
    case 'offer_channel': {
      const { channels: _k, ...rest } = offer;
      return rest;
    }
    case 'offer_price': {
      const { priceBounds: _p, ...rest } = offer;
      return rest;
    }
    default:
      return offer;
  }
}

/** Attach converted price bounds to an offer requirement set. */
export function withPriceBounds(
  offer: FacetOfferRequirements,
  bounds: readonly FacetPriceBound[],
): FacetOfferRequirements {
  return bounds.length === 0 ? offer : { ...offer, priceBounds: bounds };
}

/** Stable de-duplication that preserves first-seen order. */
function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
