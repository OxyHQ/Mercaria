/**
 * The canonical product page (#71, ADR 0002 D6/D8/D18/D24).
 *
 * ONE page that explains a product and every eligible way to acquire it —
 * native Mercaria checkout, an official brand channel, an ordinary retailer, a
 * refurbished unit, somebody's used copy — without any of them being mistaken
 * for another.
 *
 * ## What this file is NOT
 *
 * It is not a second catalogue projection and it is not a second ranking. Every
 * fact it carries is produced by a domain that already owns it: identity by
 * #56's `CanonicalProduct`, the order and the labels by #74's
 * `RankedOfferComparison`, an offer's terms by #57's `Offer`, freshness by
 * #68's assessment, condition by #90's taxonomy, badges by #55's verified
 * relationships. What #71 adds is the COMPOSITION — one read, at one instant,
 * with the identities an offer row needs resolved beside it.
 *
 * The composition is the point. A client that fetched the ranked ids from one
 * endpoint and the offer rows from another would be joining two different
 * moments, and the failure mode is silent: a ranked offer whose row is missing
 * from the other page's window simply does not render, so the shopper sees a
 * comparison with holes in it and nothing anywhere says so.
 *
 * ## The four rules the types hold
 *
 * 1. **An offer appears in exactly ONE group.** {@link ProductPageOfferGroupKey}
 *    partitions the served rows by CONDITION (with the `new` segment split on
 *    verified official standing), and a highlight is a POINTER — an offer id
 *    plus the #74 award that earned it — never a copy of the row. That is
 *    #71's "must not duplicate the same offer in misleading ways" as a shape
 *    rather than a review comment.
 * 2. **Withheld is not empty.** {@link ProductPageOffers} is a discriminated
 *    union whose withheld branch has no rows and no comparison to read: a
 *    deployment that has turned offer comparison off must not render as a
 *    product nobody sells. An eligible set that is genuinely empty is the
 *    `available` branch with no rows, and the two are different answers.
 * 3. **An unknown condition is its own group.** `condition_unknown` exists
 *    because the alternative is putting an unlabelled feed item under "New",
 *    which tells a shopper it is factory-sealed — the exact coercion
 *    `deriveOfferCondition` refuses one layer down.
 * 4. **The outbound handoff is a NAMED SEAM that fails closed.**
 *    {@link ProductPageOutbound}'s unavailable branch carries no destination,
 *    so a client cannot send anybody anywhere by forgetting a check. #37's
 *    redirect is what re-checks freshness and rights at CLICK time; a page that
 *    linked straight to a stored destination would be asserting at render time
 *    something only the click can establish.
 */

import type { CurrencyCode, FxRateSnapshot } from './money';
import type { CanonicalProduct, CanonicalVariant } from './canonical-product';
import type { Offer } from './offer';
import type {
  OfferComparisonExperience,
  OfferComparisonIntent,
  OfferLabelAward,
  RankedOffer,
  RankingPolicy,
} from './offer-ranking';

/* ────────────────────────────────────────────────────────────────────────── */
/* Identity and redirects                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The handle a page was asked for was not this product's own (ADR 0002 D12).
 *
 * A merged product keeps its row as a tombstone pointing at its winner, and its
 * slug is never reused — so an old link resolves, and the client owes the
 * shopper a URL that says what they are actually looking at. The server states
 * the canonical handle and the client replaces the URL; the HTTP-level 301 and
 * the `rel=canonical` tag are #75's, which owns public routing and SEO.
 *
 * There is deliberately no `reason` enum. The one way this arises today is a
 * merge chain — aliases are search input and never identity (D12), so nothing
 * else resolves to a different row — and a one-member vocabulary is a value
 * nobody can act on.
 */
export interface ProductPageRedirect {
  /** Exactly what the caller asked for. */
  readonly requestedHandle: string;
  /** The product's own slug — what the URL should say. */
  readonly canonicalHandle: string;
  readonly canonicalProductId: string;
}

/**
 * One configuration a shopper can select, projected for the selector.
 *
 * The FULL {@link CanonicalVariant} is not shipped: a forty-configuration
 * product would carry forty copies of every identifier, image and provenance
 * row for a control that renders a name and a set of options. A variant page
 * that needs the rest reads `/canonical-products/:idOrSlug/variants`.
 */
