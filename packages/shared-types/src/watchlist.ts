/**
 * Private watchlists and currency-safe basket tracking — issue #81, over #44's
 * money, #56's canonical catalogue, #74's ranking and #80's saves.
 *
 * A **watchlist** is one Oxy account's PURPOSEFUL grouping of canonical products
 * with quantities: a PC build, a nursery, a kitchen restock. A **product save**
 * (#80) is one account's standing interest in ONE canonical product. They are
 * different things and this file keeps them different — a watchlist is not a
 * second answer to "did this buyer save this product", it is a second question
 * ("what would this set of things cost me right now"), and the two never share a
 * row, a counter or an aggregate.
 *
 * ## The five properties this file exists to hold
 *
 * 1. **A basket total names ONE currency and ONE basis, or it is not a total.**
 *    {@link WatchlistBasketTotal}'s known branch carries a
 *    {@link WatchlistBasketBasis}, and the basis is a property of the WHOLE
 *    total rather than of each line: summing one item's delivered total with
 *    another's bare item price produces a number that describes nothing. Raw
 *    minor units are never added across currencies anywhere — every contributing
 *    amount is converted into the list's display currency first, each with its
 *    own captured {@link FxRateSnapshot}.
 * 2. **An item that could not be priced is REPORTED, never dropped.**
 *    {@link WatchlistItemEvaluation}'s `unresolved` branch carries a reason and
 *    has no amount to add, so an item cannot silently leave a total. A total
 *    that quietly excludes items is the failure this issue exists to prevent,
 *    which is why {@link WatchlistBasket} carries `unresolved` beside `items`
 *    and why {@link WatchlistBasketCompleteness} is three-valued.
 * 3. **Unknown shipping is never zero.** {@link WatchlistDeliveryComponent}'s
 *    unknown branch has no `unit` and no `line`, so a `delivered_total` basis is
 *    unreachable for a set containing one — the `cheapest_known_total` device
 *    from #74, applied to a sum.
 * 4. **A watchlist is PRIVATE and there is no other setting.**
 *    {@link WATCHLIST_VISIBILITIES} has exactly one member and
 *    {@link WATCHLIST_FORBIDDEN_VISIBILITIES} names the five somebody would
 *    otherwise reach for; the two are DISJOINT and a gate fails the build if
 *    they intersect. #81 privacy rule 1 says lists are private "unless a later
 *    explicit sharing feature is built", and the honest way to say that is to
 *    make sharing unrepresentable rather than to default a boolean to false.
 * 5. **Nothing here claims a multi-store optimum.** #81 basket rule 5 assigns
 *    that to #42, and {@link WatchlistBasketOptimization} has ONE branch and it
 *    is the unperformed one — so no client can read an "optimized" flag out of a
 *    response, and {@link WATCHLIST_FORBIDDEN_CLAIMS} names the sentences a
 *    surface may never render. Independent per-item minima are exactly what this
 *    total is, and saying so is part of the payload.
 *
 * The tuples below are the closed value sets the schema's CHECK constraints are
 * rendered from (`text` + CHECK, never a pg enum — see
 * `db/schema/CONVENTIONS.md`). Widening one is a code change plus an additive
 * migration in the same PR.
 */

import type { ConditionGroup } from './condition';
import type { CurrencyCode, FxRateSnapshot, Money } from './money';
import type { OfferAvailability } from './offer';
import type { OfferTaxInclusion, RankingUnknownReason } from './offer-ranking';

/* ────────────────────────────────────────────────────────────────────────── */
/* Visibility, templates and limits                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Who may see a watchlist. Exactly one member, on purpose.
 *
 * The {@link ProductSaveVisibility} device (#80), for its reason: a policy
 * stated as a one-member union is enforced by the type system AND by a CHECK,
 * where an `isPublic: false` default is enforced by whoever remembers it. #81
 * privacy rule 1 makes lists private until an explicit sharing feature is built;
 * that feature is a product decision with its own issue, its own privacy review
 * and its own migration.
 */
