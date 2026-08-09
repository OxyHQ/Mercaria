/**
 * The eBay Browse catalog source's vocabulary — issue #65, the provider #64
 * selected for the broad-marketplace slot.
 *
 * Everything here is a CLOSED value set the schema's CHECK constraints are
 * rendered from (`text` + CHECK, never a pg enum — `db/schema/CONVENTIONS.md`),
 * or a table of provider facts that must be identical in the adapter, in the
 * documentation and in the tests. Adding a value is a code change plus an
 * additive migration in the same PR.
 *
 * ## Why a provider file exists at all, when #62 is provider-neutral
 *
 * #62's framework deliberately knows nothing about any provider, and #65 adds
 * no schema fork to it (issue #62 acceptance 7). What it does add is the
 * machinery eBay's own contract demands and no other source needs: a
 * per-APPLICATION daily call budget, a search-driven discovery surface, and a
 * verification pass that is the only thing entitled to conclude an item is gone.
 *
 * ## The two disjoint unions, and what they make unrepresentable
 *
 * {@link EBAY_OUTBOUND_DESTINATION_KINDS} names the only two addresses Mercaria
 * may ever send a buyer to for an eBay item, and
 * {@link EBAY_FORBIDDEN_LINK_OPERATIONS} names the things that may never become
 * a third — the `RetailCostComponentKind` / `RetailForbiddenComponentKind`
 * device (#120), applied to the one place an affiliate integration realistically
 * breaks its network agreement: somebody composing a tracking URL by hand.
 */

import type { ItemConditionKey } from './condition';

/** The adapter slug `catalog_source_configs.provider` holds for this source. */
export const EBAY_BROWSE_PROVIDER = 'ebay_browse';

/**
 * The eBay marketplaces this integration is built for — #64's launch set.
 *
 * Spain first, then DE/FR/IT/GB, which are the markets ADR-adjacent decision
 * §2 names and all of which the Browse API supports. The tuple is closed
 * because every member costs a rights review, an EPN campaign and a category
 * cohort; a marketplace nobody reviewed is a marketplace Mercaria has no terms
 * for. `EBAY_MARKETS` narrows it further at runtime and can never widen it.
 */
export const EBAY_MARKETPLACE_IDS = [
  'EBAY_ES',
  'EBAY_DE',
  'EBAY_FR',
  'EBAY_IT',
  'EBAY_GB',
] as const;

export type EbayMarketplaceId = (typeof EBAY_MARKETPLACE_IDS)[number];

/**
 * The ISO 3166-1 alpha-2 market each marketplace serves.
 *
 * A `Record` over the tuple rather than a lookup with a fallback, so adding a
 * marketplace above without deciding its country is a `tsc` error. The country
 * is what reaches `offers.country` and what `catalog_source_configs.territories`
 * is checked against — a marketplace whose country is guessed would put German
 * offers in a Spanish cohort.
 */
export const EBAY_MARKETPLACE_COUNTRY: Readonly<Record<EbayMarketplaceId, string>> = {
  EBAY_ES: 'ES',
  EBAY_DE: 'DE',
  EBAY_FR: 'FR',
  EBAY_IT: 'IT',
  EBAY_GB: 'GB',
};

/**
 * The host each marketplace's public item pages live on.
 *
 * Used for NOTHING but the storefront row's `domain` and `public_url`: the
 * destination Mercaria stores is always an address the API returned, never one
 * composed from this table. See {@link EBAY_FORBIDDEN_LINK_OPERATIONS}.
 */
export const EBAY_MARKETPLACE_HOST: Readonly<Record<EbayMarketplaceId, string>> = {
  EBAY_ES: 'www.ebay.es',
  EBAY_DE: 'www.ebay.de',
  EBAY_FR: 'www.ebay.fr',
  EBAY_IT: 'www.ebay.it',
  EBAY_GB: 'www.ebay.co.uk',
};

/** Which eBay environment a deployment's keyset belongs to. */
export const EBAY_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type EbayEnvironment = (typeof EBAY_ENVIRONMENTS)[number];

/**
 * How a discovery query names what to look for.
 *
 * eBay's Browse API permits SEARCH-driven discovery and publishes no bulk
 * catalogue export at all (the Feed API is Limited Release and outside #64's
 * decision). So Mercaria's "catalogue" of an eBay marketplace is exactly the
 * union of the queries an operator configured, and this tuple is the whole of
 * what a query may be. There is deliberately no `all` member: a value meaning
 * "everything eBay sells" would be a capability the provider does not grant,
 * which is the simulation issue #65 forbids in as many words.
 */
export const EBAY_DISCOVERY_QUERY_KINDS = ['category', 'keyword'] as const;
export type EbayDiscoveryQueryKind = (typeof EBAY_DISCOVERY_QUERY_KINDS)[number];

