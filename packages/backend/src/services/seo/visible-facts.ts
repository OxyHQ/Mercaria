/**
 * Projecting a page into {@link SeoVisibleFacts} (#75 §"Structured data": "emit
 * only facts visible on the page").
 *
 * ## This is where parity is EARNED
 *
 * `document.ts` and `structured-data.ts` cannot reach a repository; everything
 * they emit comes through here. So the correctness question for the whole
 * domain reduces to one: does each projector below read the same value the
 * storefront renders? For the canonical product page the answer is
 * structural — it takes the composed {@link CanonicalProductPage}, which is the
 * literal response `/product-page/:idOrSlug` serves and the screen consumes.
 * For the others it is the same public read the screen's own API call makes.
 *
 * ## An offer nobody can place is not emitted
 *
 * `SeoOfferCheckout` needs to say where the purchase happens, and for some
 * rows Mercaria cannot: a native offer whose checkout verdict currently
 * refuses, or an external offer whose source published no destination at all.
 * Those rows are OMITTED from the facts rather than emitted with a guess. The
 * page still shows them — a shopper reads "this seller has it, you cannot buy
 * it here right now" — and structured data says nothing, because saying
 * anything would mean choosing between two false statements.
 *
 * That is a deliberate asymmetry: the facts may hold LESS than the page shows,
 * never more. `seo-visible-facts.test.ts` pins both directions.
 */

import type {
  Brand,
  CanonicalProduct,
  CanonicalProductPage,
  Listing,
  ProductPageOfferRow,
  SeoBreadcrumb,
  SeoOfferAvailability,
  SeoOfferCheckout,
  SeoOfferPrice,
  SeoVisibleFacts,
  SeoVisibleOffer,
} from '@mercaria/shared-types';
import type { OfferAvailability } from '@mercaria/shared-types';
import { resolveMedia } from '../catalog-hydration.service.js';
import { buildRoutePath, routeIsLive } from './routes.js';

/**
 * `OfferAvailability` → schema.org, with `unknown` and `unavailable` producing
 * NOTHING.
 *
 * `unknown` is obvious. `unavailable` is the interesting one: schema.org's
 * closest member is `Discontinued`, which is a statement about the PRODUCT, and
 * an offer being unavailable says nothing about whether the manufacturer still
 * makes it. Two different subjects, so no mapping.
 */
export function mapAvailability(availability: OfferAvailability): SeoOfferAvailability {
  switch (availability) {
    case 'in_stock':
      return { known: true, schema: 'https://schema.org/InStock' };
    case 'out_of_stock':
      return { known: true, schema: 'https://schema.org/OutOfStock' };
    case 'preorder':
      return { known: true, schema: 'https://schema.org/PreOrder' };
    case 'unavailable':
    case 'unknown':
      return { known: false };
  }
}

/** The image URLs a page displays, through the ONE media chokepoint. */
function imageUrlsOf(product: CanonicalProduct): string[] {
  return [...product.images]
    .sort((left, right) => left.position - right.position)
    .map((image) => image.fileId ?? image.sourceUrl)
    .filter((value): value is string => value !== undefined && value !== '')
    .map((value) => resolveMedia(value));
}

/** The GTIN-shaped identifiers a product page displays. */
function gtinsOf(product: CanonicalProduct): string[] {
  return product.identifiers
    .filter((identifier) => identifier.status === 'active')
    .filter((identifier) => identifier.canonicalScheme === 'gtin')
    .map((identifier) => identifier.canonicalValue)
    .filter((value): value is string => value !== undefined && value !== '');
}

/**
 * Where one offer row's purchase happens, or `undefined` when Mercaria cannot
 * say.
 *
 * The switch is on the page's own OUTBOUND union — the derived verdict the row
 * renders its button from — and never on the offer's raw fields. Reading
 * `offer.destinationUrl` here would be the second authority over "where does
 * this go" that #71's outbound seam exists to prevent, and
 * `seo-isolation.test.ts` fails the build on the attempt.
 */
