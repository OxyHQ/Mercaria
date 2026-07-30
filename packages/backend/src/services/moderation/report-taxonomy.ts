/**
 * Mercaria's report reasons, in the vocabulary a jury reasons about.
 *
 * Two vocabularies, deliberately kept apart:
 *
 *   * `AbuseReportCategory` is what a SHOPPER picks. It is marketplace-shaped and
 *     phrased the way a buyer thinks ("this is a fake", "this is stolen").
 *   * `TaxonomyCode` is the BASELINE taxonomy the case is versioned against, and
 *     it belongs to CrowdSource. Layer one is not Mercaria's to extend — a tenant
 *     minting its own codes would make findings incomparable across applications,
 *     which is the whole reason the baseline exists.
 *
 * This map is the join. It is the only place the two meet, so changing the wording
 * a shopper sees never touches the policy a jury applies, and vice versa.
 *
 * Note how much of the `commerce` family Mercaria actually uses: `counterfeit`,
 * `prohibited_item`, `misleading_listing` and `unsafe_product` are all reachable
 * from the storefront. No other Oxy application can say that — which is exactly
 * why the commerce half of the taxonomy needed a marketplace to exercise it.
 */

import type { TaxonomyCode } from '@oxyhq/crowdsource-contracts';
import type { AbuseReportCategory } from '@mercaria/shared-types';

/**
 * What each Mercaria category alleges, in baseline codes.
 *
 * `Record` over the full union rather than a partial map: adding a category to
 * `AbuseReportCategory` without deciding what it alleges stops compiling here,
 * which is the point. A category that silently fell through to a default would
 * send juries a claim nobody chose.
 */
const CATEGORY_TO_TAXONOMY: Readonly<Record<AbuseReportCategory, TaxonomyCode>> =
  Object.freeze({
    counterfeit: 'commerce.counterfeit',
    prohibited_item: 'commerce.prohibited_item',
    misleading_listing: 'commerce.misleading_listing',
    unsafe_product: 'commerce.unsafe_product',

    /**
     * Selling stolen goods is a prohibited-item claim, not a deception one: the
     * objection is that the item may not be sold at all, whoever describes it how.
     */
    stolen_goods: 'commerce.prohibited_item',

    /**
     * A scam is about the TRANSACTION rather than the object — the listing may
     * describe a real thing that never ships. That is an integrity claim, not a
     * product defect, and it is why `scam` is not folded into
     * `misleading_listing`.
     */
    scam: 'integrity.scam',

    /**
     * A shop pretending to be a brand it is not. Distinct from `counterfeit`,
     * which is about the GOODS: a genuine reseller can impersonate a brand's
     * official store, and a fake shop can sell real stock.
     */
    impersonation: 'integrity.impersonation',

    spam: 'integrity.spam',

    /**
     * The concrete way hateful material shows up in a catalogue: a slur in a
     * title, a description or a shop name.
     *
     * A reporter's category is an ALLEGATION, not a finding — the jury classifies
     * the material itself and may land anywhere in the `hate` or `harassment`
     * family, or nowhere. The category only has to route the case honestly, which
     * is also why there is no vague "offensive content" option: it would map to
     * nothing real, and inventing a generic code to receive it would put a claim
     * in front of a jury that the baseline taxonomy does not define.
     */
    hateful_content: 'hate.slur',

    /**
     * "Something else." Mapped to the open catch-all rather than guessed at: a
     * reporter who declined to classify has told us they do not know, and picking
     * a specific code on their behalf would put a claim in front of a jury that
     * nobody actually made. Their own words travel as `details`.
     */
    other: 'other.unclassifiable',
  });

/**
 * The allegations a report carries, deduped and SORTED.
 *
 * Sorting is not cosmetic and must not be "simplified" away. Ingress fingerprints
 * the whole envelope to detect an external id reused with different content, so
 * anything that varies between two deliveries of the SAME report turns a
 * legitimate outbox retry into a permanent 409 — silently, days later, as a report
 * stuck in a queue. Two categories that map to one code also collapse to one
 * allegation, so a shopper ticking both "counterfeit" and "misleading" does not
 * allege the same thing twice.
 */
export function toTaxonomyCodes(
  categories: readonly AbuseReportCategory[],
): TaxonomyCode[] {
  const codes = new Set<TaxonomyCode>();
  for (const category of categories) {
    const code = CATEGORY_TO_TAXONOMY[category];
    if (code !== undefined) codes.add(code);
  }
  return Array.from(codes).sort();
}
