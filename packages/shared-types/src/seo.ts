/**
 * Public routing and search-engine surface (#75).
 *
 * What a public URL IS, which URL is canonical for a thing, whether that thing
 * may be indexed, and exactly which facts a crawler is told about it.
 *
 * ## The five rules the types hold
 *
 * 1. **A slug is presentation; identity is an id.** {@link SeoRouteIdentity}
 *    has no branch that carries a slug alone as identity — every entity route
 *    resolves an id first and states the canonical spelling afterwards, so a
 *    renamed thing keeps its address and a merged one states its winner.
 * 2. **A page that is not indexable carries no structured data.**
 *    {@link SeoDocument}'s `structuredData` is populated only for an indexable
 *    document, so a thin, suppressed or duplicate page cannot become an
 *    indexing signal by somebody forgetting a check.
 * 3. **An external offer has NO Mercaria URL to be purchased at.**
 *    {@link SeoOfferCheckout} is a two-branch union and only the `mercaria`
 *    branch carries a `url`. There is nothing an emitter could put in
 *    `offers.url` for an external offer, which is the issue's "do not mark an
 *    external offer as purchasable on Mercaria" as a shape rather than a review
 *    comment.
 * 4. **Unknown is never zero and never a soft yes.**
 *    {@link SeoOfferPrice} and {@link SeoOfferAvailability} have no value
 *    property on their unknown branch, so an unpriced offer cannot enter an
 *    `AggregateOffer` and an offer whose stock nobody published cannot be
 *    emitted as `InStock`.
 * 5. **A tracking parameter can never reach a canonical URL.**
 *    {@link SEO_CANONICAL_QUERY_KINDS} and
 *    {@link SEO_NON_CANONICAL_QUERY_KINDS} are DISJOINT tuples (the
 *    `CATALOG_SOURCE_PAYLOAD_FIELDS` device) and the canonical builder accepts
 *    only the first, so `?utm_source=` cannot mint a second address for one
 *    page.
 *
 * The tuples below are closed value sets in the `text` + CHECK sense even
 * though this domain stores nothing: they are what the route registry, the
 * redirect registry and the indexability policy are rendered from, and widening
 * one is a visible code change.
 */

import type { CurrencyCode } from './money';

/* ────────────────────────────────────────────────────────────────────────── */
/* The route registry                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Every public web route Mercaria records a pattern for (#75 §"Route plan").
 *
 * An id, never a path: the path is presentation for the route itself, exactly
 * as a slug is presentation for an entity. Renaming `/p/` would change one
 * table row and every redirect, sitemap and metadata decision would follow.
 */
export type PublicRouteId =
  /** `/` — the storefront home. */
  | 'home'
  /** `/p/:handle` — the canonical product page (#71). */
  | 'canonical_product'
  /** `/families/:handle` — the product line (#72). */
  | 'product_family'
  /** `/brands/:handle` — the brand (#72). */
  | 'brand'
  /** `/merchants/:handle` — the merchant and its storefronts (#73). */
  | 'merchant'
  /** `/stores/:handle` — a NATIVE Mercaria store's own storefront. */
  | 'native_store'
  /** `/m/:handle` — the historical native-store address. Redirect only. */
  | 'native_store_legacy'
  /** `/products/:id` — the legacy native listing detail. */
  | 'legacy_listing'
  /** `/sellers/:oxyUserId` — a P2P seller's public profile (#92). */
  | 'seller'
  /** `/categories/:handle` — category and filtered browse. */
  | 'category_browse';

export const PUBLIC_ROUTE_IDS: readonly PublicRouteId[] = [
  'home',
  'canonical_product',
  'product_family',
  'brand',
  'merchant',
  'native_store',
  'native_store_legacy',
  'legacy_listing',
  'seller',
  'category_browse',
];

/**
 * How a route's single dynamic segment names the thing it addresses.
 *
 * `handle` accepts an id OR the current slug and always resolves the id first;
 * `id` accepts only an id, because the thing has no slug at all (an Oxy account
 * id, a native listing id). There is deliberately no `slug` member — a route
 * that could ONLY be addressed by its current spelling is a route that breaks
 * when the spelling changes, which is the whole of #75 route plan rule 9.
 */
export type SeoRouteIdentity = 'none' | 'id' | 'handle';

export const SEO_ROUTE_IDENTITIES: readonly SeoRouteIdentity[] = ['none', 'id', 'handle'];

