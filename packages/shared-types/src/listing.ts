/**
 * Listing DTO and its supporting enums for the Mercaria — the core domain
 * entity shared between the frontend and backend.
 *
 * A `Listing` is the sellable product. It is owned EITHER by an individual P2P
 * seller (`ownerType: 'user'`, `seller` present) OR by a store
 * (`ownerType: 'store'`, `store` present). Its price fields are DERIVED from its
 * `variants`: `price` is the minimum ("from") price, `priceRange` spans
 * min→max, and `compareAtPrice` (when present) is the discount baseline of the
 * cheapest variant.
 */

import type { Timestamps } from './common';
import type { Money } from './money';
import type { Seller } from './seller';
import type { StoreSummary } from './product';
import type { ProductVariantDTO } from './variant';
import type { ConnectorProviderId } from './integration';
import type {
  ConditionDetailKind,
  ConditionDetailSeverity,
  ConditionGroup,
  ItemConditionDTO,
  ItemConditionKey,
  LegacyBinaryCondition,
} from './condition';

/**
 * Provenance of a listing imported/synced from an external commerce platform.
 * Present only on connector-sourced listings; native Mercaria listings omit it.
 * The `{ connectionId, externalId }` pair is the upsert key for re-sync.
 */
export interface ListingSource {
  /** The `Connection` this listing was imported through. */
  connectionId: string;
  /** External platform the listing originates from. */
  provider: ConnectorProviderId;
  /** The listing's id on the external platform. */
  externalId: string;
  /** ISO-8601 `updated_at` reported by the external platform at last sync. */
  externalUpdatedAt?: string;
}

/**
 * One structured condition fact supplied by the seller (#90 condition details).
 *
 * `note` is REQUIRED for the kinds in `CONDITION_DETAIL_KINDS_REQUIRING_NOTE`
 * and `severity` is accepted only for those in
 * `CONDITION_DETAIL_KINDS_WITH_SEVERITY` — both enforced by the request schema
 * and, independently, by a CHECK.
 */
export interface ConditionDetailInput {
  kind: ConditionDetailKind;
  severity?: ConditionDetailSeverity;
  note?: string;
}

/**
 * The seller marking which of their own gallery photos evidence the condition
 * (#90 evidence rule 4).
 *
 * `fileId` must be one of the listing's own `imageFileIds`: condition evidence
 * is not a second upload channel, it is an annotation on photographs the seller
 * has already attached to this listing, which is what keeps ownership and upload
 * time answerable from one place.
 */
export interface ConditionPhotoAnnotationInput {
  fileId: string;
  /** Whether this photo shows a defect rather than the item generally. */
  showsDefect?: boolean;
  /** Index into `details` of the defect this photo shows, when the seller names one. */
  detailIndex?: number;
}

/**
 * The full condition statement a seller makes about a listing (#90).
 *
 * `defectsAcknowledged` is an affirmative act with no default: the write path
 * refuses a condition whose policy requires acknowledgement unless it is
 * literally `true` (#90 policy rule 2). A missing field is not consent.
 */
export interface ListingConditionInput {
  key: ItemConditionKey;
  details?: ConditionDetailInput[];
  photoAnnotations?: ConditionPhotoAnnotationInput[];
  defectsAcknowledged?: boolean;
}

/**
 * Lifecycle status of a listing.
 *
 * `restricted` is a MODERATION status and is the one value a seller can neither
 * set nor clear — see {@link SellerSettableListingStatus}. It is applied only by
 * `ModerationEnforcementService` carrying out a CrowdSource decision, and lifted
 * only by a `restore` from a later one.
 *
 * It needs no query changes to take effect. Every catalogue read filters
 * `status: 'active'` (feed, search, collections, store pages), the cart marks a
 * non-active line `stale`, and checkout refuses stale lines — so this single
 * value delists the item AND makes it unsellable, and the seller's real status
 * survives underneath in `moderation.restrictedFromStatus` for the restore.
 */
export type ListingStatus = 'draft' | 'active' | 'sold' | 'archived' | 'restricted';

