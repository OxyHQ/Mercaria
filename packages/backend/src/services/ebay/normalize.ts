/**
 * eBay's item shapes → #62's `NormalizedSourceRecord` — issue #65 adapter rules
 * 3 and 4.
 *
 * ## THREE identities, mapped as three things (issue acceptance 2)
 *
 * This is eBay's distinguishing strength over every other candidate in #64, and
 * it is the reason the whole `per_record` seller-identity path exists:
 *
 *  - The **marketplace operator** is eBay itself. It is the merchant bound to
 *    the SOURCE (`catalog_source_configs.merchant_id`), set once by an operator.
 *    Nothing in this file names it.
 *  - The **storefront** is the marketplace channel — eBay Spain — bound to the
 *    source too, and owned by the operator merchant. Nothing here names it
 *    either. `storefrontHint` carries eBay's own words (the marketplace id) as
 *    provenance, and resolves nothing.
 *  - The **seller** is `seller.username`, per item, and it goes into
 *    `merchantHint`. That is the field #62 defines as "the source's own words
 *    for who is selling. A HINT; it resolves nothing" — and on a `per_record`
 *    source the pipeline turns it into a merchant through
 *    `marketplace_seller_identities`, never here.
 *
 * ADR 0002 D8 then derives marketplace-ness by comparing the offer's merchant
 * against `storefronts.merchant_id`, which is one join away. So "Sold by Shop X
 * on eBay" and "Sold by eBay" are different rows rather than one row with a
 * flag, and twenty sellers of one product produce twenty offers under one
 * canonical variant.
 *
 * ## The condition carried is the ID, never the display text
 *
 * eBay returns `conditionId` (a stable code from a closed enumeration) and
 * `condition` (its LOCALIZED display name — "Used" on EBAY_GB, "Usado" on
 * EBAY_ES, for the identical `3000`). #90 maps a source's wording to a taxonomy
 * key through a per-provider ruleset keyed on the normalized label, so a ruleset
 * written against display text would need one rule per language per condition
 * and would silently answer `unmapped` for every market nobody wrote rules for.
 * The id is the same everywhere, which is the only property a lookup key needs.
 *
 * ## Everything absent stays ABSENT
 *
 * #62's rule and #57's, reaching back up the pipeline: a delivery cost this
 * function could not read must not arrive at the offer as free delivery, and an
 * item with no quantity must not arrive as zero. Every optional group here is
 * omitted rather than defaulted, and `canonicalizeNormalizedRecord` bounds
 * whatever does come through.
 *
 * ## Money is minor units, and the parse refuses rather than rounds
 *
 * eBay publishes prices as decimal STRINGS with a separate currency
 * (`{"value":"19.99","currency":"EUR"}`). `parseEbayMoney` converts to minor
 * units using the currency's own precision and refuses anything it cannot read
 * exactly — a price that needed rounding is a price nobody published, and
 * `MAX_MONEY_MINOR_UNITS` bounds the result because `Number` accepts `1e300`
 * and a `bigint({mode:'number'})` column does not.
 */

import type {
  NormalizedSourceIdentifier,
  NormalizedSourceMoney,
  NormalizedSourceOption,
  NormalizedSourceRecord,
  OfferAvailability,
} from '@mercaria/shared-types';
import {
  CURRENCY_PRECISION,
  MAX_MONEY_MINOR_UNITS,
  type CurrencyCode,
} from '@mercaria/shared-types';
import { chooseEbayDestination } from './attribution.js';

/** One `{value, currency}` pair as the Browse API publishes it. */
export interface EbayAmount {
  readonly value?: unknown;
  readonly currency?: unknown;
}