export type WatchlistVisibility = 'private';

export const WATCHLIST_VISIBILITIES: readonly WatchlistVisibility[] = ['private'];

/**
 * Visibilities that may never join the tuple above.
 *
 * DISJOINT from {@link WATCHLIST_VISIBILITIES} and gated by a test — the
 * `PRODUCT_SAVE_FORBIDDEN_VISIBILITIES` / `RetailForbiddenComponentKind`
 * device. `shared_link` is the one worth naming explicitly: a list reachable by
 * URL is public to anyone the URL reaches, however unguessable it is, and a
 * "private link" is the shape this prohibition is most likely to be walked
 * around by.
 */
export const WATCHLIST_FORBIDDEN_VISIBILITIES: readonly string[] = [
  'public',
  'followers',
  'shared_link',
  'unlisted',
  'team',
];

/**
 * Claims a watchlist surface may never make (#81 basket rule 5, acceptance 6).
 *
 * Named as VALUES so `watchlist-isolation.test.ts` can refuse them BY NAME
 * across the backend and the storefront screens, and so a reviewer reads the
 * prohibition rather than inferring it from an absence. The displayed sum is a
 * sum of INDEPENDENT per-item minima: each item's cheapest eligible offer, in
 * isolation, with no attempt to trade one item's higher price for another's
 * lower delivery. Calling that an optimized basket is not a wording problem — it
 * is a claim about an optimization nobody ran, and #42 owns the one that would.
 */
export const WATCHLIST_FORBIDDEN_CLAIMS: readonly string[] = [
  'cheapest combined checkout',
  'cheapest basket',
  'optimized basket',
  'optimal basket',
  'best combination of stores',
  'lowest total across stores',
];

/**
 * The honest label a surface renders instead. A CONSTANT rather than copy
 * repeated per screen, so the gate above has a positive control: a scan that
 * finds no forbidden claim and no honest label is scanning nothing.
 */
export const WATCHLIST_INDEPENDENT_MINIMA_LABEL = 'independent per-item minima';

/**
 * A starting shape for a private list (#81 UX rule 8).
 *
 * A template supplies a name, an icon and a description and NOTHING else. It
 * does not name products — a template that shipped canonical product ids would
 * be deployment data pretending to be code, wrong for every market on the day it
 * was written — and it does not make a list public, which is structural rather
 * than checked because {@link WatchlistVisibility} has one member.
 *
 * Item-level template semantics ("a PC build needs exactly one CPU") need #94's
 * category attribute registry to say what a CPU is, and are a named seam rather
 * than a guess.
 */
export type WatchlistTemplateKey =
  | 'pc_build'
  | 'home_office'
  | 'nursery'
  | 'kitchen_restock'
  | 'travel_kit';

export const WATCHLIST_TEMPLATE_KEYS: readonly WatchlistTemplateKey[] = [
  'pc_build',
  'home_office',
  'nursery',
  'kitchen_restock',
  'travel_kit',
];

/** One template's defaults. Copy, not data — see {@link WatchlistTemplateKey}. */
export interface WatchlistTemplate {
  readonly key: WatchlistTemplateKey;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
}

/**
 * The limits #81 privacy rule 3 asks for, as values both halves read.
 *
 * They are here rather than in the backend's config because the CLIENT needs
 * them to refuse before a round trip and to render a counter, and two copies of
 * a limit disagree the first time one is raised. Cross-row limits (lists per
 * owner, items per list) cannot be CHECK constraints and are enforced by the
 * service with an error naming the limit; the per-row ones (quantity, name and
 * note length) are CHECKs as well, rendered from these same constants.
 */
export const WATCHLIST_MAX_LISTS_PER_OWNER = 50;
export const WATCHLIST_MAX_ITEMS_PER_LIST = 200;
export const WATCHLIST_MAX_ITEM_QUANTITY = 999;
export const WATCHLIST_MAX_NAME_LENGTH = 120;
export const WATCHLIST_MAX_DESCRIPTION_LENGTH = 2000;
export const WATCHLIST_MAX_NOTE_LENGTH = 2000;
/** How many icon characters a list may carry — an emoji or a short token. */
export const WATCHLIST_MAX_ICON_LENGTH = 16;

