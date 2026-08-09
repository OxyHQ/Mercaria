/**
 * EPN attribution — issue #65 adapter rule 7, and #64 §6's eBay data-use rule 3:
 * *"Outbound links are ONLY `itemAffiliateWebUrl` (or the plain item URL when
 * unattributed); never hand-construct or mutate EPN tracking parameters."*
 *
 * ## The rule is a TYPE, not a review comment
 *
 * {@link EbayOutboundDestination} is a discriminated union with exactly two
 * branches, and BOTH carry a `url` the provider put in a response body. There is
 * no branch that takes a campaign id, a base URL, a template or a parameter map
 * — so "Mercaria composes an EPN link" is not something this codebase can
 * express, rather than something it has been told not to do.
 *
 * `EBAY_FORBIDDEN_LINK_OPERATIONS` (shared-types) states the prohibition as a
 * VALUE and is DISJOINT from `EBAY_OUTBOUND_DESTINATION_KINDS` by a gate, so a
 * plausible future addition to the destination set that happens to be a
 * construction fails the build. `ebay-attribution-isolation.test.ts` scans this
 * whole domain for URL construction against an eBay host and mutation-tests its
 * own detectors.
 *
 * ## Why it matters commercially, not just contractually
 *
 * Commission attribution lives entirely in the parameters eBay put in that URL.
 * A link Mercaria rebuilt, shortened, or "cleaned" is indistinguishable from a
 * working link right up until a month of revenue is missing — there is no error,
 * no rejection and no signal anywhere. The only detector this integration has
 * for a broken attribution is `affiliate_attribution_missing`, which
 * reconciliation raises when eBay stops MINTING the affiliate URL at all.
 *
 * ## The campaign id is a header value, and the header is the whole mechanism
 *
 * `X-EBAY-C-ENDUSERCTX: affiliateCampaignId=<id>,affiliateReferenceId=<ref>`.
 * Sending it makes every item in the response carry `itemAffiliateWebUrl`;
 * omitting it makes eBay answer with plain item URLs. Those are the two
 * outcomes, and Mercaria's whole part in attribution is deciding whether to send
 * the header.
 */

import type { EbayOutboundDestinationKind } from '@mercaria/shared-types';

/**
 * Where a buyer is sent for one eBay item.
 *
 * Both branches carry a URL the API RETURNED. The union has no third member and
 * no branch with a template, which is the point of writing it as a union at all.
 */
export type EbayOutboundDestination =
  | { readonly kind: 'affiliate'; readonly url: string }
  | { readonly kind: 'plain'; readonly url: string };

/**
 * The EPN campaign attribution one source runs under.
 *
 * `reference` is EPN's free-form `affiliateReferenceId` (≤256 chars), which is
 * how a click is attributed back to a surface. It is set to the SOURCE id and
 * never to anything that identifies a person: a reference id travels to eBay, is
 * echoed in EPN reporting, and a buyer-shaped value there would be an identifier
 * Mercaria exported to a third party for no purpose the feature needs.
 */
export interface EbayAttribution {
  readonly campaignId: string;
  readonly reference: string;
}

/**
 * The bound EPN reference ids must respect. eBay's documented cap.
 *
 * Exceeding it is not a validation nicety: eBay rejects the whole request, so a
 * long reference would take out discovery for the marketplace rather than
 * degrading attribution.
 */
export const EBAY_AFFILIATE_REFERENCE_MAX_LENGTH = 256;

/** A ten-digit EPN campaign id, which is the only shape EPN issues. */
const EBAY_CAMPAIGN_ID_PATTERN = /^\d{10}$/u;

/**
 * Whether a configured campaign id is one EPN could have issued.
 *
 * A malformed id is refused at CONFIGURATION time rather than sent: eBay ignores
 * an unrecognised `affiliateCampaignId` and answers with plain URLs, so a typo
 * would present as "attribution silently stopped working" — the one failure mode
 * this integration cannot otherwise see.
 */
export function isValidEbayCampaignId(value: string): boolean {
  return EBAY_CAMPAIGN_ID_PATTERN.test(value);
}

/**
 * The `X-EBAY-C-ENDUSERCTX` value for an attribution, or nothing.
 *
 * Returns `undefined` when there is no attribution to send, which makes the
 * unattributed case an ABSENT header rather than an empty one — an empty
 * `X-EBAY-C-ENDUSERCTX` is a malformed context and eBay may refuse the request.
 */
export function buildEndUserContext(attribution: EbayAttribution | null): string | undefined {
  if (attribution === null) return undefined;
  const reference = attribution.reference.slice(0, EBAY_AFFILIATE_REFERENCE_MAX_LENGTH);
  return `affiliateCampaignId=${attribution.campaignId},affiliateReferenceId=${reference}`;
}

/**
 * Choose the destination for one item, from what eBay returned.
 *
 * The affiliate URL wins when the provider minted one; the plain item URL is the
 * fallback; and an item with NEITHER produces `null`, which #62 turns into an
 * `informational` offer with no destination at all. That last case is why this
 * returns a union rather than a string: an offer with a destination Mercaria
 * invented is worse than an offer with none, and there is no third value to
 * return that would express "I made one up".
 *
 * Note that `affiliateWebUrl` is preferred even when `may_append_affiliate_params`
 * is off. That right governs whether Mercaria may APPEND parameters of its own,
 * which it never does; the URL eBay minted is the URL eBay published for the
 * item, and #62 decides separately whether it is stored as affiliate routing
 * metadata or as a plain destination.
 */
export function chooseEbayDestination(input: {
  affiliateWebUrl?: string | undefined;
  itemWebUrl?: string | undefined;
}): EbayOutboundDestination | null {
  const affiliate = input.affiliateWebUrl?.trim();
  if (affiliate !== undefined && affiliate.length > 0) {
    return { kind: 'affiliate', url: affiliate };
  }
  const plain = input.itemWebUrl?.trim();
  if (plain !== undefined && plain.length > 0) {
    return { kind: 'plain', url: plain };
  }
  return null;
}

/**
 * Whether attribution was requested and NOT honoured for a page.
 *
 * The one detector for EPN approval or campaign-id loss. It answers per PAGE
 * rather than per item because eBay legitimately omits `itemAffiliateWebUrl` for
 * individual items (a listing in a category EPN does not pay on), and a per-item
 * alarm would fire constantly. A page of items where attribution was requested
 * and NOT ONE carries an affiliate URL is the shape that means the campaign
 * stopped working.
 *
 * It reports rather than throws: an unattributed link is a working link, and
 * refusing the page would turn a revenue problem into a catalogue outage.
 */
export function pageLostAttribution(input: {
  attributionRequested: boolean;
  itemCount: number;
  affiliateUrlCount: number;
}): boolean {
  return input.attributionRequested && input.itemCount > 0 && input.affiliateUrlCount === 0;
}

/** The destination kinds this module can produce. Pinned against the tuple by a test. */
export const EBAY_PRODUCED_DESTINATION_KINDS: readonly EbayOutboundDestinationKind[] = [
  'affiliate',
  'plain',
];
