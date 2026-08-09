/**
 * Canonical product saves and listing saves — issue #80.
 *
 * A **product save** is one Oxy account's standing interest in one canonical
 * PRODUCT. A **listing save** is the pre-existing `favorites` row: one account's
 * interest in one exact native LISTING. They are different things and this file
 * keeps them different, because collapsing them is the failure the issue exists
 * to prevent — a buyer who saved "this phone" loses their save the moment the
 * merchant who happened to be cheapest that day delists, and a buyer who saved
 * one seller's photographed, scratched, hand-numbered copy of something does not
 * want the model.
 *
 * ## The four distinctions this file exists to hold
 *
 * 1. **A product save survives its offers.** It names a canonical product, never
 *    an offer, a merchant or a listing — so an expiring offer, a merchant
 *    leaving and a price change are all events the save watches rather than
 *    things it is made of. {@link SavedProductOffer} is a discriminated union
 *    whose `none` branch carries a REASON, so a surface cannot render "no offer"
 *    as an empty price.
 * 2. **A listing save is not a downgraded product save.**
 *    {@link ListingSaveIntent} distinguishes a save whose exactness the buyer
 *    ASSERTED (`listing_pin`) from one where nobody asked (`listing_save`, the
 *    state of every row written before #80 and by every v1 client since). The
 *    migration reads the second and never overwrites the first.
 * 3. **A saved list is PRIVATE and there is no other setting.**
 *    {@link PRODUCT_SAVE_VISIBILITIES} has exactly one member and
 *    {@link PRODUCT_SAVE_FORBIDDEN_VISIBILITIES} names the four somebody would
 *    otherwise reach for; the two are DISJOINT and a gate fails the build if
 *    they ever intersect. #80 says "no public saved-list profile is included in
 *    this issue", and the honest way to say that is to make one unrepresentable
 *    rather than to leave a boolean defaulted to false.
 * 4. **Saving subscribes to nothing.** #80 asks for a price-alert ACTION that
 *    does not create an alert automatically; {@link ProductSavePriceAlert} has
 *    only an unsupported branch, so there is no field a client could read a
 *    subscription id out of, and {@link PRODUCT_SAVE_FORBIDDEN_SIDE_EFFECTS}
 *    names the five side effects a save may never have.
 *
 * The tuples below are the closed value sets the schema's CHECK constraints are
 * rendered from (`text` + CHECK, never a pg enum — see
 * `db/schema/CONVENTIONS.md`). Widening one is a code change plus an additive
 * migration in the same PR.
 */

import type { ConditionGroup } from './condition';
import type { Money } from './money';

/**
 * Where a save was made from.
 *
 * #80 model rule 5 ("source context that created the save"). Recorded because
 * "saved from a comparison page" and "saved from the listing of one specific
 * used copy" are different intentions, and a later product decision about which
 * of them should have become a listing PIN needs the evidence to exist.
 *
 * `favorite_migration` is the one value no human action produces: it marks a
 * save the #80 migration derived from an existing listing favorite, which is
 * what makes "how many saves did people actually make" answerable afterwards.
 */
export type ProductSaveSourceContext =
  | 'product_page'
  | 'product_card'
  | 'offer_comparison'
  | 'search_results'
  | 'listing_page'
  | 'saved_list'
  | 'favorite_migration'
  | 'split_resolution';

export const PRODUCT_SAVE_SOURCE_CONTEXTS: readonly ProductSaveSourceContext[] = [
  'product_page',
  'product_card',
  'offer_comparison',
  'search_results',
  'listing_page',
  'saved_list',
  'favorite_migration',
  'split_resolution',
];

/** The contexts a CLIENT may claim. `favorite_migration` is the server's alone. */
export const CLIENT_PRODUCT_SAVE_SOURCE_CONTEXTS: readonly ProductSaveSourceContext[] =
  PRODUCT_SAVE_SOURCE_CONTEXTS.filter(
    (context) => context !== 'favorite_migration' && context !== 'split_resolution',
  );

/**
 * Who may see a saved list. Exactly one member, on purpose.
 *
 * The `RetailSubsidySource` device (#120): a policy stated as a one-member union
 * is enforced by the type system and by a CHECK, where a `isPublic: false`
 * default is enforced by whoever remembers it. #80 privacy rule 6 excludes a
 * public saved-list profile from this issue; widening this tuple is what
 * introducing one would look like, and it cannot happen by accident.
 */
export type ProductSaveVisibility = 'private';

export const PRODUCT_SAVE_VISIBILITIES: readonly ProductSaveVisibility[] = ['private'];

