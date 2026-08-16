/**
 * The outbound storefront action — #73 storefront-navigation rule 4, and a
 * NAMED SEAM that fails closed.
 *
 * The rule asks that an external storefront action link to the real destination
 * "through #67". #67 — the outbound/affiliate redirect — is BUILT, but its
 * token names exactly one thing, an OFFER (`AffiliateOutboundTokenClaims` has
 * one member and it is an offer id) — a channel visit is not an offer click,
 * so there is no shape of #67's existing token this could mint. Every source
 * domain in this repository (#57, #62, #65, #66, #68) already stores its
 * destination URL VERBATIM and refuses to compose a tracked one, each naming
 * #37/#67 as the owner. So there is nothing here to route through, and the
 * honest shape is a refusal that publishes the contract rather than a link that
 * silently loses attribution.
 *
 * ## The refusal is the TYPE, not a branch
 *
 * `MerchantChannelOutbound`'s `unavailable` variant has no `url` property
 * at all, so a client cannot read a destination out of a refusal and a future
 * caller cannot "just return the public URL here" without changing the type in
 * a diff somebody reviews. The untracked `storefront.publicUrl` remains a
 * separate, plainly-named field on the channel: it is the retailer's own site,
 * it carries no tracking parameters, and linking to it asserts no commercial
 * arrangement.
 *
 * Closing this seam is one function body plus whatever #67 needs to identify
 * a CHANNEL visit rather than an offer click — nothing else in #73 changes.
 */

import type { MerchantChannelOutbound } from '@mercaria/shared-types';

/**
 * Whether a tracked outbound link to this channel can be produced. It cannot.
 *
 * The signature takes the storefront id so #67 has the argument it will need,
 * and the body ignores it — which is what makes this a seam with a shape rather
 * than a stub that lies about having looked at anything.
 */
export function resolveChannelOutbound(_storefrontId: string): MerchantChannelOutbound {
  return { outcome: 'unavailable', reason: 'outbound_redirect_not_built' };
}
