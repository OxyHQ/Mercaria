/**
 * What a row's primary action does (#71 actions 1 and 2) — and the ONE seam
 * this issue leaves open.
 *
 * ## The seam, stated plainly
 *
 * #37's outbound redirect (`/out/:token`) is NOT built in this repository.
 * Issue #67, which specifies it, was auto-closed by a keyword in #66's pull
 * request body; the code it describes does not exist, and `services/offers/`,
 * `services/awin/` and `services/ebay/` all still name it as deferred.
 *
 * So this module REFUSES every external handoff, unconditionally, and names the
 * issue that owes it. That is a deliberate choice over the two alternatives:
 *
 * - **Linking straight to `offer.destinationUrl`** would assert at RENDER time
 *   what only a click can establish. #68 built `assertOfferOutboundEligible`
 *   precisely because a buyer leaves a product page open for an hour, and the
 *   offer that was current when it rendered is the one that is not current when
 *   they finally click; a raw link cannot re-check anything. It would also
 *   discard the commercial relationship an `affiliate` offer exists under,
 *   silently and with no error anywhere.
 * - **Building the redirect here** would be #37's route with none of what makes
 *   it safe: no signed token, no click record, no bot handling, no
 *   loop/open-redirect defence and no affiliate composition. Two places
 *   deciding where Mercaria may send a browser is the shape an open redirect
 *   takes.
 *
 * What the page CAN still do is everything a shopper needs in order to decide:
 * the merchant, the channel, the price, the delivery facts, the condition, the
 * freshness and the destination HOST. A hostname is a disclosure, not a link —
 * it cannot be followed by accident and it cannot carry tracking parameters,
 * because it is not a URL.
 *
 * ## What #37 changes, exactly
 *
 * The `outbound` branch of {@link ProductPageOutbound} and this file's one
 * refusal. `redirectPath` is a MERCARIA path by type, so nothing here can ever
 * become a merchant URL or a composed tracking URL, whatever fills it in.
 */

import type { Offer, ProductPageOutbound } from '@mercaria/shared-types';

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

  return { kind: 'unavailable', reason: 'redirect_unavailable', destinationHost };
}
