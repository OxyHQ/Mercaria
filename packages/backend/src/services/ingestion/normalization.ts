/**
 * Normalization — issue #62 §"Normalization", all fifteen groups.
 *
 * An adapter produces a {@link NormalizedSourceRecord}; this module is what
 * makes two adapters' output COMPARABLE. It trims, bounds, folds case where
 * case is not meaning, dedupes, and drops anything it cannot read — and it
 * decides nothing about identity, because "normalization does not decide
 * canonical identity by itself; #58 owns matching" is the issue's own sentence
 * and this file has no access to a catalogue to disobey it with.
 *
 * ## The version is a CODE CONSTANT and not a table
 *
 * `CATALOG_BACKFILL_MAPPING_VERSION`'s reasoning verbatim: normalization is a
 * PROCEDURE, and a table would let somebody publish a version whose rules
 * nobody shipped. Every observation stores the version it was read under
 * (`source_records.normalization_version`), so bumping it schedules a
 * re-normalization rather than silently reinterpreting facts already stored —
 * the `attribute_definitions` contract, one domain over.
 *
 * ## Bounds are the framework's, not the adapter's
 *
 * Every length and array cap below applies to whatever an adapter returns. A
 * provider that starts publishing a 4 MB description does not get to decide how
 * much of Mercaria's storage that costs, and an adapter author does not have to
 * remember to truncate. This is also the first half of "do not dump unbounded
 * provider payloads into JSONB": by the time `redact.ts` runs, the record it
 * projects is already bounded in every dimension.
 */

import type {
  NormalizedSourceIdentifier,
  NormalizedSourceMoney,
  NormalizedSourceOption,
  NormalizedSourceRecord,
} from '@mercaria/shared-types';
import { NORMALIZED_IDENTIFIER_SCHEMES } from '@mercaria/shared-types';

/**
 * The normalization ruleset version.
 *
 * RAISE THIS whenever a change below would give a different answer for an input
 * already stored — a new fold, a different trim, a changed cap. Do not raise it
 * for a change that cannot: a new comment, a refactor, a bound that only ever
 * widens what was already accepted.
 */
export const NORMALIZATION_VERSION = 1;

/** Bounds. Each is a decision about how much of a provider's text is worth keeping. */
export const NORMALIZATION_LIMITS = {
  /** A product title. Longer than any real one and shorter than a description. */
  title: 512,
  /** A description. Enough to be useful on a comparison card; not the page. */
  description: 4_000,
  /** A brand, model, SKU, category or option name/value. */
  shortText: 200,
  /** A URL. Longer than any legitimate one after tracking parameters. */
  url: 2_048,
  /** An identifier value. A GTIN-14 is 14; an MPN is short by nature. */
  identifier: 64,
  /** How many identifiers one record may assert. */
  identifiers: 12,
  /** How many option assignments one record may carry. */
  options: 24,
  /** How many media references one record may carry. */
  media: 24,
} as const;

/** Trim, collapse internal whitespace, and drop what is left if it is empty. */
function cleanText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.slice(0, limit);
}

/**
 * Accept only an absolute `http`/`https` URL.
 *
 * A relative path, a `javascript:` scheme or a `data:` blob are all things a
 * provider can put in a URL field, and every one of them becomes a link
 * Mercaria would render. `URL` parsing rather than a regex, so the refusal is
 * the platform's own reading of the string and not an approximation of it.
 */
