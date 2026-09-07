/**
 * Discovery — the explore, category and deals feed.
 *
 * One contract with three SCOPES rather than three feeds: Shop's own explore,
 * category and offers pages are one section machine with one card set, and the
 * only thing that differs between them is which sections the server put in the
 * response.
 *
 * Not named `feed`: that word already carries the home feed and the supplier
 * product-feed importer. It IS the same concept as analytics'
 * `ANALYTICS_DISCOVERY_EVENT_TYPES` — browsing and finding — and the events
 * that vocabulary names are emitted BY these surfaces. Related on purpose.
 */

import type { OrderStatus } from './order';
import type { CategoryTile, ProductSummary, StoreSummary } from './product';
import type { Money } from './money';

/**
 * An ordering a shelf can be built on. A "curation" here is one of these
 * applied to a scope — there is no editorial curation model, and no admin
 * surface behind these pages, so a shelf title names the ordering it used.
 */
export type DiscoverySignal =
  | 'top-rated'
  | 'new'
  | 'on-sale'
  | 'best-selling'
  | 'most-viewed';

/** {@link DiscoverySignal}. Renders the CHECK on any column holding one. */
export const DISCOVERY_SIGNALS: readonly DiscoverySignal[] = [
  'top-rated',
  'new',
  'on-sale',
  'best-selling',
  'most-viewed',
];

/**
 * The signals answered from `listings` alone — rating, publication date and a
 * discounted variant are all durable columns with an index already on them.
 * These page to the full result set.
 */
export const DISCOVERY_SIGNALS_FROM_LISTINGS: readonly DiscoverySignal[] = [
  'top-rated',
  'new',
  'on-sale',
];

/**
 * The signals answered from `discovery_signals`. These page only as deep as the
 * sweep counted — see `DiscoverySectionPageDepth`.
 */
export const DISCOVERY_SIGNALS_FROM_COUNTS: readonly DiscoverySignal[] = [
  'best-selling',
  'most-viewed',
];

/**
 * The counting window. ONE member: nothing on any of the three screens asks for
 * a second, and a value set with a member nobody reads is one nobody can trust.
 * The column exists anyway so a row says which window it is; adding `7d` is a
 * shared-types change plus an additive migration.
 */
export type DiscoveryWindow = '30d';

/** {@link DiscoveryWindow}. */
export const DISCOVERY_WINDOWS: readonly DiscoveryWindow[] = ['30d'];

/** What a counted row is about. Polymorphic, so `subject_id` carries no FK. */
export type DiscoverySubjectType = 'listing' | 'store';

/** {@link DiscoverySubjectType}. */
export const DISCOVERY_SUBJECT_TYPES: readonly DiscoverySubjectType[] = ['listing', 'store'];

/**
 * The order statuses that ARE a sale.
 *
 * `pending_payment` is a stock reservation awaiting payment, not a sale.
 * `cancelled` and `refunded` are exits. Stated as a value set rather than
 * inlined in the sweep's `WHERE` so the decision is reviewable and testable —
 * excluding a status and forgetting one look identical inside a query.
 */
export const DISCOVERY_COUNTED_ORDER_STATUSES: readonly OrderStatus[] = [
  'paid',
  'processing',
  'shipped',
  'delivered',
  'partially_refunded',
];

/** How deep a section's "see all" can page. */
export type DiscoverySectionPageDepth =
  /** The whole result set — the signal reads `listings`. */
  | 'complete'
  /** Only what the sweep stored. Reported rather than implied. */
  | 'capped';

/** A card family. One member per card in the reference capture. */
export type DiscoverySectionKind =
  | 'hero'
  | 'category-tiles'
  | 'category-images'
  | 'pills'
  | 'products'
  | 'stores'
  | 'store-offer'
  | 'card-group';

/** {@link DiscoverySectionKind}. */
export const DISCOVERY_SECTION_KINDS: readonly DiscoverySectionKind[] = [
  'hero',
  'category-tiles',
  'category-images',
  'pills',
  'products',
  'stores',
  'store-offer',
  'card-group',
];

/** Which feed to build. */
export type DiscoveryScope =
  | { kind: 'root' }
  | { kind: 'category'; handle: string }
  | { kind: 'deals' };

