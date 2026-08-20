/**
 * The canonical PRODUCT layer of the commerce graph (#56, ADR 0002 D13–D16).
 *
 * A PRODUCT FAMILY is a brand's line grouping comparable products (iPhone). A
 * PRODUCT is one model as marketed and compared (iPhone 16 Pro). A CANONICAL
 * VARIANT is one exact purchasable configuration (iPhone 16 Pro, 256 GB, Black
 * Titanium) — the grain a GTIN identifies, an offer prices and a buyer
 * receives. None of them is a listing, a seller's item or a price: those stay
 * listing-first and attach to this layer, never the reverse (D6).
 *
 * The tuples here are the closed value sets the schema's CHECK constraints are
 * rendered from (`text` + CHECK, never a pg enum — `db/schema/CONVENTIONS.md`).
 * Adding a value is an ADR amendment first, then a code change plus an additive
 * migration in the SAME pull request: the TypeScript union widens immediately
 * and the database CHECK does not.
 */

import type { SourceFreshness, SourceLinkMethod } from './provenance';
import type { CanonicalAlias } from './organization';
import type {
  AttributeComponentAxis,
  AttributeNormalizationState,
  AttributeSelectionState,
} from './attribute-registry';

/**
 * The lifecycle of a canonical CATALOGUE entity — family, product or variant.
 *
 * Deliberately its own set rather than `CANONICAL_ENTITY_STATUSES` (which types
 * organizations, brands, merchants and storefronts). Two values that set does
 * not have are facts about a PRODUCT and nothing else:
 *
 * - `draft` — minted but not yet fit to show. Ingestion writes provisional rows
 *   here (ADR 0002 D23 phase 1) so an unreviewed guess is never a live product.
 * - `discontinued` — the maker stopped making it. A real-world fact a source can
 *   observe, distinct from Mercaria deciding not to show it (`suppressed`).
 *
 * And one value it deliberately DROPS: `inactive`. For a product, "not sold any
 * more" already has a precise, source-observable name, and a second vaguer value
 * beside it would let two writers record the same fact two ways and disagree —
 * the reasoning that keeps `is_marketplace` off offers and `ready` off
 * `provider_accounts`.
 *
 * `merged` and `suppressed` carry exactly the meanings D12 gives them: a merged
 * row is a tombstone that keeps its slug forever and points at its winner;
 * `suppressed` is the operator's "do not show" that destroys nothing.
 */
export type CanonicalCatalogStatus =
  | 'draft'
  | 'active'
  | 'discontinued'
  | 'merged'
  | 'suppressed';

export const CANONICAL_CATALOG_STATUSES: readonly CanonicalCatalogStatus[] = [
  'draft',
  'active',
  'discontinued',
  'merged',
  'suppressed',
];