/* ────────────────────────────────────────────────────────────────────────── */
/* The stored model                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Whether an item still points where the buyer meant it to — the ONE state this
 * domain stores about an item's resolution, and #80's `resolution_state` for its
 * reason.
 *
 * `ambiguous_after_split` is written by a curation job at the moment a split
 * divides an identity, which is a decision taken at a point in time and cannot
 * be re-derived afterwards: the two candidates only exist as a pair in the job
 * that made them. Everything ELSE an item can be wrong about — a retired
 * preferred variant, a product merged into a sibling entry, a product with no
 * live offers — is DERIVED at evaluation time from tables this domain does not
 * own, which is the `deriveNativeCheckoutEligibility` divergence and is why
 * {@link WatchlistItemUnresolvedReason} is much longer than this tuple.
 */
export type WatchlistItemResolutionState = 'resolved' | 'ambiguous_after_split';

export const WATCHLIST_ITEM_RESOLUTION_STATES: readonly WatchlistItemResolutionState[] = [
  'resolved',
  'ambiguous_after_split',
];

/** How a buyer answers a split ambiguity. #80's three answers, one domain over. */
export type WatchlistItemSplitResolution = 'keep_source' | 'move_to_target' | 'keep_both';

export const WATCHLIST_ITEM_SPLIT_RESOLUTIONS: readonly WatchlistItemSplitResolution[] = [
  'keep_source',
  'move_to_target',
  'keep_both',
];

/** How a watchlist stands with respect to a split that divided one item's product. */
export type WatchlistItemResolution =
  | { readonly state: 'resolved' }
  | {
      readonly state: 'ambiguous_after_split';
      readonly splitJobId: string;
      /** The product the item still points at. */
      readonly sourceCanonicalProductId: string;
      /** The other candidate the split produced. Absent while the job has not minted one. */
      readonly targetCanonicalProductId?: string;
    };

/**
 * A price the buyer is waiting for, in a currency of their own naming (#81 model
 * rule 8).
 *
 * The currency is the TARGET's, not the list's, and the comparison is made only
 * when the two agree — see {@link WatchlistTargetStatus}. Converting a target
 * would make "you reached your target" depend on a rate movement rather than on
 * a price, which is the same objection #80's reference price answers by refusing
 * a cross-currency comparison outright.
 */
export interface WatchlistItemTarget {
  readonly amount: number;
  readonly currency: CurrencyCode;
}

/**
 * The price-alert seam (#79).
 *
 * ONE branch, and it is the unsupported one — #80's `ProductSavePriceAlert`
 * device. #81 model rule 8 permits an item to carry a linked price-alert id and
 * UX rule 6 asks for the action; #79 owns the thing an action would create and
 * has not shipped, so the honest contract is a named refusal a client renders as
 * a disabled affordance. Never a column holding an id of a row that does not
 * exist, and never a boolean that reads as "you are subscribed".
 */
export interface WatchlistItemPriceAlert {
  readonly supported: false;
  readonly reason: 'price_alerts_not_implemented';
  readonly ownedBy: '#79';
}

/** The constant every projection returns for {@link WatchlistItemPriceAlert}. */
export const WATCHLIST_ITEM_PRICE_ALERT_SEAM: WatchlistItemPriceAlert = {
  supported: false,
  reason: 'price_alerts_not_implemented',
  ownedBy: '#79',
};