/** The subset of an eBay item this integration reads. Nothing else is touched. */
export interface EbayItem {
  readonly itemId?: unknown;
  readonly legacyItemId?: unknown;
  readonly title?: unknown;
  readonly shortDescription?: unknown;
  readonly description?: unknown;
  readonly condition?: unknown;
  readonly conditionId?: unknown;
  readonly price?: EbayAmount;
  readonly marketingPrice?: { readonly originalPrice?: EbayAmount };
  readonly itemWebUrl?: unknown;
  readonly itemAffiliateWebUrl?: unknown;
  readonly image?: { readonly imageUrl?: unknown };
  readonly additionalImages?: readonly { readonly imageUrl?: unknown }[];
  readonly seller?: {
    readonly username?: unknown;
    readonly feedbackPercentage?: unknown;
    readonly feedbackScore?: unknown;
  };
  readonly brand?: unknown;
  readonly mpn?: unknown;
  readonly gtin?: unknown;
  readonly epid?: unknown;
  readonly categoryPath?: unknown;
  readonly categoryId?: unknown;
  readonly leafCategoryIds?: readonly unknown[];
  readonly estimatedAvailabilities?: readonly {
    readonly estimatedAvailabilityStatus?: unknown;
    readonly estimatedAvailableQuantity?: unknown;
  }[];
  readonly itemLocation?: { readonly country?: unknown; readonly stateOrProvince?: unknown };
  readonly shippingOptions?: readonly {
    readonly shippingCost?: EbayAmount;
    readonly minEstimatedDeliveryDate?: unknown;
    readonly maxEstimatedDeliveryDate?: unknown;
  }[];
  readonly returnTerms?: { readonly returnPeriod?: { readonly value?: unknown } };
  readonly localizedAspects?: readonly {
    readonly name?: unknown;
    readonly value?: unknown;
  }[];
  readonly itemCreationDate?: unknown;
  readonly itemEndDate?: unknown;
}