/**
 * The catalogue statuses a SHOPPER-FACING rail may show or count (#628, #616).
 *
 * Three of the five are excluded for three INDEPENDENT reasons, each already
 * stated by the vocabulary above rather than invented here:
 *
 * - `draft` — "minted but not yet fit to show". #60's backfill mints provisional
 *   rows in this state and promoting one is #59's decision, so no shopper rail
 *   may be the surface that publishes it.
 * - `merged` — a tombstone that points at its winner. Showing it shows the
 *   losing half of a completed merge.
 * - `suppressed` — the operator's own "do not show".
 *
 * `discontinued` is INCLUDED, and the vocabulary is what decides it: it is "a
 * real-world fact a source can observe, distinct from Mercaria deciding not to
 * show it (`suppressed`)". The maker stopping production is not a decision to
 * hide, and #70's retrieval already acts on that — somebody searching a
 * discontinued model means that model, and the offers on it (if any) say what is
 * still buyable. Excluding it here would make a filter NARROWER than the
 * retrieval that feeds it: a discontinued product would be findable by name and
 * would vanish the moment a shopper ticked a filter box.
 *
 * ## Why this is ONE constant rather than one per surface
 *
 * The facet COUNT and the result LIST are rendered on one page, so their
 * agreement is the invariant — not an implementation detail either side may
 * hold its own opinion about. #628 measured what a second opinion costs: the
 * facet rail spelled `active`, the search rail `('active','discontinued')`, and
 * the attribute filter carried NO predicate at all, so an operator's "do not
 * show" was honoured by the number above the list and by nothing in it.
 *
 * Two earlier private constants said exactly this value in two modules
 * (`SEARCHABLE_CATALOG_STATUSES`, `BROWSABLE_CATALOG_STATUSES`) and are now
 * spelled here instead. The objection the second one recorded — that exporting
 * a module-private constant "would make one surface's retrieval policy another's
 * contract" — is answered by WHERE this one lives: it is a fact about the
 * catalogue vocabulary, declared beside the vocabulary that justifies it, and
 * not one rail's policy borrowed by another.
 *
 * This is deliberately NOT the set a MATCHER may attach to (`draft` is exactly
 * the right thing for a matcher and exactly the wrong thing for a shopper), nor
 * the set an internal or curation read walks — a merge, a rollup or a review
 * queue must see the rows a shopper may not.
 *
 * ## That last clause is about TRAVERSAL, not PUBLICATION (#749)
 *
 * It has stopped two people from fixing a real bug, so it is worth stating
 * exactly. "A rollup must see the rows a shopper may not" governs which rows a
 * curation process may WALK — a merge has to find the suppressed product in
 * order to rehome it, and a review queue has to list the draft nobody has
 * published. It does not license the NUMBER such a process stores from being a
 * count of rows a shopper may not see.
 *
 * `canonical_product_families.product_count` and `brands.product_count` are
 * written by the merge rollup and then PUBLISHED — on the brand page, in
 * canonical search results, and through `seoRepository` as
 * `catalogueEntryCount`. Under the blanket reading they would be unfixable by
 * construction, because the thing that writes them is a rollup. Under the right
 * one they are ordinary shopper-facing counts that happen to be derived by a
 * curation process, and they take this set like every other published count.
 *
 * The test is what the value is FOR, never which process computed it.
 */
export const SHOPPER_VISIBLE_CATALOG_STATUSES: readonly CanonicalCatalogStatus[] = [
  'active',
  'discontinued',
];

/** Which canonical catalogue table a polymorphic row addresses. */
export type CanonicalCatalogEntityKind = 'product_family' | 'product' | 'variant';

export const CANONICAL_CATALOG_ENTITY_KINDS: readonly CanonicalCatalogEntityKind[] = [
  'product_family',
  'product',
  'variant',
];

/**
 * Why a redirect row exists.
 *
 * `merge` is the operator decision itself; `flatten` is the bookkeeping hop D16
 * requires — when B merges into C, every tombstone that pointed at B is
 * retargeted at C so resolution stays ONE hop. The retarget overwrites
 * `merged_into_id`, which is precisely the fact the history table exists to
 * keep: without a `flatten` row, "A once redirected to B" is unrecoverable.
 */
export type CanonicalRedirectReason = 'merge' | 'flatten';

export const CANONICAL_REDIRECT_REASONS: readonly CanonicalRedirectReason[] = ['merge', 'flatten'];

/** Whether a canonical image is shown. Suppression destroys nothing. */
export type CanonicalImageStatus = 'active' | 'suppressed';

export const CANONICAL_IMAGE_STATUSES: readonly CanonicalImageStatus[] = ['active', 'suppressed'];

/**
 * The identifier schemes `product_identifiers` records (ADR 0002 D14).
 *
 * This is the ADR-bound set, unchanged. Three things it deliberately does NOT
 * contain, each because the identifier concerned is not an identifier of a
 * product in the world:
 *
 * - **A merchant SKU.** It identifies a row in one seller's system. It lives on
 *   offers and on `source_records`, and giving it a scheme here would let one
 *   seller's private code become a global identity (#56 acceptance 2).
 * - **A marketplace id (ASIN and friends).** Amazon's key for its own catalogue.
 *   It stays on the `source_records` row that observed it, and the canonical
 *   entity is reached from it through `canonical_product_source_links` /
 *   `canonical_variant_source_links` — which is what makes "look up by source
 *   id" answerable without minting a fake world-scoped identifier.
 * - **A bare model number.** A model number is only an identifier once it names
 *   its maker, which is exactly what `brand_model` is; the same rule that makes
 *   an MPN meaningless without brand scope (#56 identifier rule 4).
 */