/**
 * The statuses a seller may move their OWN listing between.
 *
 * `restricted` is deliberately absent, and that absence is load-bearing rather
 * than tidy typing: `catalog-write.service.updateListing` assigns `patch.status`
 * straight onto the document, so a union that included it would let a seller both
 * restrict a rival's listing shape and — far worse — lift a moderation
 * restriction on their own by PATCHing `status: 'active'`. The type keeps it out
 * of the payload; `assertSellerSettableStatus` in the service keeps it out at
 * runtime, because a type is erased and the escape is silent.
 */
export type SellerSettableListingStatus = Exclude<ListingStatus, 'restricted'>;

/** The statuses a seller may set, as a runtime list for validation. */
export const SELLER_SETTABLE_LISTING_STATUSES: readonly SellerSettableListingStatus[] = [
  'draft',
  'active',
  'sold',
  'archived',
];

/**
 * EVERY listing status, as a runtime list — the `listings.status` column enum and
 * `listings_status_check` are both built from THIS.
 *
 * It exists because the obvious alternative silently drifted. A schema that
 * declares its own `const STATUSES: readonly ListingStatus[] = [...]` accepts a
 * hand-written SUBSET, which satisfies that type perfectly — so a status added to
 * the union leaves tsc with no complaint while the enum and the CHECK never learn
 * about it, and the write that first uses it fails at RUNTIME with a 23514 on a
 * value the type system says is legal.
 *
 * Reading one list in both places makes that unrepresentable rather than merely
 * tested for. Same convention as `ALL_CURRENCY_CODES` and the money-column CHECK.
 */
export const ALL_LISTING_STATUSES: readonly ListingStatus[] = [
  'draft',
  'active',
  'sold',
  'archived',
  'restricted',
];

/**
 * The statuses that are a LIVE MODERATION HOLD — a jury's to write, and a jury's
 * to lift.
 *
 * `SELLER_SETTABLE_LISTING_STATUSES` above says what a seller may set. This says
 * what a seller may move a listing OUT of, and the two are genuinely different
 * questions: `archiveListing` never sets a status a seller chose, so it walked
 * around the first list entirely while being exactly the escape that list exists
 * to close (#402).
 *
 * Archiving is a soft delete everywhere else here. Against a restriction it was a
 * one-way door in BOTH directions at once: `restoreSubject` restores only from
 * `['restricted', 'draft']`, so an archived listing could never be relisted by an
 * accepted appeal — and, worse, once it was `archived` the runtime guard in
 * `updateListing` no longer fired, because that guard reads the CURRENT status.
 * So a seller could `DELETE` their restricted listing and then `PATCH` it back to
 * `active`, laundering the jury's decision in two ordinary calls.
 */
export const MODERATION_HELD_LISTING_STATUSES: readonly ListingStatus[] = ['restricted'];

/**
 * The statuses a MERCHANT-driven archive may move a listing out of.
 *
 * Derived by SUBTRACTION rather than written out, so the two lists cannot drift:
 * a status added to the union is archivable by default, and a status that is a
 * moderation hold has to be named as one above. `listing-archive-census.test.ts`
 * asserts the two are disjoint and cover `ALL_LISTING_STATUSES` exactly, so
 * adding a status forces a decision instead of inheriting one by omission.
 *
 * This is the SELLER and MERCHANT rule, not a universal one. The connector's two
 * "the product is genuinely gone upstream" paths — a `product_delete` webhook and
 * the delete reconciliation after a fully-completed backfill — still archive from
 * any status, deliberately: the merchant no longer sells the thing, whatever
 * Mercaria was deciding about it. What makes THAT safe is the other half of #402,
 * which lets a restore reach an archived listing.
 */
export const MERCHANT_ARCHIVABLE_LISTING_STATUSES: readonly ListingStatus[] =
  ALL_LISTING_STATUSES.filter((status) => !MODERATION_HELD_LISTING_STATUSES.includes(status));

/**
 * What moved a listing into `archived` — the status PROVENANCE #390 needed and
 * nothing stored.
 *
 * `archived` is the one status several unrelated authorities write for
 * unrelated reasons, and until this existed they were indistinguishable
 * afterwards. A merchant deleting a listing in Mercaria and a connector
 * mirroring a product that vanished upstream produce the identical row, so a
 * connector asked to un-archive on a republish could only either undo the
 * merchant's own decision or do nothing. #417 established that as the finding;
 * this is the fact that answers it.
 *
 * ONE member per WRITER — `listing-archive-census.test.ts` asserts the map is a
 * bijection — because the vocabulary exists to be READ by a decision, and two
 * call sites sharing a value are two situations somebody would then have to
 * tell apart by something else.
 */