function checkoutOf(row: ProductPageOfferRow, productPath: string): SeoOfferCheckout | undefined {
  const outbound = row.outbound;
  if (outbound.kind === 'native_checkout') {
    const query = new URLSearchParams({ variant: row.offer.canonicalVariantId });
    return { kind: 'mercaria', url: `${productPath}?${query.toString()}` };
  }
  if (outbound.kind === 'outbound') return { kind: 'external', host: outbound.destinationHost };
  return outbound.destinationHost === undefined
    ? undefined
    : { kind: 'external', host: outbound.destinationHost };
}

/** The seller name a row displays, when it names one. */
function sellerNameOf(row: ProductPageOfferRow): string | undefined {
  const seller = row.seller;
  switch (seller.kind) {
    case 'merchant':
      return seller.name;
    case 'native_store':
      return seller.name;
    case 'native_person':
      return seller.displayName;
    case 'unknown':
      return undefined;
  }
}

/** The comparison price a row shows, in the page's one comparison currency. */
function priceOf(row: ProductPageOfferRow): SeoOfferPrice {
  const itemPrice = row.ranked.cost.itemPrice;
  if (!itemPrice.known) return { known: false };
  return { known: true, amount: itemPrice.amount.amount, currency: itemPrice.amount.currency };
}

/**
 * Project the composed canonical product page.
 *
 * `brand` is passed in rather than read here: this module has no database
 * reach, which is what makes the parity argument above hold, and the caller has
 * already resolved the product's brand for the breadcrumb.
 */
export function productPageFacts(
  page: CanonicalProductPage,
  brand: Brand | undefined,
): SeoVisibleFacts {
  const product = page.product;
  const productPath = buildRoutePath('canonical_product', product.slug);

  const offers: SeoVisibleOffer[] = [];
  let offerCurrency: SeoVisibleFacts['offerCurrency'];
  if (page.offers.available) {
    offerCurrency = page.offers.comparisonCurrency;
    for (const row of page.offers.rows) {
      const checkout = checkoutOf(row, productPath);
      if (checkout === undefined) continue;
      const sellerName = sellerNameOf(row);
      offers.push({
        offerId: row.offer.id,
        checkout,
        price: priceOf(row),
        availability: mapAvailability(row.offer.availability),
        ...(sellerName === undefined ? {} : { sellerName }),
        conditionKey: row.offer.condition.key,
      });
    }
  }

  /**
   * The brand crumb appears only once the brand PAGE exists.
   *
   * A breadcrumb is composed HERE, on the server, so #330's typed-route union
   * cannot see it — that check covers a client `router.push` and nothing else.
   * A crumb pointing at `/brands/:slug` before #72 ships is a link that renders,
   * is emitted into `BreadcrumbList` and answers "This screen does not exist" —
   * to a shopper and to a crawler. Hence `routeIsLive`. The brand NAME still travels (`brandName`, and schema.org's
   * `Brand` node), because naming a brand is a fact about the product and
   * linking to it is a claim about the site.
   */
  const breadcrumbs: SeoBreadcrumb[] = [{ name: 'Home', path: buildRoutePath('home') }];
  if (brand !== undefined && routeIsLive('brand')) {
    breadcrumbs.push({ name: brand.name, path: buildRoutePath('brand', brand.slug) });
  }
  breadcrumbs.push({ name: product.name, path: productPath });

  return {
    title: product.name,
    ...(product.description === undefined ? {} : { description: product.description }),
    imageUrls: imageUrlsOf(product),
    breadcrumbs,
    entityName: product.name,
    ...(brand === undefined ? {} : { brandName: brand.name }),
    gtins: gtinsOf(product),
    ...(product.modelCode === undefined ? {} : { mpn: product.modelCode }),
    ...(product.ratingCount > 0
      ? { rating: { value: product.rating, count: product.ratingCount } }
      : {}),
    offers,
    ...(offerCurrency === undefined ? {} : { offerCurrency }),
    variantNames: page.variants
      .map((variant) => variant.name)
      .filter((name): name is string => name !== undefined && name !== ''),
  };
}

/**
 * Project a legacy native listing page.
 *
 * Its ONE offer is Mercaria's own — a native listing is bought here or nowhere
 * — so `checkout` is unconditionally the `mercaria` branch, pointing at this
 * listing's own address rather than at the canonical product's. That is the
 * accurate statement: this listing is what is being bought, whatever page
 * consolidates the indexing.
 *
 * A `sold` listing is served (its page still resolves, #75 legacy rule 1) and
 * emits `OutOfStock`, because `sold` is a fact about stock and not about the
 * page.
 */