export type IdentifierScheme =
  | 'gtin8'
  | 'upc'
  | 'ean'
  | 'gtin14'
  | 'isbn10'
  | 'isbn13'
  | 'mpn'
  | 'brand_model';

export const IDENTIFIER_SCHEMES: readonly IdentifierScheme[] = [
  'gtin8',
  'upc',
  'ean',
  'gtin14',
  'isbn10',
  'isbn13',
  'mpn',
  'brand_model',
];

/**
 * The cross-scheme normalization a scheme collapses into, when one exists.
 *
 * Only `gtin` today: the whole GTIN family — ISBN-13 included, because an
 * ISBN-13 *is* an EAN in the 978/979 range, and ISBN-10 after conversion —
 * normalizes to a zero-padded 14-digit GTIN. That single normalized space is
 * what the one-active-owner partial unique is taken over, so a UPC and the EAN
 * that pads to the same GTIN-14 cannot name two different variants.
 */
export type CanonicalIdentifierScheme = 'gtin';

export const CANONICAL_IDENTIFIER_SCHEMES: readonly CanonicalIdentifierScheme[] = ['gtin'];

/** Which canonical grain a scheme legally binds to (ADR 0002 D14). */
export type IdentifierGrain = 'product' | 'variant';

/**
 * The lifecycle of one identifier ASSERTION.
 *
 * `disputed` is the collision answer: an incoming assertion whose normalized
 * value is already actively owned by a different canonical entity is stored
 * disputed and routed to review. The newcomer never steals the identifier and
 * nothing auto-resolves a dispute (#56 identifier rule 5).
 *
 * `corrected` and `retired` are the append-only correction path (rule 6): the
 * old row keeps its values forever and the new one names it, so the history of
 * what a source once said survives every fix.
 */
export type IdentifierStatus = 'active' | 'disputed' | 'corrected' | 'retired';

export const IDENTIFIER_STATUSES: readonly IdentifierStatus[] = [
  'active',
  'disputed',
  'corrected',
  'retired',
];

/**
 * What one identifier scheme IS — the explicit registry #56 identifier rule 6
 * asks for.
 *
 * A category-specific scheme is added by appending to {@link IDENTIFIER_SCHEMES},
 * adding its entry here, and shipping the additive migration that widens the
 * CHECK. That is three deliberate edits in one pull request rather than a string
 * a caller can invent, which is the whole point of a registry: the set of things
 * that can identify a product in the world is a decision, not an input.
 */
export interface IdentifierSchemeDefinition {
  /** The grain this scheme may bind to. A GTIN identifies a trade ITEM. */
  readonly grain: IdentifierGrain;
  /** The normalized space it collapses into, when it has one. */
  readonly canonicalScheme?: CanonicalIdentifierScheme;
  /** Exact digit count the raw value must carry once separators are stripped. */
  readonly digitLength?: number;
  /**
   * Whether the issuing authority guarantees the value names ONE product
   * worldwide. Only a globally unique scheme may take the one-active-owner
   * partial unique — the others collide legitimately.
   */
  readonly globallyUnique: boolean;
  /**
   * Whether the value only identifies anything once a brand or manufacturer
   * scopes it. Brand agreement is a cross-table fact the matcher checks, never
   * a database constraint (ADR 0002 D14).
   */
  readonly requiresBrandScope: boolean;
  /** One line, for the operator surface and for whoever adds the next scheme. */
  readonly description: string;
}

export const IDENTIFIER_SCHEME_REGISTRY: Readonly<
  Record<IdentifierScheme, IdentifierSchemeDefinition>