export type ListingArchiveCause =
  /** `catalog-write.archiveListing` — the seller/admin `DELETE` funnel. */
  | 'merchant_delete'
  /** `catalog-write.updateListing` — a merchant PATCHing `status: 'archived'`. */
  | 'merchant_status_change'
  /** `channel-disconnect.disconnectChannel` under `archive_listings`. */
  | 'channel_disconnect'
  /** The connector's `product_delete` webhook: the product is gone upstream. */
  | 'connector_product_deleted'
  /** The post-backfill reconciliation: the product was not in a COMPLETE pull. */
  | 'connector_unseen_in_backfill'
  /** The connector saw the product upstream and UNPUBLISHED (#377/#379/#386). */
  | 'connector_unpublished'
  /**
   * An accepted appeal put the listing back into the `archived` state it held
   * when it was restricted (`enforcement.restoreSubject`). Reachable because
   * moderation may restrict a listing that was already archived, and the
   * restore writes back what it replaced rather than a hardcoded `active`.
   */
  | 'moderation_restore';

/** Every archive cause, as a runtime list — `listings_archived_by_check` reads THIS. */
export const LISTING_ARCHIVE_CAUSES: readonly ListingArchiveCause[] = [
  'merchant_delete',
  'merchant_status_change',
  'channel_disconnect',
  'connector_product_deleted',
  'connector_unseen_in_backfill',
  'connector_unpublished',
  'moderation_restore',
];

/**
 * The causes a connector may UNDO when the product reappears upstream, and the
 * only reading under which un-archiving is not the connector overruling
 * Mercaria: the archive was a MIRROR of the product's absence, so the product
 * being back is the same fact reversing.
 *
 * Named explicitly rather than derived from a `connector_` prefix, so a cause
 * added later is not restorable by omission (a string rule would make it one)
 * and so adding one forces the decision instead of inheriting it. The census
 * fails the build on a cause that is in neither this list nor
 * {@link ARCHIVE_CAUSES_SURVIVING_A_REPUBLISH}.
 *
 * `moderation_restore` is deliberately absent even though the archive UNDER it
 * may originally have been a connector's: the moderation round trip is a
 * decision by somebody else about the same listing, and the connector must not
 * reach through it. Such a listing stays archived and its own restore path
 * (#402) still reaches it.
 */
export const ARCHIVE_CAUSES_UNDONE_BY_REPUBLISH: readonly ListingArchiveCause[] = [
  'connector_product_deleted',
  'connector_unseen_in_backfill',
  'connector_unpublished',
];

/**
 * The causes an upstream republish leaves exactly where they are — a decision
 * taken IN Mercaria, which a remote fact says nothing about.
 *
 * Derived by SUBTRACTION so the two lists cannot drift, and asserted to cover
 * `LISTING_ARCHIVE_CAUSES` exactly.
 */
export const ARCHIVE_CAUSES_SURVIVING_A_REPUBLISH: readonly ListingArchiveCause[] =
  LISTING_ARCHIVE_CAUSES.filter((cause) => !ARCHIVE_CAUSES_UNDONE_BY_REPUBLISH.includes(cause));

/** Whether a listing is owned by an individual user or a store. */
export type ListingOwnerType = 'user' | 'store';

/** A single image attached to a listing. */
export interface ListingImage {
  /** Oxy media file id (or absolute URL), resolvable via the media CDN. */
  fileId: string;
  /** Optional alt text for accessibility. */
  alt?: string;
  /** Display order within the listing gallery (0-based). */
  position: number;
}

/** A selectable option (e.g. `Size`) and its allowed values. */
export interface ListingOption {
  /** Option name (e.g. `Size`). */
  name: string;
  /** Allowed values for the option (e.g. `['S', 'M', 'L']`). */
  values: string[];
}

/**
 * A marketplace listing: an item put up for sale by a user or a store.
 *
 * This is the canonical server-serialized DTO consumed directly by the
 * frontend — owner identity (`seller` / `store`), variants and derived price
 * fields are denormalized so the client renders without follow-up requests.
 */