/**
 * Visibilities that may never join the tuple above.
 *
 * DISJOINT from {@link PRODUCT_SAVE_VISIBILITIES} and gated by a test, the
 * `RetailForbiddenComponentKind` / `REVIEW_FORBIDDEN_SCOPES` device. A future
 * public-wishlist feature is a product decision with its own issue, its own
 * privacy review and its own migration — not a value somebody adds to a list.
 */
export const PRODUCT_SAVE_FORBIDDEN_VISIBILITIES: readonly string[] = [
  'public',
  'followers',
  'shared_link',
  'unlisted',
];

/**
 * Side effects a save may never have.
 *
 * #80 API rule 6: the API OFFERS a price-alert action and creating a save never
 * creates one. Named as values so `product-save-isolation.test.ts` can refuse
 * them by name, and so a refusal reads "saving cannot create a price alert"
 * rather than "unrecognized module".
 */
export const PRODUCT_SAVE_FORBIDDEN_SIDE_EFFECTS: readonly string[] = [
  'price_alert_subscription',
  'price_watch',
  'notification_subscription',
  'marketing_opt_in',
  'newsletter_subscription',
];

/**
 * Whether a save still points where the buyer meant it to.
 *
 * `ambiguous_after_split` is #80 migration rule 8 — a product SPLIT divides one
 * identity into two and no rule can say which half a save meant, so the save is
 * marked and the buyer decides. It is deliberately not a soft default: a save in
 * this state names the split job that caused it, so the two candidates are
 * recoverable, and the resolution is an explicit act.
 */
export type ProductSaveResolutionState = 'resolved' | 'ambiguous_after_split';

export const PRODUCT_SAVE_RESOLUTION_STATES: readonly ProductSaveResolutionState[] = [
  'resolved',
  'ambiguous_after_split',
];

/** How a buyer answers a split ambiguity. */
export type ProductSaveSplitResolution = 'keep_source' | 'move_to_target' | 'keep_both';

export const PRODUCT_SAVE_SPLIT_RESOLUTIONS: readonly ProductSaveSplitResolution[] = [
  'keep_source',
  'move_to_target',
  'keep_both',
];

/**
 * What a listing save asserts about its own exactness.
 *
 * `listing_save` is the honest reading of every row written before #80 and of
 * every write from a v1 client: the buyer saved a listing and nobody asked
 * whether they meant the exact copy or the model. `listing_pin` is the buyer
 * answering that question — #80 listing rule 4, "a native listing explicitly
 * pinned by the user even when a canonical product match exists".
 *
 * The migration reads `listing_save` rows and derives product saves from them;
 * it never rewrites the intent, so a pin stays a pin (#80 migration rule 4).
 */
export type ListingSaveIntent = 'listing_save' | 'listing_pin';

export const LISTING_SAVE_INTENTS: readonly ListingSaveIntent[] = ['listing_save', 'listing_pin'];

/**
 * What the migration did with one favorite.
 *
 * `converged` is not a failure: it is a second favorited listing of a product
 * the buyer already saves, which is #80 acceptance 1 working.
 */
export type ProductSaveMigrationOutcome =
  | 'created'
  | 'converged'
  | 'unmatched'
  | 'pin_preserved'
  | 'already_migrated';

export const PRODUCT_SAVE_MIGRATION_OUTCOMES: readonly ProductSaveMigrationOutcome[] = [
  'created',
  'converged',
  'unmatched',
  'pin_preserved',
  'already_migrated',
];

/**
 * Which surfaces a saved-items read draws from.
 *
 * #80 acceptance 8, and the whole of it: `off` is the CURRENT surface (listing
 * saves only, exactly what a deployment served before #80), `dual` reads both so
 * the two can be compared under real traffic, and `on` is the destination.
 *
 * `on` still returns listing saves — the PINNED ones, and the ones no product
 * save represents. Dropping the second set would break #80 acceptance 3
 * ("unmatched P2P favorites continue to work") on the deploy that finished the
 * rollout, which is the worst possible moment to discover it.
 */
export type SavedItemsReadMode = 'off' | 'dual' | 'on';

export const SAVED_ITEMS_READ_MODES: readonly SavedItemsReadMode[] = ['off', 'dual', 'on'];

/**
 * Below how many saves a count is withheld rather than disclosed.
 *
 * #80 privacy rule 4. The #77 merchant-analytics floor, for its reason: a small
 * number beside a timestamp is a person, and rounding does not fix it — "under
 * 10" plus who was looking at the page is the same disclosure. Withholding is
 * therefore a STATE and not a rounded number.
 */