export function listingPageFacts(listing: Listing): SeoVisibleFacts {
  const listingPath = buildRoutePath('legacy_listing', listing.id);
  const sellerName = listing.store?.name ?? listing.seller?.displayName;

  const offer: SeoVisibleOffer = {
    offerId: listing.id,
    checkout: { kind: 'mercaria', url: listingPath },
    price: { known: true, amount: listing.price.amount, currency: listing.price.currency },
    availability: {
      known: true,
      schema:
        listing.status === 'active'
          ? 'https://schema.org/InStock'
          : 'https://schema.org/OutOfStock',
    },
    ...(sellerName === undefined ? {} : { sellerName }),
    conditionKey: listing.itemCondition.key,
  };

  const imageUrls = listing.images
    .filter((image) => image.fileId !== '')
    .sort((left, right) => left.position - right.position)
    .map((image) => resolveMedia(image.fileId));

  return {
    title: listing.title,
    ...(listing.description === '' ? {} : { description: listing.description }),
    imageUrls,
    breadcrumbs: [
      { name: 'Home', path: buildRoutePath('home') },
      { name: listing.title, path: listingPath },
    ],
    entityName: listing.title,
    ...(listing.vendor === undefined || listing.vendor === ''
      ? {}
      : { brandName: listing.vendor }),
    gtins: [],
    offers: [offer],
    offerCurrency: listing.price.currency,
    variantNames: listing.variants
      .map((variant) => variant.title)
      .filter((title) => title !== ''),
  };
}

/**
 * What a brand or family page displays about itself.
 *
 * ONE shape for both, because the two pages render the same four facts about
 * different subjects — a name, a description, a mark and a catalogue. A second
 * near-identical projector is a second place to forget a field, and
 * `document.ts` already keeps them apart where it matters, by emitting a
 * `Brand` node for one and no entity node for the other.
 */
export interface CatalogueEntityFactsInput {
  readonly routeId: 'brand' | 'product_family';
  readonly slug: string;
  readonly name: string;
  readonly description: string | undefined;
  /** An Oxy media file id, when the entity carries a mark. */
  readonly logoFileId: string | undefined;
}

/**
 * Project a brand or a product family (#72).
 *
 * No offers and no identifiers: neither page is about acquiring one thing. Its
 * content is its CATALOGUE, so `assessCatalogueContent` — not
 * `assessVisibleContent` — is what decides whether it earns a result, exactly
 * as it does for a merchant.
 */
export function catalogueEntityFacts(input: CatalogueEntityFactsInput): SeoVisibleFacts {
  const path = buildRoutePath(input.routeId, input.slug);
  const description = (input.description ?? '').trim();
  return {
    title: input.name,
    ...(description === '' ? {} : { description }),
    imageUrls: input.logoFileId === undefined ? [] : [resolveMedia(input.logoFileId)],
    breadcrumbs: [
      { name: 'Home', path: buildRoutePath('home') },
      { name: input.name, path },
    ],
    entityName: input.name,
    gtins: [],
    offers: [],
    variantNames: [],
  };
}

/** One step of a category's ancestor trail, as the taxonomy orders them. */
export interface CategoryTrailStep {
  readonly slug: string;
  readonly name: string;
}

/** What a category landing page displays about the category itself (#367 step 9). */
export interface CategoryFactsInput {
  readonly slug: string;
  readonly name: string;
  /** Root-first, EXCLUDING the category itself. */
  readonly ancestors: readonly CategoryTrailStep[];
}

/**
 * Project a category landing page (#367 workstream 9).
 *
 * Its own builder rather than a widening of {@link catalogueEntityFacts}, and
 * the reason is the trail: a brand and a family sit directly under Home, while
 * a category's breadcrumb IS its ancestor chain — which is the one fact a
 * category page has that no other catalogue entity has. Widening the shared
 * builder would mean an optional ancestors parameter that two of its three
 * callers never pass.
 *
 * No image, no offers, no identifiers. A category page is a directory of what
 * is filed under it, so `assessCatalogueContent` judges it by that catalogue —
 * and emitting offers here would attach a price to a shelf.
 */
