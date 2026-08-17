/**
 * Compatibility and fitment on a product page (#367 workstream 5, workstream 9
 * §"Render compatibility/fitment from its dedicated domain").
 *
 * PURE. It takes the fitment statements the server published and partitions them
 * into what a shopper may be shown; `use-compatibility.ts` does the fetching and
 * `CompatibilityPanel` does the rendering.
 *
 * ## Exclusions are PARTITIONED, never dropped and never blended
 *
 * `GET /compatibility/fitments` includes `does_not_apply` rows and offers no
 * parameter to remove them, because a read narrowed to `applies` answers a
 * confident yes for every vehicle somebody explicitly excluded. That puts the
 * whole burden on this module: **a statement is grouped by its own
 * `applicability` and by nothing else.** A flat list of vehicle names is the
 * failure — "SEAT León (2015–2020)" under a heading meaning "fits these
 * vehicles", for a part that explicitly does not. It is the highest-cost wrong
 * answer in this epic, and it arrives through the renderer rather than the data.
 *
 * {@link partitionFitment} is therefore a `Record` over the whole
 * `CompatibilityApplicability` union rather than a filter chain: a `Record` cannot
 * omit a member, so a fifth applicability fails `tsc` here instead of falling into
 * whichever bucket an `else` happened to name.
 *
 * ## `unknown` has a bucket and it is not "fits"
 *
 * The server's publication policy already refuses to publish an `unknown`
 * statement, so the bucket is empty in practice. It exists anyway, and it exists
 * SEPARATELY from `does_not_apply`, because those are different sentences: "we
 * have no data for your car" is not "this does not fit your car". Collapsing them
 * either way is a wrong answer with a consequence — a shopper who buys because an
 * absence read as a fit, or who walks away because an absence read as a refusal.
 *
 * ## What is NOT composed here
 *
 * No fitment claim is composed from a title, an attribute, a family or a category.
 * Every field of every row comes off a `automotive_fitments` row the server
 * published, and this module has no parameter through which one could arrive.
 */

import { COMPATIBILITY_APPLICABILITIES } from '@mercaria/shared-types';
import type {
  AutomotiveFitmentView,
  CompatibilityApplicability,
  CompatibilitySubject,
} from '@mercaria/shared-types';

/**
 * Why compatibility could not be shown.
 *
 * Two members, and they are different facts: the read failed, or it succeeded and
 * this product has no published fitment at all. Most products have none — a phone
 * is not missing its fitment data, it has none — so the second is the ordinary
 * case and the panel renders nothing for it.
 */
export type ProductCompatibilityUnavailableReason = 'read_failed' | 'no_published_fitment';

/** One group of statements that say the same thing about different vehicles. */
export interface FitmentGroup {
  readonly applicability: CompatibilityApplicability;
  readonly fitments: readonly AutomotiveFitmentView[];
}

export type ProductCompatibility =
  | {
      readonly state: 'available';
      /**
       * The groups that have rows, in presentation order.
       *
       * A group is EMITTED only when it holds something, so a product with no
       * exclusions renders no exclusion heading — an empty "does not fit" section
       * reads as a warning about nothing.
       */
      readonly groups: readonly FitmentGroup[];
      /**
       * True when the server's page bound was reached, so the list is a page and
       * not the whole set. A part fitting eleven hundred vehicles is ordinary, and
       * a surface that presented a truncated page as complete would tell a shopper
       * their car is absent from a list that simply ends.
       */
      readonly truncated: boolean;
    }
  | {
      readonly state: 'unavailable';
      readonly reason: ProductCompatibilityUnavailableReason;
    };

/**
 * Where each group sits on the page. A `Record`, never an array of members.
 *
 * A `Record` over the union cannot omit a member and an array silently can, so a
 * fifth applicability fails `tsc` here rather than sorting to position `undefined`
 * — and the member list itself comes from `COMPATIBILITY_APPLICABILITIES` below,
 * so this file re-lists nothing the server owns.
 *
 * The order it encodes: what a shopper is looking for first, the caveat second,
 * the exclusion third, and `unknown` last as the weakest statement in the set. It
 * is deliberately NOT `COMPATIBILITY_APPLICABILITY_SEVERITY`, which resolves
 * CONTRADICTING statements about ONE vehicle to the most cautious answer — a
 * different question from what order to read a list of different vehicles in. Two
 * orders for two purposes, so neither is mistaken for the other.
 */