/** A 2.35:1 action card: image, title, subtitle, destination. */
export interface HeroCard {
  id: string;
  title: string;
  /** One line under the title. Absent when nothing true can be said. */
  subtitle?: string;
  /**
   * Resolvable image URL, ABSENT when the subject has no image. Optional
   * rather than `''`: an empty string is an absent value wearing the type of a
   * present one, and it shipped a blank card once already.
   */
  imageUrl?: string;
  /** The scope+signal this card opens. */
  categoryHandle: string;
  signal: DiscoverySignal;
}

/**
 * A store's live automatic discount, resolved for display.
 *
 * `method: 'code'` discounts are never projected into one: a shelf advertising
 * a saving the shopper cannot get without a code they do not have is a false
 * price.
 */
export interface DiscountSummary {
  id: string;
  /** Percentage discounts carry this; fixed-amount ones carry `amountOff`. */
  percentOff?: number;
  /** Fixed-amount discounts carry this. */
  amountOff?: Money;
  /** The cart subtotal the discount needs, when it has a threshold. */
  minimumSubtotal?: Money;
  /** True when eligibility is narrower than everyone — drives the halo. */
  exclusive: boolean;
}

/**
 * Fields every section carries.
 *
 * Exported (not just `extends`ed) so `categoryName` below is a declaration
 * `validate:catalog-identity-contracts` can actually see and excuse — an
 * unexported base would hide the field from that gate's walk entirely, which
 * is worse than the renamed-to-dodge-it case its own docblock warns against:
 * nobody would even know there was a spelling to review.
 */
export interface DiscoverySectionBase {
  id: string;
  /** The heading. Absent on sections the reference renders headless. */
  title?: string;
  /** Where the heading links. */
  categoryHandle?: string;
  signal?: DiscoverySignal;
  /**
   * `categoryHandle`'s display name (e.g. "Women" for `women`), populated
   * WHENEVER `signal` is — always together, never one without the other.
   *
   * A slug is not a name: it is lowercase, hyphenated and in one language, and
   * a shelf's heading needs the name to interpolate
   * (`discovery.shelf.topRated` → "Top rated in {{category}}"). The client
   * cannot always recover it from a sibling section's tiles either: on a
   * CATEGORY scope, every tile-bearing section (`category-tiles`,
   * `category-images`, `pills`) carries the scope's SUBcategories, never the
   * scope's own category, so that page's own shelves would have nothing in
   * the feed itself to resolve their heading's name from.
   */
  categoryName?: string;
  layout: 'carousel' | 'grid';
}

/** The 2.35:1 action-card row: explore's first section and the category page's hero rows. */
export interface HeroSection extends DiscoverySectionBase {
  kind: 'hero';
  cards: HeroCard[];
}

/** Scrollable category tiles with text: browse by category at root. */
export interface CategoryTilesSection extends DiscoverySectionBase {
  kind: 'category-tiles';
  tiles: CategoryTile[];
}

/** Scrollable category tiles with images: category pages' header and deals page. */
export interface CategoryImagesSection extends DiscoverySectionBase {
  kind: 'category-images';
  tiles: CategoryTile[];
}

/** Horizontal scrollable filter pills: category pages' filter bar. */
export interface PillsSection extends DiscoverySectionBase {
  kind: 'pills';
  tiles: CategoryTile[];
}

/** Grid of product cards: all explore shelves (signals), category pages, and deals page. */
export interface ProductsSection extends DiscoverySectionBase {
  kind: 'products';
  products: ProductSummary[];
  pageDepth: DiscoverySectionPageDepth;
}

/** Grid of store cards: explore's recommended stores section. */
export interface StoresSection extends DiscoverySectionBase {
  kind: 'stores';
  stores: StoreSummary[];
  variant: 'large' | 'compact';
}

/** Store with automatic discount and featured products: explore's shop offers section. */
export interface StoreOfferSection extends DiscoverySectionBase {
  kind: 'store-offer';
  store: StoreSummary;
  discount: DiscountSummary;
  products: ProductSummary[];
}

/** Multiple product sections rendered as bordered cards, two per row: deals page editorial groupings. */
export interface CardGroupSection extends DiscoverySectionBase {
  kind: 'card-group';
  /** Each renders inside its own bordered card, two per row. */
  cards: ProductsSection[];
}

/** One section, discriminated by `kind`. */
export type DiscoverySection =
  | HeroSection
  | CategoryTilesSection
  | CategoryImagesSection
  | PillsSection
  | ProductsSection
  | StoresSection
  | StoreOfferSection
  | CardGroupSection;

/** The feed: ordered sections, rendered top to bottom. */
export interface DiscoveryFeed {
  sections: DiscoverySection[];
}