export function categoryPageFacts(input: CategoryFactsInput): SeoVisibleFacts {
  return {
    title: input.name,
    imageUrls: [],
    breadcrumbs: [
      { name: 'Home', path: buildRoutePath('home') },
      ...input.ancestors.map((step) => ({
        name: step.name,
        path: buildRoutePath('category_browse', step.slug),
      })),
      { name: input.name, path: buildRoutePath('category_browse', input.slug) },
    ],
    entityName: input.name,
    gtins: [],
    offers: [],
    variantNames: [],
  };
}

/** What a merchant page displays about the merchant itself. */
export interface MerchantFactsInput {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly rating: number;
  readonly ratingCount: number;
}

/**
 * Project a canonical merchant's page (#73).
 *
 * No image: a `Merchant` carries no logo of its own — #55's verified brand
 * relationships are what put a mark on a page, and a merchant's own row has no
 * media column to read. So the page shows a name, a description and a
 * catalogue, and `assessCatalogueContent` rather than `assessVisibleContent` is
 * what judges whether it is worth a search result.
 *
 * No offers either. A merchant page is a directory of what somebody sells, not
 * one purchase — a shopper buys on the PRODUCT page, and emitting offers here
 * would attach a price to the wrong subject.
 */
export function merchantPageFacts(merchant: MerchantFactsInput): SeoVisibleFacts {
  const path = buildRoutePath('merchant', merchant.slug);
  const description = (merchant.description ?? '').trim();
  return {
    title: merchant.name,
    ...(description === '' ? {} : { description }),
    imageUrls: [],
    breadcrumbs: [
      { name: 'Home', path: buildRoutePath('home') },
      { name: merchant.name, path },
    ],
    entityName: merchant.name,
    gtins: [],
    ...(merchant.ratingCount > 0
      ? { rating: { value: merchant.rating, count: merchant.ratingCount } }
      : {}),
    offers: [],
    variantNames: [],
  };
}

/** What a native store page displays about itself. */
export interface NativeStoreFactsInput {
  readonly handle: string;
  readonly name: string;
  readonly description: string;
  readonly logoFileId: string | null;
}

/** Project a native Mercaria store's own storefront. */
export function nativeStoreFacts(store: NativeStoreFactsInput): SeoVisibleFacts {
  const path = buildRoutePath('native_store', store.handle);
  return {
    title: store.name,
    ...(store.description.trim() === '' ? {} : { description: store.description }),
    imageUrls: store.logoFileId === null ? [] : [resolveMedia(store.logoFileId)],
    breadcrumbs: [
      { name: 'Home', path: buildRoutePath('home') },
      { name: store.name, path },
    ],
    entityName: store.name,
    gtins: [],
    offers: [],
    variantNames: [],
  };
}

/** The home page's own facts. Static, and deliberately so. */
export function homeFacts(tagline: string): SeoVisibleFacts {
  return {
    title: 'Mercaria',
    description: tagline,
    imageUrls: [],
    breadcrumbs: [],
    entityName: 'Mercaria',
    gtins: [],
    offers: [],
    variantNames: [],
  };
}

/**
 * The category index hub's own facts. Static, like the home page's.
 *
 * It does NOT enumerate the categories, and that is the point rather than an
 * omission: the tree is served by `GET /categories` and rendered by the screen,
 * so listing it again here would be a second copy that goes stale the moment an
 * operator publishes — in the one place (a `<title>`, a description, structured
 * data) where staleness is invisible until a crawler has already cached it.
 *
 * It carries a breadcrumb to Home, which the home page itself does not: a hub
 * one level down has a parent, and `BreadcrumbList` is what says so.
 */
export function categoryIndexFacts(title: string, description: string): SeoVisibleFacts {
  return {
    title,
    description,
    imageUrls: [],
    breadcrumbs: [
      { name: 'Home', path: buildRoutePath('home') },
      { name: title, path: buildRoutePath('category_index') },
    ],
    entityName: title,
    gtins: [],
    offers: [],
    variantNames: [],
  };
}
