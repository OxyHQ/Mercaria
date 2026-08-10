/**
 * JSON-LD (#75 §"Structured data") — built from {@link SeoVisibleFacts} and
 * from nothing else.
 *
 * ## Parity is architectural, not a review comment
 *
 * Every function here takes the SAME value the `<head>` composer takes and has
 * no other input: no repository, no config beyond the origin it is handed, no
 * offer DTO, no database. A fact that is not on the page is not in this
 * module's reach, so "emit only facts visible on the page" is a property of the
 * call graph. `seo-isolation.test.ts` scans for the imports that would break it
 * and `structured-data.test.ts` walks every emitted leaf back to a visible
 * fact.
 *
 * ## An external offer has no `url`, and cannot be given one
 *
 * `SeoOfferCheckout` is a two-branch union whose `external` branch carries a
 * HOSTNAME and no address (`@mercaria/shared-types`). There is nothing here
 * that could be put in `offers.url` for an external offer, which is #75
 * acceptance 4 — "external and native offer structured data accurately
 * describes where checkout occurs" — as a shape. The seller's name still
 * travels, because a shopper and a crawler both need to know who is selling;
 * what does not travel is any suggestion that the transaction happens here.
 *
 * ## Unknown emits NOTHING
 *
 * An offer with no known price contributes no `price` and is excluded from the
 * `AggregateOffer` bounds; an offer whose availability nobody published gets no
 * `availability` property. Not `0`, not `InStock`, not omitted-with-a-default —
 * absent. A rich result that says "€0" or "in stock" about something Mercaria
 * never observed is worse than no rich result.
 *
 * References followed: schema.org's Product/Offer/AggregateOffer vocabulary and
 * Google's product-snippet and merchant-listing guidance, both linked from the
 * issue.
 */

import type {
  CurrencyCode,
  ItemConditionKey,
  SeoJsonLdNode,
  SeoJsonLdValue,
  SeoVisibleFacts,
  SeoVisibleOffer,
} from '@mercaria/shared-types';
import { CURRENCY_PRECISION } from '@mercaria/shared-types';

const SCHEMA_CONTEXT = 'https://schema.org';

/**
 * #90's condition keys → schema.org's four.
 *
 * A total `Record`, so a tenth condition key is a compile error here rather
 * than a silent fall-through into `NewCondition`. Both refurbished keys map to
 * `RefurbishedCondition` because schema.org draws no manufacturer/seller
 * distinction; the page still shows which, and losing a distinction the
 * vocabulary cannot express is honest in a way inventing one would not be.
 *
 * `for_parts` maps to `DamagedCondition`, the closest true statement: schema.org
 * has no "sold for parts", and `UsedCondition` on a non-functional shell would
 * tell a shopper it works.
 */
const SCHEMA_CONDITION: Readonly<Record<ItemConditionKey, string>> = {
  new: 'https://schema.org/NewCondition',
  open_box: 'https://schema.org/NewCondition',
  refurbished_manufacturer: 'https://schema.org/RefurbishedCondition',
  refurbished_seller: 'https://schema.org/RefurbishedCondition',
  used_like_new: 'https://schema.org/UsedCondition',
  used_good: 'https://schema.org/UsedCondition',
  used_fair: 'https://schema.org/UsedCondition',
  used_poor: 'https://schema.org/UsedCondition',
  for_parts: 'https://schema.org/DamagedCondition',
};

/**
 * Minor units → the decimal string schema.org's `price` wants.
 *
 * Formatted through `CURRENCY_PRECISION`, so JPY emits `1200` and FAIR emits
 * eight decimals, and never through `toFixed` on a divided float — a division
 * by `10 ** 8` loses minor units at amounts a real FAIR price reaches.
 */
export function formatSchemaPrice(amount: number, currency: CurrencyCode): string {
  const precision = CURRENCY_PRECISION[currency];
  const negative = amount < 0;
  const digits = Math.abs(amount).toString().padStart(precision + 1, '0');
  const whole = digits.slice(0, digits.length - precision);
  const fraction = precision === 0 ? '' : `.${digits.slice(digits.length - precision)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** One `Offer` node, with a `url` exactly when checkout happens on Mercaria. */
function offerNode(offer: SeoVisibleOffer, currency: CurrencyCode): SeoJsonLdNode {
  const node: Record<string, SeoJsonLdValue> = { '@type': 'Offer' };

  if (offer.price.known) {
    node.price = formatSchemaPrice(offer.price.amount, currency);
    node.priceCurrency = currency;
  }
  if (offer.availability.known) node.availability = offer.availability.schema;
  if (offer.conditionKey !== undefined && offer.conditionKey in SCHEMA_CONDITION) {
    node.itemCondition = SCHEMA_CONDITION[offer.conditionKey as ItemConditionKey];
  }
  if (offer.sellerName !== undefined && offer.sellerName.trim() !== '') {
    node.seller = { '@type': 'Organization', name: offer.sellerName };
  }
  // The one asymmetry, and the point of the union: a Mercaria offer names the
  // address a shopper completes the purchase at, and an external one names the
  // host it happens on. Neither branch can produce the other's field.
  if (offer.checkout.kind === 'mercaria') {
    node.url = offer.checkout.url;
  } else {
    node.availableAtOrFrom = { '@type': 'Organization', url: `https://${offer.checkout.host}` };
  }
  return node;
}