const FITMENT_GROUP_POSITION: Record<CompatibilityApplicability, number> = {
  applies: 0,
  partially_applies: 1,
  does_not_apply: 2,
  unknown: 3,
};

/**
 * Partition statements by their own applicability.
 *
 * Both `Record`s are total over the union by construction — see the header — and
 * the members are ITERATED from the shared tuple rather than written out, so the
 * set this file knows about is the set the server publishes.
 *
 * Nothing here sorts WITHIN a group: the server returns them by make and then
 * model, which is a stable order a shopper can scan, and re-sorting by a localized
 * display name would reorder the list every time the locale changed.
 */
export function partitionFitment(
  fitments: readonly AutomotiveFitmentView[],
): readonly FitmentGroup[] {
  const byApplicability: Record<CompatibilityApplicability, AutomotiveFitmentView[]> = {
    applies: [],
    partially_applies: [],
    does_not_apply: [],
    unknown: [],
  };
  for (const fitment of fitments) {
    byApplicability[fitment.applicability].push(fitment);
  }
  return [...COMPATIBILITY_APPLICABILITIES]
    .sort((left, right) => FITMENT_GROUP_POSITION[left] - FITMENT_GROUP_POSITION[right])
    .flatMap((applicability) => {
      const group = byApplicability[applicability];
      return group.length === 0 ? [] : [{ applicability, fitments: group }];
    });
}

/** What one composition was given. */
export interface ProductCompatibilityInput {
  /**
   * Every published statement about this product, from every subject that was
   * read — see `use-compatibility.ts` for which subjects those are and why.
   */
  readonly fitments: readonly AutomotiveFitmentView[];
  readonly truncated: boolean;
  /** True when a read errored. Distinguished from a read that found nothing. */
  readonly readFailed: boolean;
}

/**
 * Compose what the panel renders.
 *
 * A read that FAILED and a product with no fitment are two different answers, and
 * the order of the checks is why: an error is reported as an error even when it
 * also produced no rows, so a broken endpoint is never presented as "this part
 * fits nothing".
 */
export function composeProductCompatibility(
  input: ProductCompatibilityInput,
): ProductCompatibility {
  if (input.readFailed) {
    return { state: 'unavailable', reason: 'read_failed' };
  }
  const groups = partitionFitment(input.fitments);
  if (groups.length === 0) {
    return { state: 'unavailable', reason: 'no_published_fitment' };
  }
  return { state: 'available', groups, truncated: input.truncated };
}

/**
 * The subjects whose fitments describe the configuration a shopper is looking at.
 *
 * Two, at most, and the rule is one sentence each:
 *
 *  1. **The PRODUCT itself, always.** A statement attached to the product applies
 *     to every configuration of it.
 *  2. **The one configuration IN VIEW** — the variant the shopper selected, or the
 *     product's only variant when it has exactly one. A part with a single
 *     canonical variant has no configuration choice to make, so a statement about
 *     that configuration IS a statement about the product; this is the shape the
 *     brake-pad reference vertical has, and without this clause its eleven fitment
 *     statements would be invisible until somebody selected the only option there
 *     is.
 *
 * With SEVERAL variants and none selected there is no single configuration in
 * view, so nothing configuration-specific is shown — a fitment attached to one
 * configuration is not a statement about its siblings.
 *
 * The two sets are DISJOINT (`automotive_fitments` carries a product id XOR a
 * variant id, by CHECK), so the results concatenate with no deduplication
 * question to answer.
 */
export function fitmentSubjects(input: {
  readonly canonicalProductId: string | undefined;
  readonly selectedVariantId: string | undefined;
  readonly variantIds: readonly string[];
}): readonly CompatibilitySubject[] {
  if (input.canonicalProductId === undefined || input.canonicalProductId.length === 0) {
    return [];
  }
  const subjects: CompatibilitySubject[] = [
    { kind: 'canonical_product', productId: input.canonicalProductId },
  ];
  const inView =
    input.selectedVariantId !== undefined && input.selectedVariantId.length > 0
      ? input.selectedVariantId
      : input.variantIds.length === 1
        ? input.variantIds[0]
        : undefined;
  if (inView !== undefined && inView.length > 0) {
    subjects.push({ kind: 'canonical_variant', variantId: inView });
  }
  return subjects;
}