> = Object.freeze({
  gtin8: {
    grain: 'variant',
    canonicalScheme: 'gtin',
    digitLength: 8,
    globallyUnique: true,
    requiresBrandScope: false,
    description: 'GS1 GTIN-8, the short trade-item number used on small packaging.',
  },
  upc: {
    grain: 'variant',
    canonicalScheme: 'gtin',
    digitLength: 12,
    globallyUnique: true,
    requiresBrandScope: false,
    description: 'GS1 GTIN-12 (UPC-A), the North American trade-item number.',
  },
  ean: {
    grain: 'variant',
    canonicalScheme: 'gtin',
    digitLength: 13,
    globallyUnique: true,
    requiresBrandScope: false,
    description: 'GS1 GTIN-13 (EAN-13), the international trade-item number.',
  },
  gtin14: {
    grain: 'variant',
    canonicalScheme: 'gtin',
    digitLength: 14,
    globallyUnique: true,
    requiresBrandScope: false,
    description: 'GS1 GTIN-14, the case/pack trade-item number.',
  },
  isbn10: {
    grain: 'variant',
    canonicalScheme: 'gtin',
    digitLength: 10,
    globallyUnique: true,
    requiresBrandScope: false,
    description: 'ISBN-10; converted to ISBN-13 before GTIN normalization.',
  },
  isbn13: {
    grain: 'variant',
    canonicalScheme: 'gtin',
    digitLength: 13,
    globallyUnique: true,
    requiresBrandScope: false,
    description: 'ISBN-13, which IS an EAN-13 in the 978/979 prefix range.',
  },
  mpn: {
    grain: 'variant',
    globallyUnique: false,
    requiresBrandScope: true,
    description:
      "A manufacturer's own part number. Unique only within that manufacturer; two brands " +
      'may legitimately ship the same string.',
  },
  brand_model: {
    grain: 'product',
    globallyUnique: false,
    requiresBrandScope: true,
    description:
      'A brand plus its model name or number, the way a maker markets a model. The scheme a ' +
      'model number is recorded under, since a model number alone names nothing.',
  },
});

/**
 * One attribute assignment, as a read surface sees it.
 *
 * The attribute VOCABULARY — value types, unit families, normalization states,
 * the versioned {@link AttributeDefinition} itself — lives in
 * `./attribute-registry` (#94), which owns the registry this layer cites. It
 * moved there rather than being duplicated: a second copy of "what a value type
 * is" is a second answer to what a stored value means.
 */
export interface CanonicalAttributeAssignment {
  key: string;
  /** The definition version this assignment was normalized under. */
  definitionVersion: number;
  /** The source's own words, preserved verbatim. */
  displayValue: string;
  /** Present only when `normalizationState` is `normalized`. */
  normalizedText?: string;
  normalizedNumber?: number;
  /** The upper bound of a `range` value; the lower bound is `normalizedNumber`. */
  normalizedNumberMax?: number;
  normalizedUnit?: string;
  normalizedBoolean?: boolean;
  normalizedDate?: string;
  /** The named component of a `structured` value — an explicit axis, never a position guess. */
  componentAxis?: AttributeComponentAxis;
  /** Position within a `set` or `ordered_list`; 0 for a single value. */
  position: number;
  normalizationState: AttributeNormalizationState;
  /** Whether this assignment is the one Mercaria shows, and if not, why not. */
  selectionState: AttributeSelectionState;
}

/** One option assignment that DEFINES a variant — an axis of its product. */
export interface CanonicalVariantOption {
  key: string;
  displayValue: string;
  /** The value the signature is computed over; order-independent by construction. */
  normalizedValue: string;
  position: number;
}

/** One canonical image, with the observation that supplied it. */
export interface CanonicalImage {
  id: string;
  /** Oxy media file id; resolve through the canonical media chokepoint. */
  fileId?: string;
  /** The image's address at its source, when Mercaria holds no copy. */
  sourceUrl?: string;
  alt?: string;
  /** BCP-47 tag when the image is locale-specific (a localized box shot). */
  locale?: string;
  position: number;
  status: CanonicalImageStatus;
  /** Freshness of the observation this image came from; rights are its source's. */
  freshness?: SourceFreshness;
}

/**
 * Where one selected canonical field came from (#56 product rule 10).
 *
 * `confidence` is NULL for a deterministic or human decision and outranks every
 * number, exactly as it does on a source link — this is the SAME provenance
 * layer #53 built, read at field grain, not a second one.
 */
export interface FieldProvenance {
  field: string;
  method: SourceLinkMethod;
  confidence?: number;
  selectedAt: string;
  freshness?: SourceFreshness;
}