function cleanUrl(value: unknown): string | undefined {
  const text = cleanText(value, NORMALIZATION_LIMITS.url);
  if (text === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed.toString().slice(0, NORMALIZATION_LIMITS.url);
}

/** ISO 3166-1 alpha-2, upper-cased. Anything else is not a country code. */
function cleanCountry(value: unknown): string | undefined {
  const text = cleanText(value, 8);
  if (text === undefined) return undefined;
  const upper = text.toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : undefined;
}

/**
 * A currency code, upper-cased, in the SOURCE's own vocabulary.
 *
 * Shape-checked and NOT validated against `ALL_CURRENCY_CODES`, exactly as
 * `offers.price_currency` is (ADR 0002 D18's documented CHECK exception): an
 * external platform trades in whatever it trades in, and refusing the record
 * over a currency Mercaria does not present would break the observation rather
 * than the price.
 */
function cleanCurrency(value: unknown): string | undefined {
  const text = cleanText(value, 8);
  if (text === undefined) return undefined;
  const upper = text.toUpperCase();
  return /^[A-Z]{3,4}$/.test(upper) ? upper : undefined;
}

/**
 * A money pair, or nothing.
 *
 * An amount with no currency is not a price and a negative one is a parse
 * error; both become absence rather than a stored half-fact, which is the
 * `offers_price_paired_check` rule applied before the row is built. A
 * non-integer amount is refused outright: minor units are integers, and
 * rounding somebody's `19.989` here would invent a price nobody published.
 */
function cleanMoney(value: NormalizedSourceMoney | undefined): NormalizedSourceMoney | undefined {
  if (value === undefined) return undefined;
  const currency = cleanCurrency(value.currency);
  if (currency === undefined) return undefined;
  if (!Number.isSafeInteger(value.amount) || value.amount < 0) return undefined;
  return { amount: value.amount, currency };
}

/** A non-negative integer day count, or nothing. */
function cleanDays(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

/** An ISO-8601 instant the framework can actually parse, re-rendered canonically. */
function cleanInstant(value: unknown): string | undefined {
  const text = cleanText(value, 64);
  if (text === undefined) return undefined;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Identifiers, deduped on `(scheme, value)` and capped.
 *
 * Values are upper-cased and stripped of separators a provider might pretty
 * print with (`978-0-13-235088-4`), because an ISBN with hyphens and one
 * without are the same identifier and #58 validates the digits. The SCHEME is
 * never inferred from the value's length: `subject-loader.ts` says why — a
 * 12-digit value in a `gtin` field is refused as an EAN rather than silently
 * re-read as a UPC, and guessing is how a valid identifier for one product
 * becomes an invalid assertion about another.
 */
function cleanIdentifiers(
  values: readonly NormalizedSourceIdentifier[],
): NormalizedSourceIdentifier[] {
  const seen = new Set<string>();
  const result: NormalizedSourceIdentifier[] = [];
  for (const entry of values) {
    if (!NORMALIZED_IDENTIFIER_SCHEMES.includes(entry.scheme)) continue;
    const raw = cleanText(entry.value, NORMALIZATION_LIMITS.identifier);
    if (raw === undefined) continue;
    const value = raw.replace(/[\s-]/g, '').toUpperCase();
    if (value.length === 0) continue;
    const key = `${entry.scheme}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ scheme: entry.scheme, value });
    if (result.length >= NORMALIZATION_LIMITS.identifiers) break;
  }
  return result;
}

/** Option assignments, deduped on the NAME — a second "Colour" is a source bug. */
function cleanOptions(values: readonly NormalizedSourceOption[]): NormalizedSourceOption[] {
  const seen = new Set<string>();
  const result: NormalizedSourceOption[] = [];
  for (const entry of values) {
    const name = cleanText(entry.name, NORMALIZATION_LIMITS.shortText);
    const value = cleanText(entry.value, NORMALIZATION_LIMITS.shortText);
    if (name === undefined || value === undefined) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name, value });
    if (result.length >= NORMALIZATION_LIMITS.options) break;
  }
  return result;
}

/**
 * Media references: an absolute URL, or a bare Oxy file id.
 *
 * Both are legitimate — a crawled retailer publishes URLs and a merchant feed
 * that has already uploaded publishes file ids — and nothing else is. A
 * relative path is dropped rather than resolved against a base nobody supplied.
 */
function cleanMedia(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of values) {
    const url = cleanUrl(entry);
    const candidate = url ?? cleanText(entry, NORMALIZATION_LIMITS.shortText);
    if (candidate === undefined) continue;
    if (url === undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
    if (result.length >= NORMALIZATION_LIMITS.media) break;
  }
  return result;
}

/**
 * The canonical form of one adapter's record.
 *
 * Total: every input produces an output, and unreadable fields become ABSENT
 * rather than empty strings or zeroes. That distinction is #57's "unknown is
 * stored as absence, never zero" reaching back up the pipeline — a delivery
 * cost this function could not read must not arrive at the offer as free
 * delivery.
 *
 * The TITLE is the one field with no absent form, because a record with no
 * title is not a product observation. `ingest.service` rejects it with
 * `missing_title` rather than storing a record nothing can ever match.
 */
export function canonicalizeNormalizedRecord(
  record: NormalizedSourceRecord,
): NormalizedSourceRecord | null {
  const title = cleanText(record.title, NORMALIZATION_LIMITS.title);
  if (title === undefined) return null;

  const delivery = record.delivery;
  const deliveryCost = cleanMoney(delivery?.cost);
  const deliveryFreeOver = cleanMoney(delivery?.freeOver);
  const deliveryMinDays = cleanDays(delivery?.minDays);
  const deliveryMaxDays = cleanDays(delivery?.maxDays);
  const deliveryCleaned =
    deliveryCost === undefined &&
    deliveryFreeOver === undefined &&
    deliveryMinDays === undefined &&
    deliveryMaxDays === undefined
      ? undefined
      : {
          ...(deliveryCost === undefined ? {} : { cost: deliveryCost }),
          // A free-delivery threshold with no cost states nothing — it says
          // what you would stop paying without ever saying what you pay. The
          // offer table refuses that pair; dropping it here means the refusal
          // never has to fire.
          ...(deliveryFreeOver === undefined || deliveryCost === undefined
            ? {}
            : { freeOver: deliveryFreeOver }),
          ...(deliveryMinDays === undefined ? {} : { minDays: deliveryMinDays }),
          ...(deliveryMaxDays === undefined ? {} : { maxDays: deliveryMaxDays }),
        };

  const returnUrl = cleanUrl(record.returnPolicy?.url);
  const returnWindow = cleanDays(record.returnPolicy?.windowDays);
  const returnRef = cleanText(record.returnPolicy?.policyRef, NORMALIZATION_LIMITS.shortText);
  const returnPolicy =
    returnUrl === undefined && returnWindow === undefined && returnRef === undefined
      ? undefined
      : {
          ...(returnUrl === undefined ? {} : { url: returnUrl }),
          ...(returnWindow === undefined ? {} : { windowDays: returnWindow }),
          ...(returnRef === undefined ? {} : { policyRef: returnRef }),
        };

  const merchantHint = cleanText(record.merchantHint, NORMALIZATION_LIMITS.shortText);
  const storefrontHint = cleanText(record.storefrontHint, NORMALIZATION_LIMITS.shortText);
  const brandHint = cleanText(record.brandHint, NORMALIZATION_LIMITS.shortText);
  const description = cleanText(record.description, NORMALIZATION_LIMITS.description);
  const model = cleanText(record.model, NORMALIZATION_LIMITS.shortText);
  const merchantSku = cleanText(record.merchantSku, NORMALIZATION_LIMITS.shortText);
  const conditionLabel = cleanText(record.conditionLabel, NORMALIZATION_LIMITS.shortText);
  const price = cleanMoney(record.price);
  const compareAtPrice = cleanMoney(record.compareAtPrice);
  const availableQuantity =
    record.availableQuantity !== undefined &&
    Number.isSafeInteger(record.availableQuantity) &&
    record.availableQuantity >= 0
      ? record.availableQuantity
      : undefined;
  const country = cleanCountry(record.country);
  const region = cleanText(record.region, NORMALIZATION_LIMITS.shortText);
  const language = cleanText(record.language, 35);
  const sourceUrl = cleanUrl(record.sourceUrl);
  const affiliateUrl = cleanUrl(record.affiliateUrl);
  const categoryKey = cleanText(record.categoryKey, NORMALIZATION_LIMITS.shortText);
  const sourceCreatedAt = cleanInstant(record.sourceCreatedAt);
  const sourceUpdatedAt = cleanInstant(record.sourceUpdatedAt);

  return {
    title,
    identifiers: cleanIdentifiers(record.identifiers),
    options: cleanOptions(record.options),
    media: cleanMedia(record.media),
    ...(merchantHint === undefined ? {} : { merchantHint }),
    ...(storefrontHint === undefined ? {} : { storefrontHint }),
    ...(brandHint === undefined ? {} : { brandHint }),
    ...(description === undefined ? {} : { description }),
    ...(model === undefined ? {} : { model }),
    ...(merchantSku === undefined ? {} : { merchantSku }),
    ...(price === undefined ? {} : { price }),
    ...(compareAtPrice === undefined ? {} : { compareAtPrice }),
    ...(conditionLabel === undefined ? {} : { conditionLabel }),
    ...(record.availability === undefined ? {} : { availability: record.availability }),
    ...(availableQuantity === undefined ? {} : { availableQuantity }),
    ...(deliveryCleaned === undefined ? {} : { delivery: deliveryCleaned }),
    ...(returnPolicy === undefined ? {} : { returnPolicy }),
    ...(country === undefined ? {} : { country }),
    ...(region === undefined ? {} : { region }),
    ...(language === undefined ? {} : { language }),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ...(affiliateUrl === undefined ? {} : { affiliateUrl }),
    ...(categoryKey === undefined ? {} : { categoryKey }),
    ...(sourceCreatedAt === undefined ? {} : { sourceCreatedAt }),
    ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
  };
}