/**
 * The `offers` property of a product, or `undefined` when the page shows none.
 *
 * `AggregateOffer` bounds are computed over the offers with a KNOWN price only,
 * and `offerCount` counts those same offers — the number a shopper could read
 * a price for. Counting every row while pricing a subset would put a range on
 * a page and a different count beside it.
 */
function offersProperty(facts: SeoVisibleFacts): SeoJsonLdValue | undefined {
  const currency = facts.offerCurrency;
  if (currency === undefined || facts.offers.length === 0) return undefined;

  const nodes = facts.offers.map((offer) => offerNode(offer, currency));
  if (nodes.length === 1) return nodes[0] as SeoJsonLdValue;

  const priced = facts.offers
    .map((offer) => (offer.price.known ? offer.price.amount : undefined))
    .filter((amount): amount is number => amount !== undefined);

  // No priced offer means no bounds exist. The rows still travel — a shopper
  // can see who sells it — and the aggregate carries no invented range.
  if (priced.length === 0) {
    return { '@type': 'AggregateOffer', priceCurrency: currency, offers: nodes };
  }

  return {
    '@type': 'AggregateOffer',
    priceCurrency: currency,
    lowPrice: formatSchemaPrice(Math.min(...priced), currency),
    highPrice: formatSchemaPrice(Math.max(...priced), currency),
    offerCount: priced.length,
    offers: nodes,
  };
}

/**
 * The `Product` node.
 *
 * `aggregateRating` is emitted only from a rating the page DISPLAYS, with the
 * count that produced it, and never with a count of zero: Google's own
 * guidance refuses a rating without a count, and a `0` there is a review
 * aggregate nobody wrote.
 */
export function productNode(facts: SeoVisibleFacts, canonicalUrl: string): SeoJsonLdNode {
  const node: Record<string, SeoJsonLdValue> = {
    '@context': SCHEMA_CONTEXT,
    '@type': 'Product',
    name: facts.entityName,
    url: canonicalUrl,
  };

  if (facts.description !== undefined && facts.description.trim() !== '') {
    node.description = facts.description;
  }
  if (facts.imageUrls.length > 0) node.image = [...facts.imageUrls];
  if (facts.brandName !== undefined && facts.brandName.trim() !== '') {
    node.brand = { '@type': 'Brand', name: facts.brandName };
  }
  if (facts.gtins.length > 0) node.gtin = [...facts.gtins];
  if (facts.mpn !== undefined && facts.mpn.trim() !== '') node.mpn = facts.mpn;
  if (facts.rating !== undefined && facts.rating.count > 0) {
    node.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: facts.rating.value,
      reviewCount: facts.rating.count,
    };
  }
  // The configurations the selector lists, as names. Not `hasVariant` nodes:
  // the page renders a control with names on it, and inventing a `ProductModel`
  // per name would assert identity the selector does not display.
  if (facts.variantNames.length > 0) {
    node.additionalProperty = facts.variantNames.map((name) => ({
      '@type': 'PropertyValue',
      name: 'Configuration',
      value: name,
    }));
  }

  const offers = offersProperty(facts);
  if (offers !== undefined) node.offers = offers;
  return node;
}

/**
 * An `Organization` node for a brand, a merchant or a native store.
 *
 * ONE builder for the three, with the `@type` supplied: schema.org's `Brand`
 * and `Organization` differ in type and in nothing else Mercaria can populate,
 * and a second near-identical function is a second place to forget a field.
 */
export function organizationNode(
  type: 'Brand' | 'Organization' | 'OnlineStore',
  facts: SeoVisibleFacts,
  canonicalUrl: string,
): SeoJsonLdNode {
  const node: Record<string, SeoJsonLdValue> = {
    '@context': SCHEMA_CONTEXT,
    '@type': type,
    name: facts.entityName,
    url: canonicalUrl,
  };
  if (facts.description !== undefined && facts.description.trim() !== '') {
    node.description = facts.description;
  }
  const logo = facts.imageUrls[0];
  if (logo !== undefined) node.logo = logo;
  if (facts.rating !== undefined && facts.rating.count > 0) {
    node.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: facts.rating.value,
      reviewCount: facts.rating.count,
    };
  }
  return node;
}

/** The `BreadcrumbList`, or `undefined` when the page renders no trail. */
export function breadcrumbNode(
  facts: SeoVisibleFacts,
  origin: string,
): SeoJsonLdNode | undefined {
  if (facts.breadcrumbs.length === 0) return undefined;
  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: facts.breadcrumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: new URL(crumb.path, origin).toString(),
    })),
  };
}

/** The `WebSite` node the home page carries, and no other page does. */
export function webSiteNode(siteName: string, origin: string): SeoJsonLdNode {
  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'WebSite',
    name: siteName,
    url: new URL('/', origin).toString(),
  };
}
