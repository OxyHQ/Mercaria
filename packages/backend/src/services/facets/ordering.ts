/**
 * What decides the order of a facet rail, and of the answers inside each facet
 * (#367 Workstream 10).
 *
 * PURE, and deliberately small: every comparator here reads a POSITION somebody
 * published or a tuple this repository ships, and there is no numeric weight,
 * score or blend anywhere in the file. That is the mechanical form of "a
 * commercial payment may never influence facet ordering" — not a check that a
 * fee is absent, but an ordering with nowhere to put one.
 *
 * ## Why `result_count` is permitted for some value sets and not others
 *
 * A registry enum has a published order (`attribute_enum_values.position`) and
 * ordering it by popularity turns `S, M, L, XL` into `M, L, S, XL` — the reason
 * #94's own facet service already refuses it. A free-text `string` attribute has
 * NO published order, so the alternatives are alphabetical (which buries the
 * useful answers) or the counts (which are a property of the shopper's own
 * result set, not a purchasable position). Counts win there, and only there.
 *
 * ## The comparators are TOTAL
 *
 * Every one ends on the stable key. Without that, `Array.prototype.sort`'s
 * stability leaks the order the rows arrived in — which is the planner's
 * opinion, and it changes between runs. A rail that reshuffles on refresh is
 * indistinguishable from one somebody is manipulating.
 */

import type { ConditionGroup, OfferAvailability } from '@mercaria/shared-types';
import {
  CONDITION_GROUPS,
  OFFER_AVAILABILITY_STATES,
  OFFER_CHANNEL_KINDS,
} from '@mercaria/shared-types';

/** The minimum a facet needs to be placed in the rail. */
export interface OrderableFacet {
  readonly key: string;
  readonly groupPosition: number;
  readonly fieldPosition: number;
}

/** The minimum a bucket needs to be placed inside its facet. */
export interface OrderableBucket {
  readonly key: string;
  readonly count: number;
  /** The registry's published position, when the value set has one. */
  readonly registryPosition?: number;
}

/**
 * Rail order: published group, then published field position, then the key.
 *
 * `FACET_UNTYPED_GROUP_POSITION` puts every attribute the product type did not
 * name after every one it did, which is why untyped deployments still get a
 * stable alphabetical rail rather than an arbitrary one.
 */
export function compareFacets(left: OrderableFacet, right: OrderableFacet): number {
  if (left.groupPosition !== right.groupPosition) return left.groupPosition - right.groupPosition;
  if (left.fieldPosition !== right.fieldPosition) return left.fieldPosition - right.fieldPosition;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/** Ordered by the registry's published position, then the key. */
export function compareByRegistryPosition(left: OrderableBucket, right: OrderableBucket): number {
  const a = left.registryPosition ?? Number.MAX_SAFE_INTEGER;
  const b = right.registryPosition ?? Number.MAX_SAFE_INTEGER;
  if (a !== b) return a - b;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/*
 * There is deliberately no `compareByMagnitude` here.
 *
 * `FACET_ORDERING_INPUTS` names `value_magnitude` and it IS used — by
 * `measureProductAttributeRanges` and `measureVariantAttributeRanges`, whose
 * `min`/`max` is the magnitude ordering, taken in SQL where the values are.
 * Every BUCKET shape this domain generates is text or boolean
 * (`FACET_SHAPE_BY_VALUE_TYPE` sends every numeric type to a range), so a
 * magnitude comparator would have no caller — and an exported, tested mechanism
 * nothing calls reads as coverage while enforcing nothing. It arrives with the
 * first numeric bucket shape, if one ever is.
 */

/** Ordered by how many results each answer leaves, then the key. */
export function compareByCount(left: OrderableBucket, right: OrderableBucket): number {
  if (left.count !== right.count) return right.count - left.count;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/**
 * Build a comparator from a SHIPPED VOCABULARY TUPLE.
 *
 * Availability, condition segments and channels each have a canonical order this
 * repository already publishes; reading it from the tuple means the facet rail
 * and every other surface agree, and a member added to one of those tuples
 * appears in the right place here without anybody editing this file.
 */
export function compareByTuple(order: readonly string[]) {
  const index = new Map(order.map((value, position) => [value, position]));
  return (left: OrderableBucket, right: OrderableBucket): number => {
    const a = index.get(left.key) ?? order.length;
    const b = index.get(right.key) ?? order.length;
    if (a !== b) return a - b;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  };
}

/** Availability, in the offer vocabulary's own order. */
export const compareAvailabilityBuckets = compareByTuple(
  OFFER_AVAILABILITY_STATES as readonly OfferAvailability[] as readonly string[],
);

/** Condition segments, best first — #90's taxonomy order, not the counts. */
export const compareConditionBuckets = compareByTuple(
  CONDITION_GROUPS as readonly ConditionGroup[] as readonly string[],
);

/** Native before external, the two-member channel vocabulary's own order. */
export const compareChannelBuckets = compareByTuple(OFFER_CHANNEL_KINDS as readonly string[]);

/**
 * Markets: alphabetical by ISO code.
 *
 * There is no published order for territories and there must not be one here —
 * "which markets come first" is a merchandising decision, and a list in this
 * file would be exactly the hard-coded ordering the workstream removes. When a
 * market rail wants a curated order it comes from navigation configuration
 * (ADR 0007 D3), which is versioned and somebody's published decision.
 */
export function compareMarketBuckets(left: OrderableBucket, right: OrderableBucket): number {
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}