/**
 * The two addresses Mercaria may send a buyer to, and nothing else.
 *
 * `affiliate` is `itemAffiliateWebUrl` exactly as the Browse API minted it under
 * the EPN campaign id passed in `X-EBAY-C-ENDUSERCTX`; `plain` is `itemWebUrl`,
 * the unattributed View Item page. Both come back IN a response body. A third
 * member would have to be a URL somebody built, which is what
 * {@link EBAY_FORBIDDEN_LINK_OPERATIONS} exists to say Mercaria does not do.
 */
export const EBAY_OUTBOUND_DESTINATION_KINDS = ['affiliate', 'plain'] as const;
export type EbayOutboundDestinationKind = (typeof EBAY_OUTBOUND_DESTINATION_KINDS)[number];

/**
 * Operations on an eBay outbound link that may never exist in this codebase.
 *
 * DISJOINT from {@link EBAY_OUTBOUND_DESTINATION_KINDS} by a gate, so a
 * plausible future addition to the destination set that happens to be a
 * construction fails the build. The tuple is not the enforcement — the
 * discriminated union and the scanned gate in
 * `ebay-attribution-isolation.test.ts` are — and this is the statement of the
 * prohibition as a VALUE, which makes "Mercaria never mints or mutates EPN
 * tracking parameters" checkable rather than a claim in a comment.
 *
 * The reason is the EPN Network Agreement, not tidiness: commission attribution
 * lives entirely in the parameters eBay put in that URL, and a mutated link is
 * indistinguishable from an unattributed one until a month of revenue is
 * missing.
 */
export const EBAY_FORBIDDEN_LINK_OPERATIONS = [
  'compose_tracking_url',
  'append_campaign_parameter',
  'rewrite_campaign_parameter',
  'strip_tracking_parameter',
  'substitute_marketplace_host',
  'shorten_destination',
] as const;
export type EbayForbiddenLinkOperation = (typeof EBAY_FORBIDDEN_LINK_OPERATIONS)[number];

/**
 * eBay's own `conditionId` enumeration, as the Browse API publishes it.
 *
 * These IDS are what the adapter carries into `offers.condition_source_label`,
 * and the DISPLAY text (`condition`) deliberately is not: the display text is
 * LOCALIZED per marketplace — "Used" on EBAY_GB and "Usado" on EBAY_ES for the
 * identical `3000` — so a #90 mapping ruleset keyed on it would need one rule
 * per language per condition and would silently produce `unmapped` for every
 * market nobody wrote rules for. The id is stable across marketplaces and
 * locales, which is the only property a lookup key needs.
 */
export const EBAY_CONDITION_IDS = [
  '1000',
  '1500',
  '2000',
  '2010',
  '2020',
  '2030',
  '2500',
  '2750',
  '3000',
  '4000',
  '5000',
  '6000',
  '7000',
] as const;
export type EbayConditionId = (typeof EBAY_CONDITION_IDS)[number];

/**
 * One recommended #90 mapping rule for one eBay condition id.
 *
 * `name` is eBay's English name for the id and exists so an operator reading the
 * review queue or publishing the ruleset can tell `2030` from `2020`; it is
 * documentation, never a lookup key.
 */
export interface EbayConditionRule {
  readonly conditionId: EbayConditionId;
  readonly name: string;
  readonly conditionKey: ItemConditionKey;
  readonly confidence: number;
}

/**
 * The mapping ruleset an operator PUBLISHES through #90's own operator surface
 * before eBay offers can carry a condition key.
 *
 * It is a recommendation and not an enforcement, which is #90's arrangement
 * working rather than a gap: `condition_mapping_rulesets` rows are published by
 * a named operator on a date, and a ruleset this file wrote into a migration
 * would be a policy nobody signed. Until it is published every eBay offer is
 * `unmapped` with its `conditionId` preserved — the fail-closed direction, and
 * exactly what #90's "the source published words nothing matched" state is for.
 *
 * The confidences are not decoration. `1000`/`3000` are unambiguous statements
 * from a closed enumeration and sit well above
 * `CONDITION_MAPPING_CONFIDENCE_FLOOR`; `2750` ("Like New") and `1500` ("New
 * other") describe a range of real conditions and sit BELOW it deliberately, so
 * #90 records them as `review_pending` and no product page ever claims them.
 * That is issue #65's condition requirement meeting #90's rule that a
 * low-confidence source mapping can never carry a key.
 */