export interface ProductPageVariant {
  readonly id: string;
  readonly name?: string;
  readonly isDefault: boolean;
  readonly options: CanonicalVariant['options'];
  /**
   * How many of the SERVED offers price this configuration. Never a stock count.
   *
   * ABSENT when the offers half is withheld, and that is the same rule
   * {@link ProductPageOffers} holds one level up: a zero on a page that is not
   * answering the offers question reads as "nobody sells this configuration",
   * which is exactly the sentence the withheld branch exists to prevent.
   */
  readonly offerCount?: number;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Seller identity                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Who is selling, resolved for one offer row (#71 offer row 1, relationships 6).
 *
 * A UNION with no common `id` field, the `CommerceActor` device: a native
 * offer's seller is a Mercaria store or a person with an Oxy account, and an
 * external offer's is a canonical merchant on a canonical storefront. Those are
 * different identities with different public pages, and a single `sellerId`
 * would be the field that eventually links a person's Oxy id into a merchant
 * route.
 *
 * `unknown` is a real member. A native listing whose store was deleted and an
 * external offer naming a merchant this read could not resolve both produce it,
 * and the row then names no seller rather than inventing one.
 */
export type ProductPageSeller =
  | {
      readonly kind: 'merchant';
      readonly merchantId: string;
      readonly name: string;
      readonly slug: string;
      /** The channel the offer is published on, when the offer names one. */
      readonly storefront?: {
        readonly id: string;
        readonly name: string;
        readonly slug: string;
        /** The channel's own hostname, for the disclosure a click needs. */
        readonly domain?: string;
      };
      /**
       * Whether the seller of record IS the channel's operator (ADR 0002 D8).
       *
       * Carried from {@link Offer.sellerRole} so a row can say "sold by X on
       * Y's marketplace" — which is who a buyer's warranty is with.
       */
      readonly marketplaceSeller: boolean;
    }
  | {
      readonly kind: 'native_store';
      readonly storeId: string;
      readonly name: string;
      /** The public storefront handle — `/stores/:handle`. */
      readonly handle: string;
    }
  | {
      readonly kind: 'native_person';
      /** Oxy owns identity; this is the id `/sellers/:oxyUserId` is keyed on. */
      readonly oxyUserId: string;
      readonly displayName: string;
    }
  | { readonly kind: 'unknown' };

/* ────────────────────────────────────────────────────────────────────────── */
/* The outbound seam                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/** Why an external offer cannot be followed from this page today. */
export type ProductPageOutboundUnavailableReason =
  /**
   * #37's outbound redirect is not built in this deployment.
   *
   * The page deliberately does NOT fall back to the stored `destinationUrl`.
   * #68's `assertOfferOutboundEligible` exists precisely because an offer that
   * was current when a page rendered is the one that is not current when
   * somebody finally clicks it, and only a redirect route can re-check at click
   * time. A raw link would also discard the commercial relationship an
   * `affiliate` offer exists under, silently.
   */
  | 'redirect_unavailable'
  /** The offer names no destination at all — an `informational` observation. */
  | 'no_destination'
  /**
   * A NATIVE offer whose checkout verdict refuses right now.
   *
   * Its own reason rather than `no_destination`, which would be true of a
   * native offer (they never carry one) and would tell a shopper the wrong
   * thing. Why it refuses is already on the offer — `checkout.reasons` names
   * every applicable one — so this value says which ACTION is unavailable and
   * the row says why.
   */
  | 'native_not_purchasable';

export const PRODUCT_PAGE_OUTBOUND_UNAVAILABLE_REASONS: readonly ProductPageOutboundUnavailableReason[] =
  ['redirect_unavailable', 'no_destination', 'native_not_purchasable'];

/**
 * What a row's primary action can do (#71 actions 1 and 2).
 *
 * Three branches and no fourth. `native` carries the ids the cart already
 * operates on, which is what makes "an external offer cannot enter the cart"
 * structural on this surface too: the external branches carry no variant id, so
 * there is nothing an add-to-cart call could be handed.
 *
 * The `available` external branch carries a REDIRECT PATH — never a destination
 * URL. #67 landed the redirect, so that path is a real `/out/:token`; the
 * unavailable branch is now reached only when the deployment has not mounted it,
 * when the offer names no destination, or when a native offer's checkout verdict
 * refuses.
 */
export type ProductPageOutbound =
  | {
      readonly kind: 'native_checkout';
      readonly listingId: string;
      readonly productVariantId: string;
    }
  | {
      readonly kind: 'outbound';
      /** A Mercaria path #37 owns. Never a merchant URL, never a tracking URL. */
      readonly redirectPath: string;
      /** The destination HOST, for the disclosure #67 rule 5 asks for. */
      readonly destinationHost: string;
      /**
       * The link relationship this handoff must be published under
       * (#67 outbound rule 8) — always `OUTBOUND_LINK_REL`.
       *
       * It is DATA rather than something each surface composes, because "is
       * this link disclosed as paid" is one answer and three clients would
       * eventually give three. It is served so a policy change reaches a
       * shipped mobile build without one.
       *
       * The storefront does NOT apply it: a `Pressable` renders a `div` rather
       * than an anchor, so there is no `rel` to set, and the crawler-facing
       * guarantee that exists today is the redirect's own
       * `X-Robots-Tag: noindex, nofollow`. It is on the DTO so that whatever
       * renders real HTML (#75's public routes) does not have to re-derive it.
       */
      readonly rel: string;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: ProductPageOutboundUnavailableReason;
      /**
       * The destination HOST, when the offer has one.
       *
       * A hostname is the disclosure — "this offer is on example.com" — and it
       * is not a link: it cannot be followed by accident and it cannot carry
       * tracking parameters, because it is not a URL.
       */
      readonly destinationHost?: string;
    };

/* ────────────────────────────────────────────────────────────────────────── */
/* Offer groups                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The one group an offer belongs to (#71 §"Offer groups").
 *
 * A PARTITION, decided by condition first. #90's rule that new, refurbished and
 * used may never blend on one price line is what makes condition the primary
 * axis; verified official standing then splits the `new` segment, because #71
 * asks for official-store offers separately from other new retail.
 *
 * An `authorized_reseller` is deliberately NOT in `official_direct`: #55 keeps
 * "the brand's own channel" and "a reseller the brand authorised" as separate
 * kinds, separate badges and separate lists, and merging them here would blur
 * exactly the distinction that domain exists to hold. The badge still travels
 * with the row.
 *
 * An official store's REFURBISHED offer lands in `refurbished`, not
 * `official_direct` — condition is the primary axis and Apple's certified
 * refurbished units are the case that makes it matter. The row keeps its
 * official badge.
 */
export type ProductPageOfferGroupKey =
  /** Condition `new`, on a channel #55 has verified as the brand's own. */
  | 'official_direct'
  /** Condition `new`, everybody else. */
  | 'new_retail'
  | 'open_box'
  | 'refurbished'
  | 'used'
  | 'for_parts'
  /** The source published no condition. Never folded into `new_retail`. */
  | 'condition_unknown';

export const PRODUCT_PAGE_OFFER_GROUP_KEYS: readonly ProductPageOfferGroupKey[] = [
  'official_direct',
  'new_retail',
  'open_box',
  'refurbished',
  'used',
  'for_parts',
  'condition_unknown',
];

/**
 * One group, and the offers in it IN RANKED ORDER.
 *
 * Ids rather than rows, so the partition cannot drift from the row list and a
 * client cannot render an offer twice by rendering both. The order inside a
 * group is the comparison's own — this domain never sorts anything, because a
 * second ordering would be a second ranking policy nobody versioned.
 */
export interface ProductPageOfferGroup {
  readonly key: ProductPageOfferGroupKey;
  readonly offerIds: readonly string[];
}

/**
 * One highlighted offer, and the #74 award that earned it (#71 offer groups 1
 * and 2).
 *
 * Derived from the comparison's labels and from nothing else. A "cheapest new"
 * or "best overall" this page computed itself would be a comparison run outside
 * the versioned policy, unattributable to any impression and impossible to
 * reproduce from an operator trace.
 */
export interface ProductPageHighlight {
  readonly offerId: string;
  readonly award: OfferLabelAward;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Offer rows                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * One row of the comparison: the offer, its place in it, who is selling and
 * what the action does.
 *
 * Bundled rather than shipped as four parallel arrays a client joins by id. The
 * join is the thing that goes wrong — a ranked entry whose offer is missing
 * renders as nothing at all — and doing it once, server-side, at the instant
 * both were read, is the only place it cannot.
 */
export interface ProductPageOfferRow {
  readonly offer: Offer;
  readonly ranked: RankedOffer;
  readonly seller: ProductPageSeller;
  readonly outbound: ProductPageOutbound;
  /**
   * The configuration this offer prices, named.
   *
   * Present on a PRODUCT-scoped page, where rows span configurations and a row
   * that did not say which one it was about would be #71 acceptance 4 failing
   * quietly. Absent on a variant-scoped page, where every row prices the same
   * configuration and repeating it is noise.
   */
  readonly variantName?: string;
}

/** Why the offers half of a page is not being served. */
export type ProductPageOffersWithheldReason =
  /**
   * `CANONICAL_OFFER_COMPARISON` is not `on` in this deployment.
   *
   * The identity half still answers — withdrawing price comparison during an
   * incident must not take the product page down with it (#60 feature flags 2
   * and 3) — and this reason is what stops the empty result reading as "nobody
   * sells this".
   */
  'comparison_withheld';

export const PRODUCT_PAGE_OFFERS_WITHHELD_REASONS: readonly ProductPageOffersWithheldReason[] = [
  'comparison_withheld',
];

/**
 * The offers half of the page.
 *
 * The withheld branch has no `rows`, no `policy` and no `comparisonCurrency`,
 * so a renderer cannot say "no offers" about a deployment that simply is not
 * answering the question — the `deriveOfferDelivery` device, applied to a
 * rollout lever.
 */
export type ProductPageOffers =
  | { readonly available: false; readonly reason: ProductPageOffersWithheldReason }
  | {
      readonly available: true;
      /** The policy that produced the order — what an impression is logged under. */
      readonly policy: RankingPolicy;
      readonly intent: OfferComparisonIntent;
      readonly experience: OfferComparisonExperience;
      readonly comparisonCurrency: CurrencyCode;
      /** One snapshot per distinct source currency converted, deduplicated. */
      readonly rates: readonly FxRateSnapshot[];
      /** Every served offer, in ranked order. */
      readonly rows: readonly ProductPageOfferRow[];
      readonly groups: readonly ProductPageOfferGroup[];
      readonly highlights: readonly ProductPageHighlight[];
      /**
       * How many offers eligibility refused — the COUNT, never the list.
       *
       * `GET /offer-comparison` ships every exclusion with its reasons, and it
       * is right that it does: "why is my offer missing" is a seller's question
       * and that surface exists to answer it. A shopper's page renders none of
       * it, and a page that carried it would be publishing one seller's refusal
       * to every other seller's customers. The count is kept for one honest
       * use: no rows with a non-zero count means "we know of offers and none is
       * currently eligible", which is a different sentence from "nobody sells
       * this".
       */
      readonly excludedCount: number;
    };

/* ────────────────────────────────────────────────────────────────────────── */
/* Relationships                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A brand channel a shopper may follow (#71 relationships 3 and 4).
 *
 * Official channels and authorised resellers are returned in SEPARATE lists on
 * {@link CanonicalProductPage}, never one list with a kind field: #55 makes
 * them separate kinds carrying separate badges, and a single list sorted by
 * kind is one refactor from a UI that renders them the same.
 *
 * Every entry here is VERIFIED and inside its validity window — the public
 * resolver never trusts a status alone — and every one is scoped to the market
 * the page was read for. A relationship that expired yesterday produces no
 * entry whether or not a sweep has run.
 */
export interface ProductPageBrandChannel {
  readonly merchantId: string;
  readonly merchantName: string;
  readonly merchantSlug: string;
  readonly storefrontId?: string;
  readonly storefrontName?: string;
  readonly storefrontSlug?: string;
  /** Where the relationship's validity window closes, when it has an end. */
  readonly validTo?: string;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The page                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Everything one canonical product page renders, from one read.
 *
 * Reviews (#76), price history (#78) and saves (#80) are deliberately NOT in
 * here. Each is an independently levered public surface with its own cache
 * lifetime and its own failure mode — a price-history deployment that has not
 * enabled public reads answers 404, and folding that into this response would
 * make the whole page fail for a chart nobody was promised. The client composes
 * them, which is also what lets the page paint before they resolve.
 */
export interface CanonicalProductPage {
  readonly product: CanonicalProduct;
  /** Present exactly when the requested handle was not the product's own. */
  readonly redirect?: ProductPageRedirect;
  readonly variants: readonly ProductPageVariant[];
  /**
   * The configuration the offers are scoped to, when the caller named one.
   *
   * Absent means the page is PRODUCT-scoped and the rows span configurations.
   * The two are genuinely different reads — a variant-scoped comparison cannot
   * contain another configuration's offer, which is #71 acceptance 4 held by
   * the query rather than by a filter afterwards.
   */
  readonly selectedVariantId?: string;
  /** The market the page was read for, ISO 3166-1 alpha-2. Absent = unrestricted. */
  readonly market?: string;
  readonly offers: ProductPageOffers;
  readonly officialChannels: readonly ProductPageBrandChannel[];
  readonly authorizedResellers: readonly ProductPageBrandChannel[];
}
