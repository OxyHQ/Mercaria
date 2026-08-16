/**
 * What a row's primary action does (#71 actions 1 and 2) — and the seam #67
 * CLOSED.
 *
 * ## The handoff is real now
 *
 * #37's outbound redirect (`GET /out/:token`) exists: #67 built the signed
 * token, the click record, the destination allow-list and the bot handling, and
 * this module hands over to it. `redirectPath` is still a MERCARIA path by
 * TYPE, so nothing here can ever become a merchant URL or a composed tracking
 * URL — the page carries a Mercaria path and a destination HOST, and the real
 * destination is resolved server-side at the moment of the click.
 *
 * The two alternatives this file refused before #67 are still refused, and the
 * reasons are why the redirect is shaped the way it is:
 *
 * - **Linking straight to `offer.destinationUrl`** would assert at RENDER time
 *   what only a click can establish. #68 built `assertOfferOutboundEligible`
 *   precisely because a buyer leaves a product page open for an hour, and the
 *   offer that was current when it rendered is the one that is not current when
 *   they finally click; a raw link cannot re-check anything. It would also
 *   discard the commercial relationship an `affiliate` offer exists under,
 *   silently and with no error anywhere.
 * - **Deciding the destination HERE** would be a second place answering where
 *   Mercaria may send a browser, which is the shape an open redirect takes.
 *   This module mints a token naming the OFFER and knows nothing else; every
 *   revalidation, every right and every host comparison happens once, in
 *   `services/outbound/`.
 *
 * ## The host disclosed is the MERCHANT, never the network
 *
 * `destinationHost` comes from `offer.destinationUrl` — the retailer, exactly as
 * the source published it — while the redirect itself may hand over the
 * network's attributed link. Disclosing the redirector would name an affiliate
 * network the shopper has never heard of instead of the shop they are going to.
 *
 * ## When the redirect is not mounted
 *
 * `OUTBOUND_REDIRECT_ENABLED` off ⇒ there is no path to offer, so this returns
 * `redirect_unavailable` with the host, exactly as it did before #67. A control
 * pointing at a 404 is worse than a disclosed refusal.
 */

import {
  OUTBOUND_LINK_REL,
  type Offer,
  type ProductPageOutbound,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { affiliateOutboundPath } from '../outbound/disclosure.js';

/**
 * The destination's hostname, or nothing.
 *
 * Parsed with `URL` rather than a regex, and a value that does not parse
 * produces NO host rather than a guess: a malformed destination is exactly the
 * case where a substring match would put something that is not a hostname on
 * screen next to the words "you are going to".
 */
export function destinationHostOf(offer: Offer): string | undefined {
  if (!offer.destinationUrl) return undefined;
  try {
    const parsed = new URL(offer.destinationUrl);
    return parsed.hostname === '' ? undefined : parsed.hostname;
  } catch {
    // A destination the source published that is not a URL. Logged nowhere on
    // purpose — it is per-row, it is the ingestion domain's data-quality
    // problem, and a log line per malformed row on a hot read is a way to fill
    // a disk from a feed.
    return undefined;
  }
}

/**
 * What this offer's action is, for one row.
 *
 * The native branch carries the ids checkout already operates on, and the
 * external branches carry none — which is #71 acceptance 3 ("external offers
 * cannot enter the cart") on this surface: there is no variant id an
 * add-to-cart call could be handed, so the refusal is a shape rather than a
 * check somebody remembers.
 *
 * A native offer never gets an outbound branch either, which is the other half
 * of acceptance 3 ("native offers do not use affiliate redirects"): the switch
 * is on the derived checkout verdict, and an ineligible native offer falls
 * through to `unavailable` rather than to a redirect.
 */
export function resolveProductPageOutbound(offer: Offer): ProductPageOutbound {
  if (offer.checkout.eligible === true) {
    return {
      kind: 'native_checkout',
      listingId: offer.checkout.listingId,
      productVariantId: offer.checkout.productVariantId,
    };
  }

  // A native offer the gate refused. It carries no destination and never will,
  // so the honest reason is that this offer is not purchasable right now —
  // `offer.checkout.reasons` is what says why, and the row renders it.
  if (offer.kind === 'native') {
    return { kind: 'unavailable', reason: 'native_not_purchasable' };
  }

  const destinationHost = destinationHostOf(offer);
  if (destinationHost === undefined) {
    return { kind: 'unavailable', reason: 'no_destination' };
  }

  if (!config.affiliateOutbound.redirectEnabled) {
    return { kind: 'unavailable', reason: 'redirect_unavailable', destinationHost };
  }

  return {
    kind: 'outbound',
    redirectPath: affiliateOutboundPath(offer.id),
    destinationHost,
    // #67 outbound rule 8, READ from the one constant rather than spelled here.
    // Two surfaces compose this handoff — this one and `resolveOutboundDisclosure`
    // — and they take different input types (a DTO and a database row), so the
    // thing that must not exist twice is the VALUE, not the assembly.
    rel: OUTBOUND_LINK_REL,
  };
}