export const PRODUCT_SAVE_COUNT_DISCLOSURE_FLOOR = 10;

/**
 * A save count, disclosed or withheld.
 *
 * A discriminated union rather than a nullable number, so a surface that renders
 * a withheld count has to write that branch out loud instead of showing `0`.
 */
export type ProductSaveCountDisclosure =
  | { readonly disclosed: true; readonly count: number }
  | { readonly disclosed: false; readonly floor: number };

/**
 * Apply #80 privacy rule 4. The ONE policy function; every surface that shows a
 * save count to anyone other than the person who made it calls this.
 */
export function discloseProductSaveCount(count: number): ProductSaveCountDisclosure {
  if (count >= PRODUCT_SAVE_COUNT_DISCLOSURE_FLOOR) {
    return { disclosed: true, count };
  }
  return { disclosed: false, floor: PRODUCT_SAVE_COUNT_DISCLOSURE_FLOOR };
}

/**
 * The price the best offer showed when the save was made.
 *
 * Not a price HISTORY — #78 owns that table, and this is one immutable
 * observation written once at save time so "cheaper than when you saved it" is
 * answerable without one. Its currency is the OFFER's own currency
 * (`OfferMoney`, not `Money`): an external platform trades in whatever it trades
 * in, which is ADR 0002 D18's documented CHECK exception, and re-pricing it into
 * a presentment currency here would bake a rate into a stored fact.
 */
export interface ProductSaveReferencePrice {
  readonly amount: number;
  readonly currency: string;
  readonly observedAt: string;
}

/** How the current best price compares with the reference above. */
export type SavedProductPriceChange =
  | { readonly known: false; readonly reason: 'no_reference_price' | 'currency_changed' | 'no_current_offer' }
  | {
      readonly known: true;
      readonly direction: 'down' | 'up' | 'unchanged';
      readonly deltaMinor: number;
      readonly currency: string;
      readonly since: string;
    };

/** Why a saved product has no offer a buyer could act on right now. */
export type SavedProductNoOfferReason =
  | 'no_offers_recorded'
  | 'all_offers_retired'
  | 'no_eligible_offer';

/**
 * The current best offer for a saved product — or an explicit statement that
 * there is none, and why.
 *
 * #80 API rules 3 and 4 and acceptance 7 in one type: a saved-product page stays
 * useful when every prior offer expires, because the absence is a value with a
 * reason rather than a missing field.
 */
export type SavedProductOffer =
  | {
      readonly state: 'none';
      readonly reason: SavedProductNoOfferReason;
    }
  | {
      readonly state: 'available';
      readonly offerId: string;
      readonly canonicalVariantId: string;
      readonly price?: { readonly amount: number; readonly currency: string };
      readonly availability: string;
      readonly conditionKey: string;
      /**
       * Absent when the source's own words could not be mapped to a segment
       * (#90's `unknown`). Optional rather than defaulted, because a saved-list
       * filter that read a missing segment as `new` would show a buyer a used
       * copy under a heading they set to exclude one.
       */
      readonly conditionGroup?: ConditionGroup;
      readonly nativeCheckoutEligible: boolean;
      readonly listingId?: string;
      readonly merchantId?: string;
    };

/**
 * The price-alert seam (#78).
 *
 * ONE branch, and it is the unsupported one. #80 asks the API to offer the
 * action without creating an alert; until #78 ships the thing an action would
 * create, the honest contract is a named refusal a client can render as a
 * disabled affordance — never an endpoint that accepts a subscription and drops
 * it, and never a boolean that reads as "you are subscribed".
 */
export interface ProductSavePriceAlert {
  readonly supported: false;
  readonly reason: 'price_alerts_not_implemented';
  readonly ownedBy: '#78';
}

/** The constant every projection returns for {@link ProductSavePriceAlert}. */
export const PRODUCT_SAVE_PRICE_ALERT_SEAM: ProductSavePriceAlert = {
  supported: false,
  reason: 'price_alerts_not_implemented',
  ownedBy: '#78',
};

/** How a save stands with respect to a split that divided its product. */
export type ProductSaveResolution =
  | { readonly state: 'resolved' }
  | {
      readonly state: 'ambiguous_after_split';
      readonly splitJobId: string;
      /** The product the save still points at. */
      readonly sourceCanonicalProductId: string;
      /** The other candidate the split produced. Absent while the job has not minted one. */
      readonly targetCanonicalProductId?: string;
    };

