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

/** How an attribute definition types its values. */
export type AttributeValueType = 'text' | 'number' | 'boolean' | 'enum' | 'quantity';

export const ATTRIBUTE_VALUE_TYPES: readonly AttributeValueType[] = [
  'text',
  'number',
  'boolean',
  'enum',
  'quantity',
];

/**
 * The dimension a `quantity` attribute measures. Every family names ONE base
 * unit, and normalization stores the magnitude in that base — so two sources
 * saying "256 GB" and "0.256 TB" land on one number and compare.
 *
 * #94 owns the full attribute/unit taxonomy (ADR 0002 D15); this is the set the
 * conversion table implements today, and widening it is the same three-edit
 * change adding an identifier scheme is.
 */
export type UnitFamily =
  | 'length'
  | 'mass'
  | 'volume'
  | 'digital_storage'
  | 'duration'
  | 'power'
  | 'energy'
  | 'count';

export const UNIT_FAMILIES: readonly UnitFamily[] = [
  'length',
  'mass',
  'volume',
  'digital_storage',
  'duration',
  'power',
  'energy',
  'count',
];

/**
 * What happened when a source's display string was normalized.
 *
 * Only `normalized` may carry a normalized value at all — the other three are
 * the structural form of "unknown or conflicting values remain source facts and
 * are not guessed" (#56 attribute rule 4). A row that could not be parsed keeps
 * the source's own words and nothing else.
 */
export type AttributeNormalizationState =
  | 'normalized'
  | 'unknown_unit'
  | 'unparsed'
  | 'conflicting';

export const ATTRIBUTE_NORMALIZATION_STATES: readonly AttributeNormalizationState[] = [
  'normalized',
  'unknown_unit',
  'unparsed',
  'conflicting',
];

/** One normalized attribute definition — the registry #56 attribute rule 1 asks for. */
export interface AttributeDefinition {
  id: string;
  /** Stable machine key, `^[a-z][a-z0-9_]*$`. Never renamed; a rename is a new key. */
  key: string;
  label: string;
  valueType: AttributeValueType;
  /** Present exactly when `valueType` is `quantity`. */
  unitFamily?: UnitFamily;
  /** The unit normalized magnitudes are stored in. Present with `unitFamily`. */
  baseUnit?: string;
  /** The permitted values of an `enum` attribute; empty for every other type. */
  allowedValues: string[];
  /**
   * Category ids this definition applies to. EMPTY means unscoped — an
   * attribute that applies anywhere. That is the opposite reading from a
   * procurement agreement's empty scope, and deliberately: a scope narrows a
   * definition that is otherwise general, while a grant that names no
   * destination grants none.
   */
  categoryIds: string[];
  description?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One attribute assignment, as a read surface sees it. */
export interface CanonicalAttributeAssignment {
  key: string;
  /** The source's own words, preserved verbatim. */
  displayValue: string;
  /** Present only when `normalizationState` is `normalized`. */
  normalizedText?: string;
  normalizedNumber?: number;
  normalizedUnit?: string;
  normalizedBoolean?: boolean;
  normalizationState: AttributeNormalizationState;
  /** Whether this assignment is the one Mercaria shows for the attribute. */
  selected: boolean;
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