/** What one normalized eBay item carries beyond the framework record. */
export interface EbayNormalizedItem {
  readonly externalId: string;
  readonly record: NormalizedSourceRecord;
  /** Whether eBay minted an affiliate destination for it. Feeds the attribution detector. */
  readonly hasAffiliateUrl: boolean;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Convert one eBay decimal-string amount to minor units.
 *
 * Refuses rather than rounds, and refuses rather than truncates: `19.9999` in a
 * two-decimal currency is not `1999` — it is a value this integration cannot
 * read, and inventing a price for it is exactly the "anomalous change" #62
 * quarantines observations over. An unknown currency code is also a refusal,
 * because minor units are meaningless without a precision.
 */
export function parseEbayMoney(amount: EbayAmount | undefined): NormalizedSourceMoney | undefined {
  if (amount === undefined) return undefined;
  const currency = text(amount.currency)?.toUpperCase();
  const raw = text(amount.value);
  if (currency === undefined || raw === undefined) return undefined;
  if (!/^\d+(\.\d+)?$/u.test(raw)) return undefined;

  const precision = CURRENCY_PRECISION[currency as CurrencyCode];
  if (precision === undefined) return undefined;

  const [whole = '0', fraction = ''] = raw.split('.');
  if (fraction.length > precision) {
    // More decimal places than the currency has. Reading it would round somebody
    // else's published price.
    if (!/^0+$/u.test(fraction.slice(precision))) return undefined;
  }
  const padded = fraction.slice(0, precision).padEnd(precision, '0');
  const minor = Number(`${whole}${padded}`);
  if (!Number.isSafeInteger(minor) || minor < 0 || minor > MAX_MONEY_MINOR_UNITS) return undefined;
  return { amount: minor, currency };
}

/**
 * eBay's availability vocabulary → #57's.
 *
 * `IN_STOCK` and `OUT_OF_STOCK` are eBay's own; `LIMITED_STOCK` is still in
 * stock, and reading it as anything else would delist an item somebody can buy.
 * Anything unrecognised is `undefined`, which #62 turns into absence and #57
 * stores as `unknown` — never `in_stock`, which is how a comparison surface
 * starts sending buyers to pages that cannot sell them anything.
 */
export function parseEbayAvailability(value: unknown): OfferAvailability | undefined {
  const raw = text(value)?.toUpperCase();
  if (raw === undefined) return undefined;
  if (raw === 'IN_STOCK' || raw === 'LIMITED_STOCK') return 'in_stock';
  if (raw === 'OUT_OF_STOCK') return 'out_of_stock';
  return undefined;
}

/** A whole, non-negative quantity, or nothing. eBay omits it more often than not. */
function parseQuantity(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

/**
 * Whole days between two ISO instants, rounded UP, or nothing.
 *
 * eBay publishes delivery ESTIMATES as dates rather than as a window in days,
 * and #57 stores days. Rounding up is the honest direction for a promise: a
 * window that arrives a day later than advertised is a complaint, and one that
 * arrives a day early is not.
 */
function daysUntil(from: Date, iso: unknown): number | undefined {
  const raw = text(iso);
  if (raw === undefined) return undefined;
  const target = new Date(raw);
  if (Number.isNaN(target.getTime())) return undefined;
  const deltaMs = target.getTime() - from.getTime();
  if (deltaMs < 0) return undefined;
  return Math.ceil(deltaMs / 86_400_000);
}

/**
 * Identifier assertions, in the SOURCE's own schemes.
 *
 * The scheme is never inferred from a value's length — `subject-loader.ts`'s
 * rule, and #62's normalizer restates it: a 12-digit value in a `gtin` field is
 * refused as an EAN rather than silently re-read as a UPC, because guessing is
 * how a valid identifier for one product becomes an invalid assertion about
 * another. eBay publishes `gtin` and `mpn` under those names, so both are taken
 * at their word and #58 validates the digits.
 *
 * `epid` — eBay's own product id — is deliberately NOT an identifier here.
 * `NormalizedIdentifierScheme` names global standards, and an eBay product id is
 * a key in eBay's own space: asserting it as one would put a value into a
 * namespace #58 matches ACROSS sources, where it means nothing to anybody else.
 */
function parseIdentifiers(item: EbayItem): NormalizedSourceIdentifier[] {
  const identifiers: NormalizedSourceIdentifier[] = [];
  const gtin = text(item.gtin);
  if (gtin !== undefined) identifiers.push({ scheme: 'gtin', value: gtin });
  const mpn = text(item.mpn);
  if (mpn !== undefined) identifiers.push({ scheme: 'mpn', value: mpn });
  return identifiers;
}

/**
 * Item aspects → option assignments.
 *
 * eBay's `localizedAspects` are the closest thing it publishes to structured
 * facts, and they are LOCALIZED in both name and value. They are carried anyway,
 * because #62's normalizer dedupes and bounds them and #58 scores an attribute
 * agreement rather than requiring an exact vocabulary — but they are the reason
 * this integration does not claim to fill #94's attribute registry, which needs
 * a stable key and a unit.
 */
function parseOptions(item: EbayItem): NormalizedSourceOption[] {
  const options: NormalizedSourceOption[] = [];
  for (const aspect of item.localizedAspects ?? []) {
    const name = text(aspect.name);
    const value = text(aspect.value);
    if (name === undefined || value === undefined) continue;
    options.push({ name, value });
  }
  return options;
}

/** Every image URL the item published, primary first. */
function parseMedia(item: EbayItem): string[] {
  const media: string[] = [];
  const primary = text(item.image?.imageUrl);
  if (primary !== undefined) media.push(primary);
  for (const extra of item.additionalImages ?? []) {
    const url = text(extra.imageUrl);
    if (url !== undefined) media.push(url);
  }
  return media;
}

/**
 * The category key an eBay item belongs to.
 *
 * `categoryPath` when eBay published one (`Electronics|Phones|Smartphones`),
 * else the leaf category id. It is a source-scoped key that #58 scores a
 * category agreement on; it is never read as a Mercaria category.
 */
function parseCategoryKey(item: EbayItem): string | undefined {
  const path = text(item.categoryPath);
  if (path !== undefined) return path;
  const leaf = item.leafCategoryIds?.[0];
  return text(leaf) ?? text(item.categoryId);
}

/**
 * One eBay item → one normalized record, or `null` if there is nothing to
 * observe.
 *
 * `null` ONLY when the item carries no id. A missing TITLE is deliberately not a
 * refusal here: the record is emitted with an empty title and #62's own intake
 * rejects it as `missing_title` AGAINST ITS EXTERNAL ID, which is a rejection an
 * operator can trace back to a listing. Dropping it here would produce a page
 * whose counters silently disagree with what eBay sent, and
 * `catalog_source_runs_intake_total_check` exists precisely so a swallowed
 * record cannot happen quietly. With no id there is nothing to attribute a
 * rejection to, which is the one case worth dropping.
 *
 * Everything else degrades to absence, because an item with no brand is an item
 * with no brand and #58 rule 5 leaves an unknown feature out of the confidence
 * denominator rather than reading it as a zero.
 */
export function normalizeEbayItem(input: {
  item: EbayItem;
  marketplaceId: string;
  now: Date;
}): EbayNormalizedItem | null {
  const { item, marketplaceId, now } = input;

  const externalId = text(item.itemId) ?? text(item.legacyItemId);
  if (externalId === undefined) return null;
  const title = text(item.title) ?? '';

  const plainUrl = text(item.itemWebUrl);
  const affiliateUrl = text(item.itemAffiliateWebUrl);
  const destination = chooseEbayDestination({
    affiliateWebUrl: affiliateUrl,
    itemWebUrl: plainUrl,
  });
  /**
   * The offer's stored destination is the ORIGINAL page whenever eBay published
   * one (#57's rule: `destination_url` stays the ORIGINAL, and #67's redirect
   * hands over eBay's own attributed URL when there is one and this plain link
   * otherwise — verbatim either way, so a routing bug degrades to the plain
   * link instead of a dead one).
   *
   * When eBay published ONLY the attributed URL, that is the only address for
   * the item there is. Storing nothing would turn a perfectly good offer into an
   * `informational` one with no way to reach it, which is a worse answer than
   * storing the address the provider gave.
   */
  const sourceUrl = plainUrl ?? destination?.url;

  const availability = item.estimatedAvailabilities?.[0];
  const shipping = item.shippingOptions?.[0];
  const deliveryCost = parseEbayMoney(shipping?.shippingCost);
  const minDays = daysUntil(now, shipping?.minEstimatedDeliveryDate);
  const maxDays = daysUntil(now, shipping?.maxEstimatedDeliveryDate);
  const delivery =
    deliveryCost === undefined && minDays === undefined && maxDays === undefined
      ? undefined
      : {
          ...(deliveryCost === undefined ? {} : { cost: deliveryCost }),
          ...(minDays === undefined ? {} : { minDays }),
          ...(maxDays === undefined ? {} : { maxDays }),
        };

  const returnDays = item.returnTerms?.returnPeriod?.value;
  const returnPolicy =
    typeof returnDays === 'number' && Number.isSafeInteger(returnDays) && returnDays >= 0
      ? { windowDays: returnDays }
      : undefined;

  const price = parseEbayMoney(item.price);
  const compareAtPrice = parseEbayMoney(item.marketingPrice?.originalPrice);
  const description = text(item.shortDescription) ?? text(item.description);
  const brandHint = text(item.brand);
  const sellerUsername = text(item.seller?.username);
  const country = text(item.itemLocation?.country)?.toUpperCase();
  const region = text(item.itemLocation?.stateOrProvince);
  const quantity = parseQuantity(availability?.estimatedAvailableQuantity);
  const parsedAvailability = parseEbayAvailability(availability?.estimatedAvailabilityStatus);
  const categoryKey = parseCategoryKey(item);
  // The stable CONDITION ID, never the localized display name. See the docblock.
  const conditionLabel = text(item.conditionId);
  const createdAt = text(item.itemCreationDate);

  const options = parseOptions(item);
  const media = parseMedia(item);

  const record: NormalizedSourceRecord = {
    title,
    identifiers: parseIdentifiers(item),
    options,
    media,
    // The SELLER, per item — issue acceptance 2. Never the marketplace.
    ...(sellerUsername === undefined ? {} : { merchantHint: sellerUsername }),
    // eBay's own words for the channel. Provenance; it resolves nothing.
    storefrontHint: marketplaceId,
    ...(brandHint === undefined ? {} : { brandHint }),
    ...(description === undefined ? {} : { description }),
    ...(price === undefined ? {} : { price }),
    ...(compareAtPrice === undefined ? {} : { compareAtPrice }),
    ...(conditionLabel === undefined ? {} : { conditionLabel }),
    ...(parsedAvailability === undefined ? {} : { availability: parsedAvailability }),
    ...(quantity === undefined ? {} : { availableQuantity: quantity }),
    ...(delivery === undefined ? {} : { delivery }),
    ...(returnPolicy === undefined ? {} : { returnPolicy }),
    ...(country === undefined ? {} : { country }),
    ...(region === undefined ? {} : { region }),
    ...(categoryKey === undefined ? {} : { categoryKey }),
    ...(createdAt === undefined ? {} : { sourceCreatedAt: createdAt }),
    // Both addresses come out of the response body and neither is composed here.
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ...(affiliateUrl === undefined ? {} : { affiliateUrl }),
  };

  return {
    externalId,
    record,
    hasAffiliateUrl: destination !== null && destination.kind === 'affiliate',
  };
}