/** One canonical product save, as a buyer's own client sees it. */
export interface ProductSave {
  readonly id: string;
  readonly canonicalProductId: string;
  /** #80 model rule 3. NULL means "any configuration". */
  readonly preferredCanonicalVariantId?: string;
  /** #80 model rule 4 — a preferred condition SEGMENT, never a single key. */
  readonly preferredConditionGroup?: ConditionGroup;
  /** #80 model rule 4 — a preferred seller of record. */
  readonly preferredMerchantId?: string;
  readonly sourceContext: ProductSaveSourceContext;
  readonly visibility: ProductSaveVisibility;
  readonly resolution: ProductSaveResolution;
  readonly referencePrice?: ProductSaveReferencePrice;
  /** Set exactly when the #80 migration created this row, never by a buyer's action. */
  readonly migrationVersion?: string;
  readonly savedAt: string;
  readonly updatedAt: string;
}

/** The canonical product a save points at, projected for a saved list. */
export interface SavedProductSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly brandId?: string;
  readonly imageFileId?: string;
  /** #80 privacy rule 1 — a COUNT, disclosed by policy, and never who saved it. */
  readonly saveCount: ProductSaveCountDisclosure;
}

/** One entry of the saved list, when the entry is a canonical product. */
export interface SavedProductEntry {
  readonly kind: 'product';
  readonly save: ProductSave;
  readonly product: SavedProductSummary;
  readonly offer: SavedProductOffer;
  readonly priceChange: SavedProductPriceChange;
  readonly priceAlert: ProductSavePriceAlert;
}

/** One entry of the saved list, when the entry is an exact native listing. */
export interface SavedListingEntry {
  readonly kind: 'listing';
  readonly favoriteId: string;
  readonly listingId: string;
  readonly intent: ListingSaveIntent;
  readonly title: string;
  readonly price: Money;
  readonly imageFileId?: string;
  readonly available: boolean;
  /**
   * Whether a product save already represents this listing.
   *
   * Derived at read time from the migration record and the save's continued
   * existence, never stored: a buyer who un-saves the product must see the
   * listing stop claiming to be covered, in the statement that removed it.
   */
  readonly representedByProductSave: boolean;
  readonly savedAt: string;
}

/** One row of the merged saved list. */
export type SavedItem = SavedProductEntry | SavedListingEntry;

/** A page of the merged saved list, keyset-paginated (#80 API rule 7). */
export interface SavedItemsPage {
  readonly readMode: SavedItemsReadMode;
  readonly items: readonly SavedItem[];
  readonly nextCursor?: string;
}

/**
 * What the two save buttons on a listing page need, in one read.
 *
 * A listing page must be able to show `Save product` and `Save this listing` as
 * DIFFERENT controls with different states (#80 listing rules), and the state of
 * the first depends on a canonical mapping the listing DTO deliberately does not
 * carry. One narrow read answers both rather than widening `Listing` with a
 * canonical id that every non-save consumer would then have to reason about.
 */
export interface ListingSaveContext {
  readonly listingId: string;
  /** Absent when the listing has no active canonical attachment (an unmatched P2P item). */
  readonly canonicalProductId?: string;
  readonly canonicalVariantId?: string;
  readonly productSaved: boolean;
  readonly listingSaved: boolean;
  readonly listingSaveIntent?: ListingSaveIntent;
}

/** One product's derived save counter, as the operator surface reports it. */
export interface ProductSaveCounterRow {
  readonly canonicalProductId: string;
  readonly storedCount: number;
  readonly derivedCount: number;
  readonly lastRebuiltAt?: string;
}

/** One listing's derived favorite counter, the same shape one grain over. */
export interface ListingFavoriteCounterRow {
  readonly listingId: string;
  readonly storedCount: number;
  readonly derivedCount: number;
}

/**
 * Counter drift, as `/internal/product-saves/counters/drift` reports it.
 *
 * #80 counter rule 3 and acceptance 6. Read-only and repairs nothing: a rebuild
 * is an explicit operator action, the `payment_discrepancies` posture.
 */
export interface ProductSaveCounterDrift {
  readonly scannedProducts: number;
  readonly scannedListings: number;
  readonly productDrift: readonly ProductSaveCounterRow[];
  readonly listingDrift: readonly ListingFavoriteCounterRow[];
  readonly nextProductCursor?: string;
  readonly nextListingCursor?: string;
}

/** What one migration page did. */
export interface ProductSaveMigrationReport {
  readonly migrationVersion: string;
  readonly dryRun: boolean;
  readonly scanned: number;
  readonly created: number;
  readonly converged: number;
  readonly unmatched: number;
  readonly pinPreserved: number;
  readonly alreadyMigrated: number;
  readonly nextCursor?: string;
}