export interface Listing extends Timestamps {
  /** Stable listing id. */
  id: string;
  /** Whether this listing is owned by a user or a store. */
  ownerType: ListingOwnerType;
  /** Short, human-readable title. */
  title: string;
  /** Full description (plain text or markdown, per product decision). */
  description: string;
  /** "From" price — the minimum variant price. */
  price: Money;
  /** Discount baseline of the cheapest variant, when on sale. */
  compareAtPrice?: Money;
  /** Min→max price span across all variants (present when variants exist). */
  priceRange?: { min: Money; max: Money };
  /** Concrete buyable SKUs. P2P listings have exactly one default variant. */
  variants: ProductVariantDTO[];
  /** Selectable options (empty for P2P listings). */
  options?: ListingOption[];
  /**
   * The item's condition on the #90 taxonomy — the AUTHORITATIVE field.
   *
   * Carries the key, its segment, how it came to be asserted, and the evidence
   * behind it. `condition` below is the derived v1 projection of this.
   */
  itemCondition: ItemConditionDTO;
  /**
   * The v1 binary spelling — a VERSIONED COMPATIBILITY PROJECTION, computed
   * from `itemCondition.key` on every read and stored nowhere.
   *
   * See `LEGACY_CONDITION_CONTRACT` for what retires it. It is here for the
   * reason `checkout`'s `addressId` is: a shipped mobile build cannot be
   * recalled. New client code reads `itemCondition` and never this.
   */
  condition: LegacyBinaryCondition;
  /**
   * The canonical product this listing's variants resolve to, when they resolve
   * to exactly ONE (#76 UI rule 1).
   *
   * Present only on the DETAIL read, never on a feed or a search page: resolving
   * it walks the listing's variants through the identifier collision gate, which
   * is a per-listing cost a grid of forty cards must not pay. Absent when the
   * listing carries no barcode, when its barcode owns no active identifier, or
   * when its variants disagree — all of which mean "Mercaria does not know which
   * product this is", and none of which is guessed.
   *
   * It is what lets the product page show PRODUCT reviews (quality, durability,
   * value) beside the listing's own condition feedback, instead of showing one
   * blended star average that answers neither question.
   */
  canonicalProductId?: string;
  /** Lifecycle status. */
  status: ListingStatus;
  /** Category slug the listing belongs to (e.g. `electronics`). */
  category: string;
  /** Ordered gallery images. */
  images: ListingImage[];
  /** Denormalized seller identity (present iff `ownerType === 'user'`). */
  seller?: Seller;
  /** Denormalized store identity (present iff `ownerType === 'store'`). */
  store?: StoreSummary;
  /** Free-form search tags. */
  tags: string[];
  /** Total available quantity, summed across all variants. */
  quantity: number;
  /** Whether the current viewer has saved/favorited this listing. */
  saved?: boolean;
  /** Manufacturer/brand (store products). */
  vendor?: string;
  /** Merchandising product type (store products). */
  productType?: string;
  /** URL-safe handle (store products); unique per store. */
  handle?: string;
  /** SEO overrides (store products). */
  seo?: { title?: string; description?: string };
  /** Collection ids this listing belongs to (store products). */
  collectionIds?: string[];
  /** Connector provenance — present only on listings synced from an external platform. */
  source?: ListingSource;
  /**
   * Field names locally edited on a connector-sourced listing and therefore
   * PINNED against connector re-sync overwrites (see `SyncSettings.conflictPolicy`).
   */
  overriddenFields?: string[];
}

/**
 * Payload accepted when an individual user creates a P2P (secondhand) listing.
 *
 * EXACTLY ONE of `condition` (v1) and `itemCondition` (#90) must be present.
 * Sending both is a 400 rather than a precedence rule nobody would remember —
 * the `checkout` `{destination} | {addressId}` decision, verbatim.
 */
export interface CreateP2PListingInput {
  title: string;
  description: string;
  price: Money;
  /**
   * The v1 binary spelling. `new` is lossless; `used` lands on the conservative
   * generic key and records `legacy_client_binary`, so it can never assert
   * `used_like_new` (#90 migration rule 2).
   */
  condition?: LegacyBinaryCondition;
  /** The #90 statement. Required of any client that can express it. */
  itemCondition?: ListingConditionInput;
  category: string;
  /** Oxy media file ids for the gallery, in display order. */
  imageFileIds: string[];
  tags?: string[];
  /** Available quantity (defaults to 1 server-side). */
  quantity?: number;
}

