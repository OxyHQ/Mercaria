/**
 * The eBay endpoints, headers and hosts — issue #65, every one a CODE CONSTANT.
 *
 * ## Why none of these is configurable
 *
 * A base URL read from the environment is an SSRF surface with an operator's
 * name on it: a deployment variable pointed at somebody else's host would send
 * Mercaria's OAuth credential there, and nothing downstream could tell. The
 * hosts eBay serves from are a fact about eBay, not about a deployment, so they
 * are compiled in and `EBAY_ALLOWED_HOSTS` is what the transport checks every
 * URL against before it opens a socket.
 *
 * The `STRIPE_API_VERSION` decision, one domain over, and for the same reason:
 * a version variable can only ever disagree with the code that parses the
 * response.
 */

import type { EbayEnvironment } from '@mercaria/shared-types';

/** The API host per environment. Production and sandbox are different key spaces. */
export const EBAY_API_HOST: Readonly<Record<EbayEnvironment, string>> = {
  production: 'api.ebay.com',
  sandbox: 'api.sandbox.ebay.com',
};

/**
 * Every host this integration may open a connection to, ever.
 *
 * The transport refuses anything else BEFORE resolving DNS. Both environments
 * are listed because a deployment configures one and a test drives the other,
 * and an allow-list that changed shape between them would be a check with two
 * behaviours.
 */
export const EBAY_ALLOWED_HOSTS: readonly string[] = [
  EBAY_API_HOST.production,
  EBAY_API_HOST.sandbox,
];

/** The client-credentials token endpoint path. */
export const EBAY_TOKEN_PATH = '/identity/v1/oauth2/token';

/** The Browse API paths this integration uses. There are exactly two. */
export const EBAY_BROWSE_SEARCH_PATH = '/buy/browse/v1/item_summary/search';
export const EBAY_BROWSE_GET_ITEMS_PATH = '/buy/browse/v1/item';

/**
 * The OAuth scope a client-credentials token is minted for.
 *
 * The Browse API's public data needs exactly this one. Asking for more would be
 * asking for authority this integration has no use for, which is how a
 * credential leak becomes a bigger incident than it had to be.
 */
export const EBAY_BROWSE_SCOPE = 'https://api.ebay.com/oauth/api_scope';

/** The header that selects a marketplace. Every Browse call carries one. */
export const EBAY_MARKETPLACE_HEADER = 'X-EBAY-C-MARKETPLACE-ID';

/**
 * The header that carries EPN attribution.
 *
 * `affiliateCampaignId=<10-digit EPN id>,affiliateReferenceId=<free-form>`.
 * Passing it is what makes every response carry `itemAffiliateWebUrl`; NOT
 * passing it is what makes eBay answer with plain item URLs. Those are the only
 * two outcomes, and neither of them is a URL Mercaria composed.
 */
export const EBAY_ENDUSERCTX_HEADER = 'X-EBAY-C-ENDUSERCTX';

/**
 * How long before a token's stated expiry it is treated as expired.
 *
 * A token that expires between the check and the response is a 401 on a call
 * the budget already paid for. Ninety seconds is longer than any Browse call
 * and shorter than the two hours eBay issues them for.
 */
export const EBAY_TOKEN_EXPIRY_SKEW_MS = 90_000;

/** The ceiling on one provider response body. Bounds memory, not correctness. */
export const EBAY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Per-request deadline. Longer than eBay's own p99 and shorter than a lease. */
export const EBAY_REQUEST_TIMEOUT_MS = 20_000;

/**
 * The `fieldgroups` a search asks for.
 *
 * `EXTENDED` is what makes `shortDescription` and the additional item facts
 * appear on a summary; without it a discovery sweep produces titles and prices
 * and the matcher has almost nothing deterministic to work with.
 */
export const EBAY_SEARCH_FIELDGROUPS = 'EXTENDED';
