/**
 * Which catalogue variants Mercaria sells ITSELF, batched for a listing read
 * (#129 §"Offer presentation modes", ADR 0004 D4).
 *
 * The authority is `partitionRetailLines` — the exact function `checkout`
 * calls — rather than a second query that means the same thing. That is what
 * makes "the product page and the till cannot disagree" a property of the call
 * graph: there is one place that asks which variants carry a live
 * `retail_offer_bindings` row, and both surfaces go through it. A private
 * `SELECT` here would be a second answer to a question that already has one,
 * and the day the binding gains a condition (a market, a channel, a retirement
 * grace) only one of the two would learn about it.
 *
 * It is deliberately NOT gated on `config.retail.enabled`. A deployment with
 * retail entry switched off still needs to know a variant is retail-bound,
 * because the alternative is describing Mercaria's own stock as a sale by
 * whoever happens to own the listing row — which is precisely the
 * misattribution #129 exists to prevent, and it would appear at the exact
 * moment somebody pulled the incident lever. Checkout refuses such a line BY
 * NAME (`retail_line_ineligible`) for the same reason.
 */

import { deriveCommercialMode, type CommercialPresentation } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres';
import { partitionRetailLines } from '../checkout/retail';
import { currentRetailPresentation, marketplacePresentation } from './presentation';

/** One catalogue variant and the seller who owns the listing it belongs to. */
export interface VariantCommercialSubject {
  variantId: string;
  /** The owning listing's `ownerType`. */
  sellerKind: 'store' | 'user';
  /** The owning store's or seller's public display name. */
  sellerLabel: string;
}

/**
 * The commercial presentation for each variant, keyed by variant id.
 *
 * One batched read for the whole page: the retail binding lookup takes every
 * variant id at once, so a listing with forty configurations costs one
 * statement rather than forty.
 *
 * A variant absent from the input is absent from the result — there is no empty
 * default, because a caller holding a presentation it did not ask for would be
 * holding a claim about a seller nobody resolved.
 */
export async function resolveVariantCommercialPresentations(
  subjects: readonly VariantCommercialSubject[],
  db?: DatabaseOrTransaction,
): Promise<Map<string, CommercialPresentation>> {
  const byVariant = new Map<string, CommercialPresentation>();
  if (subjects.length === 0) return byVariant;

  const partition = await partitionRetailLines(
    subjects,
    // Quantity plays no part in the split; the binding is a fact about the
    // VARIANT. One unit is passed because the shared reader's shape asks for a
    // quantity, and inventing a larger one would suggest it mattered.
    (subject) => ({ variantId: subject.variantId, quantity: 1 }),
    db,
  );
  const retailVariantIds = new Set(partition.retail.map((entry) => entry.variantId));

  for (const subject of subjects) {
    const mode = deriveCommercialMode({
      offerKind: 'native',
      hasLiveRetailBinding: retailVariantIds.has(subject.variantId),
    });
    byVariant.set(
      subject.variantId,
      mode === 'mercaria_retail'
        ? currentRetailPresentation()
        : marketplacePresentation({
            sellerKind: subject.sellerKind,
            sellerLabel: subject.sellerLabel,
          }),
    );
  }
  return byVariant;
}