/**
 * Whether the storefront actually renders this route today.
 *
 * `planned` is a recorded, reserved pattern with no screen behind it. It is
 * never indexable, never in a sitemap and never served metadata — "unknown is
 * never a soft yes" applied to a route: emitting a title and a canonical tag
 * for an address that renders "This screen does not exist" is worse than
 * emitting nothing.
 *
 * `redirect_only` is a pattern that has no screen ON PURPOSE and never will:
 * every request to it is answered by the redirect registry.
 */
export type SeoRouteAvailability = 'live' | 'planned' | 'redirect_only';

export const SEO_ROUTE_AVAILABILITIES: readonly SeoRouteAvailability[] = [
  'live',
  'planned',
  'redirect_only',
];

/**
 * The four sitemap collections #75 §"Sitemaps and crawling" rule 1 names.
 *
 * Product FAMILIES are deliberately not a fifth. The issue lists four, a family
 * page is reached from its brand's page, and a collection nobody asked for is a
 * crawl budget nobody costed.
 */
export type SeoSitemapCollection = 'products' | 'brands' | 'merchants' | 'categories';

export const SEO_SITEMAP_COLLECTIONS: readonly SeoSitemapCollection[] = [
  'products',
  'brands',
  'merchants',
  'categories',
];

/** One recorded public route pattern. */
export interface PublicRoute {
  readonly id: PublicRouteId;
  /**
   * The pattern, with `:param` for the dynamic segment — the ONE spelling of
   * this path anywhere in the system.
   */
  readonly pattern: string;
  readonly identity: SeoRouteIdentity;
  readonly availability: SeoRouteAvailability;
  /**
   * The expo-router screen that renders it, relative to `packages/frontend`.
   * Absent exactly when `availability` is not `live`.
   */
  readonly screen?: string;
  /** The sitemap this route's entities belong to, when it has one. */
  readonly sitemapCollection?: SeoSitemapCollection;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Query parameters                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A query parameter that is PART of the address (#75 validation rule 5).
 *
 * DISJOINT from {@link SEO_NON_CANONICAL_QUERY_KINDS}, and the canonical URL
 * builder accepts only these — which is what makes "source and merchant
 * tracking parameters must not create duplicate canonical URLs" impossible to
 * get wrong rather than merely forbidden.
 */
export type SeoCanonicalQueryKind =
  /** `?variant=` — a different configuration is a different page. */
  | 'variant'
  /** `?page=` — page 2 of a browse is its own address. */
  | 'page';

export const SEO_CANONICAL_QUERY_KINDS: readonly SeoCanonicalQueryKind[] = ['variant', 'page'];

/**
 * A query parameter that must NEVER appear in a canonical URL.
 *
 * `attribution` survives a redirect (#75 legacy rule 6: attribution is
 * preserved) and `preference` survives one too, because a shopper who chose a
 * currency chose it. `unclassified` survives NOTHING: a parameter nobody has
 * classified may be a token, an email address or a session id, and forwarding
 * it to a new address is exactly the "leaking sensitive query data" the same
 * rule forbids.
 */
export type SeoNonCanonicalQueryKind = 'attribution' | 'preference' | 'unclassified';

export const SEO_NON_CANONICAL_QUERY_KINDS: readonly SeoNonCanonicalQueryKind[] = [
  'attribution',
  'preference',
  'unclassified',
];

/** How one observed query parameter is classified. */
export type SeoQueryKind = SeoCanonicalQueryKind | SeoNonCanonicalQueryKind;

/* ────────────────────────────────────────────────────────────────────────── */
/* Indexability                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Why a page is not indexable — the OPERATOR's answer, never the crawler's.
 *
 * A crawler is told `noindex` and nothing else. This vocabulary is served only
 * from `/internal/seo`, behind the catalogue operator allow-list, and that
 * split is the house rule about a refusal spanning several conditions: a client
 * that could read WHICH input refused could vary one at a time and read the
 * switchboard out of the catalogue.
 *
 * The order below is the order the policy evaluates them in, and the FIRST
 * failing one is the answer.
 */
export type SeoNonIndexableReason =
  /** The rollout lever is not `on` for this entity (#75 acceptance 8). */
  | 'indexing_disabled'
  /** The route has no screen behind it — `planned` or `redirect_only`. */
  | 'route_not_live'
  /** Merged into another entity, or a duplicate of one (#75 policy rule 5). */
  | 'merged_or_duplicate'
  /** Moderation, suppression or a lifecycle status that withdraws the page. */
  | 'suppressed'
  /** A contributing catalogue source withholds its `index` right (policy rule 4). */
  | 'source_withholds_index_right'
  /** Not enough visible content to be worth a result (policy rule 2). */
  | 'thin_content'
  /** No current eligible offer and no historically useful one (policy rule 3). */
  | 'no_offer_information'
  /** The requested locale has no real localized content (policy rule 7). */
  | 'locale_incomplete'
  /** A filter combination with no demand and no unique content (policy rule 8). */
  | 'filter_combination_not_unique';

export const SEO_NON_INDEXABLE_REASONS: readonly SeoNonIndexableReason[] = [
  'indexing_disabled',
  'route_not_live',
  'merged_or_duplicate',
  'suppressed',
  'source_withholds_index_right',
  'thin_content',
  'no_offer_information',
  'locale_incomplete',
  'filter_combination_not_unique',
];

/**
 * The verdict.
 *
 * A STRING discriminant, not a boolean: the backend compiles with
 * `strictNullChecks` off, where TypeScript does not narrow a union on a
 * boolean-literal discriminant at all (`AGENTS.md` §"Rules that span every
 * domain"). The refused branch carries the reason and the indexable one carries
 * nothing, so no caller can read a reason off a page that was accepted.
 */
export type SeoIndexability =
  | { readonly outcome: 'indexable' }
  | { readonly outcome: 'refused'; readonly reason: SeoNonIndexableReason };

/**
 * The rollout lever for INDEXING, distinct from the lever that mounts the
 * routes at all.
 *
 * `off` still composes and serves metadata — a correct title and a correct
 * sharing card are worth having before anybody is invited to index the
 * catalogue — but every document is `noindex` and every sitemap is empty.
 * `canary` indexes only the categories an operator named, which is #75
 * validation rule 4's "small production canary"; an EMPTY canary list indexes
 * nothing, because half-configured is off.
 */
export type SeoIndexingMode = 'off' | 'canary' | 'on';

export const SEO_INDEXING_MODES: readonly SeoIndexingMode[] = ['off', 'canary', 'on'];

/* ────────────────────────────────────────────────────────────────────────── */
/* Redirects                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Why one address answers with another (#75 §"Legacy migration" rule 7).
 *
 * Every member is a durable fact about identity, and none of them is "somebody
 * typed the wrong thing": a redirect registry that grows guesses is a registry
 * that eventually sends a shopper to a different product.
 */
export type SeoRedirectReason =
  /** The entity was merged into another (ADR 0002 D12). */
  | 'merged'
  /** The address named the entity by id, and its canonical spelling is the slug. */
  | 'canonical_spelling'
  /** A retired route pattern with a live successor — `/m/:handle`. */
  | 'retired_route';

export const SEO_REDIRECT_REASONS: readonly SeoRedirectReason[] = [
  'merged',
  'canonical_spelling',
  'retired_route',
];

/**
 * There is deliberately no `query_normalized` member.
 *
 * A tracking parameter must not mint a second canonical address, and the
 * mechanism for that is the `rel=canonical` TAG, not a redirect: stripping
 * `?utm_source=` with a 301 would destroy the attribution the landing page is
 * about to read, which is the other half of #75 legacy rule 6. The tag
 * consolidates the address; the parameter reaches the page.
 */

/**
 * The two HTTP statuses this domain may answer with, and nothing else.
 *
 * 301 for an identity fact that will not change back, 308 for one where the
 * method must survive. There is no 302 member: a temporary redirect on a
 * canonical address teaches a crawler nothing and leaves the old URL indexed.
 */
export type SeoRedirectStatus = 301 | 308;

export const SEO_REDIRECT_STATUSES: readonly SeoRedirectStatus[] = [301, 308];

/** One resolved redirect. */
export interface SeoRedirect {
  readonly status: SeoRedirectStatus;
  /** An absolute-path location on this origin. Never an absolute URL. */
  readonly location: string;
  readonly reason: SeoRedirectReason;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Visible facts — the ONE input metadata and structured data share            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Where a shopper completes this purchase.
 *
 * TWO branches, and only `mercaria` carries a URL. #75 acceptance 4 asks that
 * external and native offer structured data accurately describe where checkout
 * occurs; making the external branch carry a hostname and no address is what
 * makes the accurate description the only one that can be emitted.
 *
 * The hostname is a DISCLOSURE, exactly as it is on the product page itself
 * (#71's outbound seam): it cannot be followed by accident and it cannot carry
 * tracking parameters, because it is not a URL.
 */
export type SeoOfferCheckout =
  | { readonly kind: 'mercaria'; readonly url: string }
  | { readonly kind: 'external'; readonly host: string };

/**
 * An offer's price in ONE currency, or the fact that it has none.
 *
 * The unknown branch has no amount, so an unpriced offer cannot be averaged,
 * summed or emitted — `OfferComparisonPrice`'s device, one layer up.
 */
export type SeoOfferPrice =
  | { readonly known: false }
  | { readonly known: true; readonly amount: number; readonly currency: CurrencyCode };

/**
 * schema.org's availability vocabulary, restricted to the members Mercaria can
 * honestly assert.
 *
 * `Discontinued` is deliberately absent: an offer being unavailable says
 * nothing about the PRODUCT being discontinued, and the two are different
 * facts about different subjects.
 */
export type SeoSchemaAvailability =
  | 'https://schema.org/InStock'
  | 'https://schema.org/OutOfStock'
  | 'https://schema.org/PreOrder';

export const SEO_SCHEMA_AVAILABILITIES: readonly SeoSchemaAvailability[] = [
  'https://schema.org/InStock',
  'https://schema.org/OutOfStock',
  'https://schema.org/PreOrder',
];

/**
 * What the page says about whether the thing can be had.
 *
 * The unknown branch carries no value, so `availability: 'unknown'` on an offer
 * cannot silently become `InStock` — the coercion `deriveOfferCondition`
 * refuses one domain over, applied to stock.
 */
export type SeoOfferAvailability =
  | { readonly known: false }
  | { readonly known: true; readonly schema: SeoSchemaAvailability };

/** One offer, exactly as the page displays it. */
export interface SeoVisibleOffer {
  readonly offerId: string;
  readonly checkout: SeoOfferCheckout;
  readonly price: SeoOfferPrice;
  readonly availability: SeoOfferAvailability;
  /** The seller's display name, when the page names one. */
  readonly sellerName?: string;
  /** The #90 condition key the row is grouped under, when the source published one. */
  readonly conditionKey?: string;
}

/** One crumb of the trail the page renders. */
export interface SeoBreadcrumb {
  readonly name: string;
  /** An absolute-path URL on this origin. */
  readonly path: string;
}

/** A rating the page displays, with the scope it was computed over. */
export interface SeoVisibleRating {
  readonly value: number;
  readonly count: number;
}

/**
 * Everything a page displays that its metadata and its structured data may
 * repeat — and nothing else.
 *
 * ONE value, built once from the same read the page renders, consumed by BOTH
 * the `<head>` composer and the JSON-LD builder. That is #75 validation rule 1
 * ("unit-test JSON-LD shape and visible-fact parity") as an architecture rather
 * than a test: a fact that is not in here cannot be emitted, so parity is not
 * something the emitters have to remember.
 */
export interface SeoVisibleFacts {
  /** What the page is about, in one line. */
  readonly title: string;
  /** The page's own summary. Absent when the entity has no description. */
  readonly description?: string;
  /** Images the page shows, in display order. Absolute URLs. */
  readonly imageUrls: readonly string[];
  readonly breadcrumbs: readonly SeoBreadcrumb[];
  /** The entity's name as the page's heading renders it. */
  readonly entityName: string;
  /** The brand the page names, when it names one. */
  readonly brandName?: string;
  /** GTIN-shaped identifiers the page displays. */
  readonly gtins: readonly string[];
  /** The manufacturer's own model code, when the page shows one. */
  readonly mpn?: string;
  readonly rating?: SeoVisibleRating;
  /**
   * The offers the page currently shows, in the order it shows them.
   *
   * EMPTY means the page displays no offer — because there is none, or because
   * the offers half is withheld. The two are different sentences on the page
   * and the same silence here, which is correct: structured data may only
   * repeat what is visible, and a withheld comparison displays nothing.
   */
  readonly offers: readonly SeoVisibleOffer[];
  /** The currency every priced offer above is expressed in. */
  readonly offerCurrency?: CurrencyCode;
  /** Configurations the page's selector lists, when it has one. */
  readonly variantNames: readonly string[];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The document                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/** One `hreflang` alternate, emitted only when real localized content exists. */
export interface SeoLocaleAlternate {
  /** A BCP-47 tag. */
  readonly hreflang: string;
  /** An absolute URL. */
  readonly href: string;
}

/** The Open Graph and Twitter card facts, all of them derived from the page. */
export interface SeoSharingMetadata {
  readonly title: string;
  readonly description?: string;
  /** `website` for the home page, `product` for a product page. */
  readonly type: 'website' | 'product';
  readonly url: string;
  /** An absolute image URL. Absent when the page displays no image. */
  readonly imageUrl?: string;
  readonly siteName: string;
}

/**
 * A JSON-LD value tree.
 *
 * Typed as data rather than as one interface per schema.org type: the emitter
 * builds a small, closed set of shapes and the SHAPE tests assert them, so a
 * second type declaration here would be a copy to keep in step with a
 * vocabulary Mercaria does not own.
 */
export type SeoJsonLdValue =
  | string
  | number
  | boolean
  | readonly SeoJsonLdValue[]
  | { readonly [key: string]: SeoJsonLdValue };

export interface SeoJsonLdNode {
  readonly [key: string]: SeoJsonLdValue;
}

/**
 * Everything a server-rendered `<head>` needs for one public URL.
 *
 * `structuredData` is EMPTY whenever `indexable` is false. Structured data is
 * an indexing signal, and attaching one to a page policy has withdrawn would be
 * asking for exactly the outcome the policy exists to prevent.
 */
export interface SeoDocument {
  readonly routeId: PublicRouteId;
  readonly title: string;
  readonly description?: string;
  /** The ONE address this page is indexed under. Absolute. */
  readonly canonicalUrl: string;
  readonly indexable: boolean;
  /** The `robots` content string, e.g. `index,follow` or `noindex,follow`. */
  readonly robots: string;
  readonly sharing: SeoSharingMetadata;
  readonly breadcrumbs: readonly SeoBreadcrumb[];
  readonly localeAlternates: readonly SeoLocaleAlternate[];
  readonly structuredData: readonly SeoJsonLdNode[];
}

/**
 * What one public URL resolves to.
 *
 * Four outcomes and no fifth, and the last two are genuinely different
 * instructions to the edge:
 *
 *  - `not_found` — the address named a thing that does not exist. The shell is
 *    still served (the app renders its own not-found screen) with status 404,
 *    so a crawler is told the truth instead of collecting a soft 404.
 *  - `no_document` — the address is a real page and Mercaria publishes no
 *    server-rendered metadata for it. The shell is served UNCHANGED, at
 *    whatever status the asset pipeline gave it. A seller profile is the case:
 *    #92 derives its visibility per request from Oxy's own privacy and trust
 *    state, and a title composed here would either duplicate that decision or
 *    outlive it.
 *
 * Neither carries a reason, the same split the indexability vocabulary is
 * under: a crawler learns what the address is, and an operator asks
 * `/internal/seo` why.
 */
export type SeoResolution =
  | { readonly outcome: 'document'; readonly document: SeoDocument }
  | { readonly outcome: 'redirect'; readonly redirect: SeoRedirect }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'no_document' };

/* ────────────────────────────────────────────────────────────────────────── */
/* Sitemaps and robots                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/** One URL in a sitemap. */
export interface SeoSitemapEntry {
  /** Absolute URL. */
  readonly loc: string;
  /**
   * The last MEANINGFUL public change, as an ISO-8601 instant.
   *
   * Never an offer poll and never a `last_seen_at` touch — #75 sitemap rule 2.
   * Absent when nothing dateable is known, because a `lastmod` of "now" on
   * every regeneration is a lie that costs crawl budget.
   */
  readonly lastmod?: string;
}

/** One child sitemap named by the index. */
export interface SeoSitemapIndexEntry {
  readonly collection: SeoSitemapCollection;
  /** 1-based. */
  readonly page: number;
  readonly loc: string;
  readonly lastmod?: string;
}

/**
 * The paths robots are told to stay out of.
 *
 * ONE authority, rendered into the served `robots.txt` and asserted against the
 * static asset the storefront ships for the flag-off state — two artefacts,
 * one list, and a test that fails when they disagree.
 */
export const SEO_ROBOTS_DISALLOWED_PATHS: readonly string[] = [
  // Internal search: infinite, thin and duplicative of the browse pages.
  '/search',
  // Grounded comparison (#96): one page per shopper-assembled TUPLE of
  // products, and its `?watchlist=` names a private list (#81).
  '/compare',
  // The account and commerce funnel: private, and nothing in it is a landing page.
  '/settings/',
  '/cart',
  '/checkout',
  '/orders',
  // The "Sell yours" flow (#91): an authenticated draft-in-progress, reached
  // only from a credential, and never a landing page a crawler should find.
  '/sell',
  '/saved',
  '/watchlists',
  '/notifications',
  '/price-alerts',
  '/guest-orders/',
  '/forgot-password',
  '/reset-password',
  // The outbound affiliate redirect (#37) — a crawler following one would spend
  // Mercaria's crawl budget on somebody else's site and burn an affiliate click.
  '/out/',
  // Operator surfaces. Behind an allow-list already; a crawler has no business
  // discovering that they exist.
  '/internal/',
];