/** A single variant supplied when a store creates a new product. */
export interface CreateStoreProductVariantInput {
  /** Option assignments that define this variant. */
  optionValues: { name: string; value: string }[];
  price: Money;
  compareAtPrice?: Money;
  sku?: string;
  /** Barcode (UPC/EAN/ISBN, etc.). */
  barcode?: string;
  inventory: {
    /** Whether stock is tracked (defaults true). */
    tracked?: boolean;
    /** Units available. */
    available: number;
  };
}

/**
 * Payload accepted when a store creates a new product.
 *
 * Condition is OPTIONAL here and defaults to `new`, which is what every store
 * product was before #90 existed. A merchant selling open-box or refurbished
 * stock states it explicitly, and the evidence policy for that key then applies
 * exactly as it does to a P2P listing — a store is not exempt from showing the
 * actual unit.
 */
export interface CreateStoreProductInput {
  title: string;
  description: string;
  /** The v1 binary spelling. Exactly one of this and `itemCondition`. */
  condition?: LegacyBinaryCondition;
  /** The #90 statement. Absent means `new`. */
  itemCondition?: ListingConditionInput;
  category: string;
  /** Oxy media file ids for the gallery, in display order. */
  imageFileIds: string[];
  tags?: string[];
  /** Selectable options that the variants assign values for. */
  options: ListingOption[];
  /** Concrete variants for the product (at least one). */
  variants: CreateStoreProductVariantInput[];
  /** Manufacturer/brand. */
  vendor?: string;
  /** Merchandising product type. */
  productType?: string;
  /** URL-safe handle (unique per store). */
  handle?: string;
  /** SEO overrides. */
  seo?: { title?: string; description?: string };
}

/**
 * Partial payload accepted when updating an existing listing.
 *
 * A condition change goes through the same exactly-one rule as creation, and
 * every change appends a `listing_condition_revisions` row (#90 evidence rule
 * 8). The service refuses one on a listing that has already sold.
 */
export type UpdateListingInput = Partial<CreateP2PListingInput> & {
  /**
   * Seller-settable statuses only — a client can never ask for `restricted`, nor
   * PATCH its way out of one. See {@link SellerSettableListingStatus}.
   */
  status?: SellerSettableListingStatus;
  /** Manufacturer/brand (store products). */
  vendor?: string;
  /** Merchandising product type (store products). */
  productType?: string;
  /** URL-safe handle (store products); unique per store. */
  handle?: string;
  /** SEO overrides (store products). */
  seo?: { title?: string; description?: string };
};

/** Filter/sort parameters accepted by the listing search/browse endpoint. */
export interface ListingQuery {
  /** Full-text search term. */
  q?: string;
  /** Restrict to a single category slug. */
  category?: string;
  /**
   * Restrict to a condition, v1 spelling — the read half of the compatibility
   * contract. `used` selects every non-`new` GROUP, which is the honest
   * widening: a v1 client asking for "used" wants everything that is not
   * factory-sealed.
   *
   * Mutually exclusive with `conditionKeys`/`conditionGroups`; sending both is a
   * 400.
   */
  condition?: LegacyBinaryCondition;
  /** Restrict to specific taxonomy keys (#90 acceptance 2). */
  conditionKeys?: ItemConditionKey[];
  /** Restrict to whole segments — the filter a facet UI drives (#90 acceptance 2). */
  conditionGroups?: ConditionGroup[];
  /** Minimum price in minor units. */
  minPrice?: number;
  /** Maximum price in minor units. */
  maxPrice?: number;
  /** Restrict to a single store. */
  storeId?: string;
  /** Restrict to user-owned (P2P) or store-owned listings. */
  ownerType?: ListingOwnerType;
  /** Restrict to a single vendor/brand. */
  vendor?: string;
  /** Restrict to a single product type. */
  productType?: string;
  /** Restrict to listings in a single collection. */
  collectionId?: string;
  /** Geo radius filter (P2P proximity browse). */
  near?: { lng: number; lat: number; radiusM: number };
  /** Restrict to listings with available stock. */
  inStock?: boolean;
  /** Opaque cursor for the infinite `newest` browse path. */
  cursor?: string;
  /** Sort order for the result set. */
  sort?: 'newest' | 'price_asc' | 'price_desc';
}