/** One watchlist, as its owner's own client sees it. There is no other viewer. */
export interface Watchlist {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  readonly visibility: WatchlistVisibility;
  /** #81 model rule 4 — what every amount on this list is expressed in. */
  readonly displayCurrency: CurrencyCode;
  /** ISO 3166-1 alpha-2. Absent means "do not narrow offers by market". */
  readonly market?: string;
  /** Set when the list was created from a template, never afterwards. */
  readonly templateKey?: WatchlistTemplateKey;
  /** #81 model rule 11 — the optimistic-concurrency token. See {@link WatchlistVersionConflict}. */
  readonly version: number;
  readonly itemCount: number;
  /** When an evaluation was last RECORDED as a snapshot, not when one last ran. */
  readonly lastEvaluatedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One item of a watchlist — a product, a quantity, and the buyer's narrowing. */
export interface WatchlistItem {
  readonly id: string;
  readonly canonicalProductId: string;
  /** #81 model rule 6. Absent means "any configuration". */
  readonly preferredCanonicalVariantId?: string;
  /** #81 model rule 7 — a preferred condition SEGMENT, never one of #90's nine keys. */
  readonly preferredConditionGroup?: ConditionGroup;
  /** #81 model rule 7 — a preferred seller of record. */
  readonly preferredMerchantId?: string;
  readonly quantity: number;
  /** The list's own order (#81 model rule 6). Contiguous from 0 after any reorder. */
  readonly position: number;
  readonly target?: WatchlistItemTarget;
  /** #81 model rule 9. Private to the owner and never carried into a snapshot. */
  readonly note?: string;
  readonly resolution: WatchlistItemResolution;
  readonly priceAlert: WatchlistItemPriceAlert;
  readonly addedAt: string;
  readonly updatedAt: string;
}

/** A watchlist with its items, in order. The read a list page makes. */
export interface WatchlistDetail {
  readonly watchlist: Watchlist;
  readonly items: readonly WatchlistItem[];
}

/**
 * What a client is told when its `expectedVersion` did not match (#81
 * acceptance 4).
 *
 * The CURRENT version travels with the refusal so a client can re-read, re-apply
 * and retry without guessing. It is a 409 under its own error code rather than a
 * generic conflict, because "someone else edited this list" and "you asked for
 * something contradictory" need different client behaviour and message matching
 * is not a contract.
 */
export interface WatchlistVersionConflict {
  readonly watchlistId: string;
  readonly expectedVersion: number;
  readonly currentVersion: number;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Evaluation — one item                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Why one item contributes nothing to the basket.
 *
 * Every member is a fact the evaluation actually READ. There is deliberately no
 * `other` and no free-text member: an item a buyer cannot act on has to say
 * which kind of nothing it is, because the next action differs completely —
 * widen a filter, answer a split, remove a duplicate, or wait.
 *
 * `evaluation_failed` is the one that is about Mercaria rather than about the
 * item, and it exists so #81 acceptance 7 is structural: a failure while pricing
 * one item becomes that item's reason, not the request's, so the list still
 * opens and still edits.
 */
export type WatchlistItemUnresolvedReason =
  /** A split divided the product and the buyer has not said which half they meant. */
  | 'ambiguous_after_split'
  /** The pinned configuration no longer resolves; #81 correction rule 3. */
  | 'preferred_variant_retired'
  /** A merge collapsed this product into another entry of the SAME list. */
  | 'product_merged_into_existing_item'
  /** The canonical product no longer resolves to a live identity. */
  | 'product_unavailable'
  /** Nothing was ever observed for this product. */
  | 'no_offers_recorded'
  /** Offers exist and every one has lapsed or been withdrawn. */
  | 'all_offers_retired'
  /** Offers are live but this item's own preferences exclude all of them. */
  | 'no_eligible_offer'
  /** An offer exists and its price cannot be expressed in the list's currency. */
  | 'price_not_convertible'
  /** Pricing this one item raised. The list still opens (#81 acceptance 7). */
  | 'evaluation_failed';

export const WATCHLIST_ITEM_UNRESOLVED_REASONS: readonly WatchlistItemUnresolvedReason[] = [
  'ambiguous_after_split',
  'preferred_variant_retired',
  'product_merged_into_existing_item',
  'product_unavailable',
  'no_offers_recorded',
  'all_offers_retired',
  'no_eligible_offer',
  'price_not_convertible',
  'evaluation_failed',
];

/**
 * The delivery half of one item's cost, in the list's display currency.
 *
 * The unknown branch has NO `unit` and NO `line`, which is what makes a
 * `delivered_total` basis unreachable for a set containing one — #74's
 * `cheapest_known_total` device applied to a sum, and #81 item rule 5 ("mark
 * shipping, tax or availability unknown rather than assuming zero") held by the
 * type rather than by whoever writes the addition.
 */
export type WatchlistDeliveryComponent =
  | { readonly known: false; readonly reason: RankingUnknownReason }
  | {
      readonly known: true;
      readonly unit: Money;
      readonly line: Money;
      readonly fx: FxRateSnapshot;
    };

/**
 * The offer one item was priced from, and everything needed to reproduce that
 * price later (#81 item rule 8).
 *
 * `unitItemPrice` is a plain `Money` rather than a union, because an item is
 * only `priced` when its item price is known — an offer whose price cannot be
 * expressed in the list's currency is `price_not_convertible`, which is an
 * UNRESOLVED item and not a priced one with a hole in it.
 */
export interface WatchlistItemSelection {
  readonly offerId: string;
  readonly canonicalVariantId: string;
  readonly availability: OfferAvailability;
  readonly conditionGroup?: ConditionGroup;
  readonly merchantId?: string;
  readonly nativeCheckoutEligible: boolean;
  /** Which #74 policy version chose this offer. Snapshot rule 1. */
  readonly rankingPolicyVersion: string;
  /** The item price of ONE unit, converted, with the quote that converted it. */
  readonly unitItemPrice: Money;
  readonly unitItemPriceFx: FxRateSnapshot;
  /** `unitItemPrice × quantity`, in the display currency. */
  readonly lineItemPrice: Money;
  readonly delivery: WatchlistDeliveryComponent;
  /** #81 item rule 5 — `unknown` is a real member of #74's tuple, never assumed. */
  readonly taxInclusion: OfferTaxInclusion;
}

/**
 * Whether an item's target was reached, and whether the question is even
 * askable.
 *
 * `not_comparable` names WHICH axis stopped the comparison, because the two
 * reasons have opposite remedies: a currency mismatch is something the buyer can
 * fix by restating the target, and an unpriced item is not.
 */
export type WatchlistTargetStatus =
  | { readonly state: 'no_target' }
  | {
      readonly state: 'not_comparable';
      readonly reason: 'target_currency_mismatch' | 'item_not_priced';
    }
  | { readonly state: 'not_reached'; readonly target: Money; readonly currentUnitPrice: Money }
  | { readonly state: 'reached'; readonly target: Money; readonly currentUnitPrice: Money };

/**
 * How one item's current unit price compares with the last snapshot that
 * measured it on the SAME basis.
 *
 * The comparison is against this LIST's own history rather than against #78's
 * price series, and the two answer different questions: #78 says what an OFFER
 * cost over time, in a series currency, under no preferences; this says what
 * THIS item cost this buyer at the moments their list was evaluated, in their
 * display currency, under their preferences and under a named ranking policy.
 * Reading one for the other would report a change the buyer never saw.
 */
export type WatchlistItemPriceChange =
  | {
      readonly known: false;
      readonly reason:
        | 'no_prior_snapshot'
        | 'not_priced_in_prior_snapshot'
        | 'currency_changed'
        | 'policy_version_changed';
    }
  | {
      readonly known: true;
      readonly direction: 'down' | 'up' | 'unchanged';
      readonly deltaMinor: number;
      readonly currency: CurrencyCode;
      readonly since: string;
    };

/** One item's evaluation: a price, or a reasoned absence. */
export type WatchlistItemEvaluation =
  | { readonly state: 'priced'; readonly selection: WatchlistItemSelection }
  | { readonly state: 'unresolved'; readonly reason: WatchlistItemUnresolvedReason };

/** One evaluated row of a basket — the item, what it cost, and how that moved. */
export interface WatchlistBasketLine {
  readonly item: WatchlistItem;
  readonly evaluation: WatchlistItemEvaluation;
  readonly priceChange: WatchlistItemPriceChange;
  readonly target: WatchlistTargetStatus;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Evaluation — the whole list                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * What a total is a total OF (#81 basket rule 1, "a named basis").
 *
 * The basis belongs to the WHOLE total, not to each line, and that is the point:
 * adding one item's delivered total to another's bare item price produces a
 * figure that answers no question anybody asked. So the evaluation picks the
 * strongest basis EVERY contributing item can satisfy and states it.
 */
export type WatchlistBasketBasis = 'delivered_total' | 'item_price';

export const WATCHLIST_BASKET_BASES: readonly WatchlistBasketBasis[] = [
  'delivered_total',
  'item_price',
];

/**
 * How much of the list the total covers (#81 basket rule 2).
 *
 * `complete` means every item in the list contributed. `partial` means at least
 * one did not and is listed in `unresolved`. `unknown` means nothing could be
 * summed at all — an empty list, or one where no item could be priced. Three
 * values rather than a boolean, because "we priced none of it" and "we priced
 * most of it" send a buyer to different places and a `complete: false` collapses
 * them.
 */
export type WatchlistBasketCompleteness = 'complete' | 'partial' | 'unknown';

export const WATCHLIST_BASKET_COMPLETENESS: readonly WatchlistBasketCompleteness[] = [
  'complete',
  'partial',
  'unknown',
];

/**
 * The basket total, or an honest statement that there is none.
 *
 * The unknown branch carries no `amount` and no `basis`: there is nothing to
 * render and nothing to compare, and a zero would be a claim that the basket is
 * free. `includedItems` and `excludedItems` travel with the known branch so a
 * surface can say "8 of 11 items" without counting the arrays itself and without
 * two places deciding what counts.
 */
export type WatchlistBasketTotal =
  | { readonly known: false; readonly completeness: 'unknown' }
  | {
      readonly known: true;
      readonly completeness: 'complete' | 'partial';
      readonly basis: WatchlistBasketBasis;
      readonly amount: Money;
      readonly includedItems: number;
      readonly excludedItems: number;
    };

/**
 * Whether a multi-store optimization was performed. ONE branch, and it is the
 * unperformed one (#81 basket rule 5, acceptance 6).
 *
 * #42 owns the optimization; until it exists there is no shape in which a
 * response could claim one, so a client cannot render "optimized" from a field
 * that has no true value. `basis` restates what the number IS, because the
 * dangerous reading is not a missing disclaimer — it is a plausible one.
 */
export interface WatchlistBasketOptimization {
  readonly performed: false;
  readonly basis: 'independent_per_item_minima';
  readonly ownedBy: '#42';
}

/** The constant every basket returns for {@link WatchlistBasketOptimization}. */
export const WATCHLIST_BASKET_OPTIMIZATION_SEAM: WatchlistBasketOptimization = {
  performed: false,
  basis: 'independent_per_item_minima',
  ownedBy: '#42',
};

/**
 * One evaluation of one list, at one moment.
 *
 * `rates` is every distinct quote used, deduplicated — the {@link RankedOfferComparison}
 * shape, for its reason: a comparison names one currency and captures the quotes
 * it converted with, so a later rate move can never change what somebody saw.
 */
export interface WatchlistBasket {
  readonly watchlistId: string;
  /** The list version this was evaluated against (#81 snapshot rule 1). */
  readonly listVersion: number;
  readonly displayCurrency: CurrencyCode;
  readonly market?: string;
  /** Every #74 policy version that chose an offer here, sorted and deduplicated. */
  readonly rankingPolicyVersions: readonly string[];
  readonly total: WatchlistBasketTotal;
  readonly optimization: WatchlistBasketOptimization;
  readonly lines: readonly WatchlistBasketLine[];
  /** #81 item rule 7 — the items that contributed nothing, kept separate. */
  readonly unresolved: readonly {
    readonly itemId: string;
    readonly canonicalProductId: string;
    readonly reason: WatchlistItemUnresolvedReason;
  }[];
  readonly rates: readonly FxRateSnapshot[];
  readonly evaluatedAt: string;
  /** The snapshot this basket was compared against, when there was one. */
  readonly comparedWithSnapshotId?: string;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Snapshots                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Why a snapshot was worth storing (#81 snapshot rule 6).
 *
 * There is deliberately no `unchanged` member: an evaluation whose content
 * digest matches the previous snapshot writes NO ROW, so an unchanged snapshot
 * has no shape to be stored in. A stored snapshot differs from its predecessor
 * by construction, and this tuple says how.
 *
 * `policy_version_changed` is the one that must not be read as a price move: a
 * different #74 policy can select a different offer for the same item at the
 * same prices, so a total that moved across a policy change is not attributable
 * to the items and the diff says so rather than blaming them.
 */
export type WatchlistSnapshotChangeKind =
  | 'first_snapshot'
  | 'membership_changed'
  | 'total_decreased'
  | 'total_increased'
  | 'basis_changed'
  | 'completeness_changed'
  | 'availability_changed'
  | 'selection_changed'
  /**
   * A priced item's own unit price moved. Necessary as well as the total kinds
   * rather than implied by them: two items moving by equal and opposite amounts
   * leave the total exactly where it was, and a snapshot whose only stated
   * change was a total that did not change would carry an EMPTY list of
   * material changes — which `watchlist_snapshots_material_changes_check`
   * refuses, correctly, because a stored snapshot differs from its predecessor
   * by construction and has to be able to say how.
   */
  | 'item_price_moved'
  | 'currency_changed'
  | 'policy_version_changed';

export const WATCHLIST_SNAPSHOT_CHANGE_KINDS: readonly WatchlistSnapshotChangeKind[] = [
  'first_snapshot',
  'membership_changed',
  'total_decreased',
  'total_increased',
  'basis_changed',
  'completeness_changed',
  'availability_changed',
  'selection_changed',
  'item_price_moved',
  'currency_changed',
  'policy_version_changed',
];

/**
 * What a snapshot RECORDED about one item's selected offer (#81 snapshot
 * rule 3).
 *
 * A different TYPE from {@link WatchlistItemSelection}, not a filtered one — the
 * `MerchantOrder` device (#106). A live selection carries facts read from the
 * offer at THIS instant (native checkout eligibility, tax inclusion); a stored
 * line carries what was written down, and a projection that reached for
 * something the row does not hold would have to invent it. Making the two types
 * different means such a reach fails `tsc` rather than producing a plausible
 * default.
 */
export interface WatchlistSnapshotSelection {
  readonly offerId: string;
  /** Absent for a line recorded against a product-scoped comparison. */
  readonly canonicalVariantId?: string;
  readonly availability: OfferAvailability;
  readonly rankingPolicyVersion: string;
  readonly unitItemPrice: Money;
  readonly lineItemPrice: Money;
  /** Present only when the source published a delivery cost. */
  readonly unitDelivery?: Money;
  readonly lineDelivery?: Money;
  /** Present EXACTLY when the offer's own currency differed from the list's. */
  readonly fx?: FxRateSnapshot;
}

/** One stored per-item line of a snapshot — the offer and quote used AT THE TIME. */
export interface WatchlistSnapshotLine {
  readonly itemId: string;
  readonly canonicalProductId: string;
  readonly preferredCanonicalVariantId?: string;
  readonly quantity: number;
  readonly position: number;
  readonly state: 'priced' | 'unresolved';
  readonly unresolvedReason?: WatchlistItemUnresolvedReason;
  readonly selection?: WatchlistSnapshotSelection;
}

/** One persisted evaluation (#81 snapshot rules 1–6). */
export interface WatchlistSnapshot {
  readonly id: string;
  readonly watchlistId: string;
  readonly listVersion: number;
  readonly rankingPolicyVersions: readonly string[];
  readonly displayCurrency: CurrencyCode;
  readonly market?: string;
  readonly total: WatchlistBasketTotal;
  readonly itemCount: number;
  readonly pricedItemCount: number;
  readonly unresolvedItemCount: number;
  readonly materialChanges: readonly WatchlistSnapshotChangeKind[];
  readonly previousSnapshotId?: string;
  readonly evaluatedAt: string;
}

/** A snapshot with its lines — the read a history page makes. */
export interface WatchlistSnapshotDetail {
  readonly snapshot: WatchlistSnapshot;
  readonly lines: readonly WatchlistSnapshotLine[];
}

/**
 * What a snapshot write did.
 *
 * `deduplicated` is a SUCCESS, not a refusal: #81 snapshot policy asks for
 * unchanged snapshots to be deduplicated, so an evaluation that changed nothing
 * returns the snapshot it matched rather than growing the table.
 */
export interface WatchlistSnapshotWriteResult {
  readonly outcome: 'recorded' | 'deduplicated';
  readonly snapshot: WatchlistSnapshot;
  readonly basket: WatchlistBasket;
}

/**
 * Why two snapshots cannot be diffed.
 *
 * A diff across a currency change, a basis change or a policy change would
 * attribute a movement to items that did not move, which is the one thing #81
 * snapshot rule 4 ("explain which items drove a change") must not do. Refusing
 * is the honest answer and it names which axis differed.
 */
export type WatchlistSnapshotDiffRefusal =
  | 'currency_changed'
  | 'basis_changed'
  | 'policy_version_changed'
  | 'no_prior_snapshot';

/** One item's contribution to a change between two snapshots. */
export interface WatchlistSnapshotItemDelta {
  readonly itemId: string;
  readonly canonicalProductId: string;
  readonly kind:
    | 'added'
    | 'removed'
    | 'price_moved'
    | 'quantity_changed'
    | 'became_priced'
    | 'became_unresolved'
    | 'offer_changed';
  /** The line-total movement in the display currency, when both sides were priced. */
  readonly deltaMinor?: number;
  readonly previousUnitPriceMinor?: number;
  readonly currentUnitPriceMinor?: number;
}

/**
 * Which items drove a change (#81 basket rule 4).
 *
 * DERIVED from two stored snapshots rather than stored beside them: the evidence
 * is already append-only and complete, and a stored explanation is a second
 * representation of a fact the rows already carry — which can disagree the first
 * time somebody rewrites the derivation.
 */
export type WatchlistSnapshotDiff =
  | { readonly comparable: false; readonly reason: WatchlistSnapshotDiffRefusal }
  | {
      readonly comparable: true;
      readonly baselineSnapshotId: string;
      readonly currentSnapshotId: string;
      readonly basis: WatchlistBasketBasis;
      readonly currency: CurrencyCode;
      /** Present only when BOTH totals were known. */
      readonly totalDeltaMinor?: number;
      /** Largest absolute movement first. */
      readonly items: readonly WatchlistSnapshotItemDelta[];
    };

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure helpers both halves share                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Whether a basket total is known — the guard a surface must pass before it can
 * read an amount.
 *
 * Exported because the storefront, the snapshot writer and the diff all need the
 * same narrowing, and three hand-written `total.known === true` checks are three
 * places to get it wrong. The backend compiles without `strictNullChecks`, where
 * a bare truthiness test on a boolean-literal discriminant does not narrow.
 */
export function hasKnownBasketTotal(
  total: WatchlistBasketTotal,
): total is Extract<WatchlistBasketTotal, { known: true }> {
  return total.known === true;
}

/** Whether an item's delivery cost is known. See {@link hasKnownBasketTotal}. */
export function hasKnownDelivery(
  delivery: WatchlistDeliveryComponent,
): delivery is Extract<WatchlistDeliveryComponent, { known: true }> {
  return delivery.known === true;
}