export const EBAY_RECOMMENDED_CONDITION_RULES: readonly EbayConditionRule[] = [
  { conditionId: '1000', name: 'New', conditionKey: 'new', confidence: 0.99 },
  { conditionId: '1500', name: 'New other (see details)', conditionKey: 'open_box', confidence: 0.6 },
  {
    conditionId: '2000',
    name: 'Certified - Refurbished',
    conditionKey: 'refurbished_manufacturer',
    confidence: 0.9,
  },
  {
    conditionId: '2010',
    name: 'Excellent - Refurbished',
    conditionKey: 'refurbished_seller',
    confidence: 0.85,
  },
  {
    conditionId: '2020',
    name: 'Very Good - Refurbished',
    conditionKey: 'refurbished_seller',
    confidence: 0.85,
  },
  {
    conditionId: '2030',
    name: 'Good - Refurbished',
    conditionKey: 'refurbished_seller',
    confidence: 0.85,
  },
  {
    conditionId: '2500',
    name: 'Seller refurbished',
    conditionKey: 'refurbished_seller',
    confidence: 0.9,
  },
  { conditionId: '2750', name: 'Like New', conditionKey: 'used_like_new', confidence: 0.65 },
  { conditionId: '3000', name: 'Used', conditionKey: 'used_good', confidence: 0.8 },
  { conditionId: '4000', name: 'Very Good', conditionKey: 'used_good', confidence: 0.85 },
  { conditionId: '5000', name: 'Good', conditionKey: 'used_fair', confidence: 0.8 },
  { conditionId: '6000', name: 'Acceptable', conditionKey: 'used_poor', confidence: 0.85 },
  {
    conditionId: '7000',
    name: 'For parts or not working',
    conditionKey: 'for_parts',
    confidence: 0.98,
  },
];

/**
 * What one reconciliation sample concluded — issue #65 reliability 7.
 *
 * A sweep re-reads a representative sample of tracked items STRAIGHT from the
 * provider and compares the answer against what Mercaria is serving. Each
 * finding is a different action: `price_drift` and `availability_drift` mean the
 * refresh cadence is too slow for this cohort, `vanished` means the deletion
 * obligation is running late, `condition_drift` means a mapping ruleset moved
 * under stored offers, and `affiliate_attribution_missing` means the EPN
 * approval or campaign id stopped working — which produces no error anywhere
 * else, because an unattributed link is a perfectly good link.
 *
 * `unreadable` is kept apart from `vanished` on purpose: an item eBay refused to
 * answer for is not an item eBay says is gone, and collapsing them would let a
 * transient outage read as a deletion obligation nobody met.
 */
export const EBAY_RECONCILIATION_FINDINGS = [
  'agrees',
  'price_drift',
  'availability_drift',
  'condition_drift',
  'affiliate_attribution_missing',
  'vanished',
  'unreadable',
] as const;
export type EbayReconciliationFinding = (typeof EBAY_RECONCILIATION_FINDINGS)[number];

/** The findings that mean something is WRONG, as opposed to merely observed. */
export const EBAY_RECONCILIATION_DISCREPANCY_FINDINGS: readonly EbayReconciliationFinding[] = [
  'price_drift',
  'availability_drift',
  'condition_drift',
  'affiliate_attribution_missing',
  'vanished',
];

/**
 * The default daily call allowance of one production Browse keyset.
 *
 * eBay publishes 5,000 calls/day per application, raised only through the free
 * application growth check. It is a DEFAULT rather than a constant because the
 * growth check really does raise it and a granted allowance nobody could record
 * would make the budget refuse calls eBay would have served; `ebay_call_budgets`
 * stores the limit each day was measured against, so a raise is visible in the
 * evidence rather than only in an environment variable.
 */
export const EBAY_DEFAULT_DAILY_CALL_LIMIT = 5_000;

/**
 * The largest number of item ids one `getItems` call may carry.
 *
 * eBay's own cap. It is what makes the verification pass affordable — one call
 * clears twenty tracked items — and it is why the pass is expressed in item ids
 * rather than in pages of search results.
 */
export const EBAY_GET_ITEMS_MAX_IDS = 20;

/**
 * The largest `limit` the Browse `search` operation accepts.
 *
 * The framework hands the adapter `catalog_source_configs.page_size`, which is
 * Mercaria's bound on a page and knows nothing about eBay; the adapter clamps to
 * this, because a request over the cap is answered with an error rather than
 * with fewer results.
 */
export const EBAY_SEARCH_MAX_LIMIT = 200;

/**
 * How deep the Browse `search` offset may go.
 *
 * eBay refuses an `offset` beyond 10,000, so a discovery query can never
 * enumerate more than that many items however many pages are asked for. This is
 * the single hardest fact about eBay as a catalogue source and the reason a
 * discovery sweep may NEVER report a complete enumeration: the provider is
 * telling you, in an error code, that you have not seen everything.
 */
export const EBAY_SEARCH_MAX_OFFSET = 10_000;