/** One externally minted identifier bound to a canonical product or variant. */
export interface ProductIdentifier {
  id: string;
  scheme: IdentifierScheme;
  /** Exactly what the source said, kept verbatim and immutable after insert. */
  rawValue: string;
  /** The scheme's own normalization of that value. */
  normalizedValue: string;
  /** The cross-scheme normalization, when the scheme has one. */
  canonicalScheme?: CanonicalIdentifierScheme;
  canonicalValue?: string;
  status: IdentifierStatus;
  grain: IdentifierGrain;
}

/** The public read projection of a product family. */
export interface ProductFamily {
  id: string;
  slug: string;
  status: CanonicalCatalogStatus;
  name: string;
  description?: string;
  brandId?: string;
  categoryId?: string;
  aliases: CanonicalAlias[];
  productCount: number;
  /** Set exactly when `status` is `merged` — the redirect target. */
  mergedIntoId?: string;
  firstSeenAt: string;
  lastSeenAt?: string;
  freshness?: SourceFreshness;
  createdAt: string;
  updatedAt: string;
}

/** The public read projection of a canonical product. */
export interface CanonicalProduct {
  id: string;
  slug: string;
  status: CanonicalCatalogStatus;
  /** The canonical model name — "iPhone 16 Pro", never a seller's title. */
  name: string;
  description?: string;
  brandId?: string;
  familyId?: string;
  categoryId?: string;
  /** ISO-8601 release date, when reliably known. Never inferred from a listing. */
  releasedAt?: string;
  discontinuedAt?: string;
  modelYear?: number;
  modelCode?: string;
  aliases: CanonicalAlias[];
  /** Normalized search tokens, maintained by the write chokepoint. */
  searchTokens: string[];
  /**
   * The attribute keys whose values distinguish this product's variants — the
   * explicit marking #56 attribute rule 5 asks for, held at the PRODUCT because
   * that is where the fact lives (an iPhone's axes are storage and colour).
   */
  variantDefiningAttributeKeys: string[];
  images: CanonicalImage[];
  attributes: CanonicalAttributeAssignment[];
  identifiers: ProductIdentifier[];
  /** Provenance of each selected canonical field (#56 acceptance 4). */
  fieldProvenance: FieldProvenance[];
  /** Product-level rating, kept apart from merchant and transaction reviews. */
  rating: number;
  ratingCount: number;
  variantCount: number;
  mergedIntoId?: string;
  firstSeenAt: string;
  lastSeenAt?: string;
  freshness?: SourceFreshness;
  createdAt: string;
  updatedAt: string;
}

/** The public read projection of a canonical variant. */
export interface CanonicalVariant {
  id: string;
  productId: string;
  status: CanonicalCatalogStatus;
  /** Display name of the configuration — "256 GB, Black Titanium". */
  name?: string;
  /**
   * The order-independent digest of this variant's option assignments. Two
   * variants of one product can never share it: the pair is a unique index.
   */
  signature: string;
  /** True only where a single default configuration is a meaningful concept. */
  isDefault: boolean;
  options: CanonicalVariantOption[];
  attributes: CanonicalAttributeAssignment[];
  identifiers: ProductIdentifier[];
  images: CanonicalImage[];
  aliases: CanonicalAlias[];
  fieldProvenance: FieldProvenance[];
  releasedAt?: string;
  discontinuedAt?: string;
  /** The variants this one bundles, when it is a bundle. Empty otherwise. */
  bundleComponents: { variantId: string; quantity: number }[];
  mergedIntoId?: string;
  firstSeenAt: string;
  lastSeenAt?: string;
  freshness?: SourceFreshness;
  createdAt: string;
  updatedAt: string;
}

/**
 * The answer to an identifier lookup.
 *
 * `conflict` is a first-class outcome, not an error: it is what a caller gets
 * when a valid identifier is actively owned by one entity and another entity
 * asserts it too. Collapsing it into `resolved` would be the silent overwrite
 * #56 acceptance 3 exists to prevent.
 */
export type IdentifierResolution =
  | { kind: 'resolved'; grain: IdentifierGrain; id: string }
  | { kind: 'conflict'; grain: IdentifierGrain; ownerId: string; disputedIds: string[] }
  | { kind: 'invalid'; reason: string }
  | { kind: 'none' };
