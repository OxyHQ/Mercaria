/**
 * What a public page renders for an outbound offer (#67 outbound rules 5 and 8,
 * trust principles 1 and 3).
 *
 * Three facts and no URL: the destination HOST, a MERCARIA path, and the link
 * relationship. A page never receives the merchant's address, so a crawler
 * scraping the page cannot follow the tracked destination and no click can
 * happen without a click record behind it.
 *
 * `rel` is DATA rather than something each surface composes, because "is this
 * link disclosed as paid" is one answer and three clients would eventually give
 * three. It is served from the API so a copy or policy change reaches a shipped
 * mobile build without one.
 */

import { OUTBOUND_LINK_REL, type OutboundDisclosure } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import type { OfferRow } from '../../db/offers/offerRepository.js';
import { outboundDestinationHost } from './destination.js';
import { mintAffiliateOutboundToken } from './token.js';

/** The Mercaria path an outbound control points at. Relative, always. */
export function affiliateOutboundPath(offerId: string): string {
  return `/out/${mintAffiliateOutboundToken({ offerId })}`;
}

/**
 * Compose the disclosure for one offer, or answer `undefined`.
 *
 * `undefined` when the redirect is not mounted (there is no path to offer and
 * a control pointing at a 404 is worse than none) or when the offer publishes
 * no destination at all. Both are states the product page already renders —
 * `redirect_unavailable` and `no_destination` — so this returns absence rather
 * than a half-built disclosure, and the CALLER keeps deciding which of its own
 * reasons to show.
 *
 * A NATIVE offer never reaches here: it has no destination by CHECK, so
 * `outboundDestinationHost` answers `undefined`. That is requirement 6 holding
 * on the render side for the same structural reason it holds on the click side.
 */
export function resolveOutboundDisclosure(offer: OfferRow): OutboundDisclosure | undefined {
  if (!config.affiliateOutbound.redirectEnabled) return undefined;
  const destinationHost = outboundDestinationHost(offer);
  if (destinationHost === undefined) return undefined;
  return {
    destinationHost,
    redirectPath: affiliateOutboundPath(offer.id),
    rel: OUTBOUND_LINK_REL,
  };
}
