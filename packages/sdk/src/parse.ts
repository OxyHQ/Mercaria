import {
  ALL_CURRENCY_CODES,
  CONDITION_GROUPS,
  CONDITION_KEY_GROUP,
  ITEM_CONDITION_KEYS,
  MERCARIA_PRODUCT_AVAILABILITIES,
} from './contract';
import type {
  MercariaCollection,
  MercariaCollectionRef,
  MercariaImage,
  MercariaPage,
  MercariaProduct,
  MercariaProductCondition,
  MercariaProductRef,
  MercariaProductSummary,
  MercariaPurchaseOption,
  MercariaSeller,
  MercariaStore,
  MercariaStoreRef,
  MercariaVariantRef,
  Money,
} from './contract';

/**
 * Hand-written response parsers.
 *
 * ## Fresh objects, contract keys only
 *
 * Every parser READS the fields the contract names and WRITES a new object
 * holding exactly those. Nothing is spread and nothing is passed through, so a
 * field the server leaks tomorrow — a variant `sku`, a connector `source`, a
 * supplier reference — cannot reach an SDK DTO even if the backend's own
 * projection regresses. The backend builds its public DTOs field by field for
 * the same reason; this is the second, independent wall.
 *
 * ## Fail closed
 *
 * A missing required field, a wrong type, or a value outside a closed set (an
 * availability, a currency, a condition) is a {@link ParseFailure}, which the
 * transport reports as `MercariaResponseError` (`MALFORMED_RESPONSE`). The SDK
 * never guesses a default for a fact a consumer would render.
 *
 * ## One bad row fails the whole page
 *
 * A list page is rejected when any item is malformed, rather than dropping that
 * item. Dropping looks friendlier and is worse: `items.length` would stop
 * meaning what the server served, a consumer paginating by cursor would skip a
 * product without knowing it exists, and the drift that produced the bad row
 * would go unreported in exactly the place a contract test and a consumer's
 * error tracking would otherwise see it. A page that fails is loud, and the
 * caller can still retry or degrade.
 *
 * Messages name the PATH of the offending field (`items[3].price.currency`) and
 * what was expected — never the value received, which may be arbitrary server
 * data.
 */

/** A response body that is not the contract. Internal; the transport maps it. */
export class ParseFailure extends Error {
  constructor(
    readonly path: string,
    readonly expectation: string,
  ) {
    super(`${path}: expected ${expectation}`);
    this.name = 'ParseFailure';
  }
}

type Json = Record<string, unknown>;

function fail(path: string, expectation: string): never {
  throw new ParseFailure(path, expectation);
}

function object(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'an object');
  return value as Json;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'a string');
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(path, 'a non-empty string');
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'a boolean');
  return value;
}

function count(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(path, 'a non-negative safe integer');
  }
  return value;
}

/**
 * An absolute `http(s)` URL. Checked by pattern rather than `new URL()`, which
 * React Native only partially implements. Refusing every other scheme is what
 * keeps a `javascript:` value out of a consumer's `<img src>` or link.
 */
const HTTP_URL = /^https?:\/\/[^\s/?#]+[^\s]*$/i;

function httpUrl(value: unknown, path: string): string {
  if (typeof value !== 'string' || !HTTP_URL.test(value)) fail(path, 'an absolute http(s) URL');
  return value;
}

function nullableHttpUrl(value: unknown, path: string): string | null {
  return value === null ? null : httpUrl(value, path);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(path, `one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function array<T>(value: unknown, path: string, item: (entry: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) fail(path, 'an array');
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

// ── Refs ────────────────────────────────────────────────────────────────────

function kind(record: Json, expected: string, path: string): void {
  if (record.kind !== expected) fail(`${path}.kind`, `"${expected}"`);
}

export function parseProductRef(value: unknown, path: string): MercariaProductRef {
  const record = object(value, path);
  kind(record, 'product', path);
  return Object.freeze({ kind: 'product', id: nonEmptyString(record.id, `${path}.id`) });
}

export function parseVariantRef(value: unknown, path: string): MercariaVariantRef {
  const record = object(value, path);
  kind(record, 'variant', path);
  return Object.freeze({
    kind: 'variant',
    productId: nonEmptyString(record.productId, `${path}.productId`),
    variantId: nonEmptyString(record.variantId, `${path}.variantId`),
  });
}

export function parseStoreRef(value: unknown, path: string): MercariaStoreRef {
  const record = object(value, path);
  kind(record, 'store', path);
  return Object.freeze({ kind: 'store', id: nonEmptyString(record.id, `${path}.id`) });
}

export function parseCollectionRef(value: unknown, path: string): MercariaCollectionRef {
  const record = object(value, path);
  kind(record, 'collection', path);
  return Object.freeze({ kind: 'collection', id: nonEmptyString(record.id, `${path}.id`) });
}

// ── Presentation pieces ─────────────────────────────────────────────────────

function parseImage(value: unknown, path: string): MercariaImage {
  const record = object(value, path);
  return { url: httpUrl(record.url, `${path}.url`), alt: nullableString(record.alt, `${path}.alt`) };
}

function parseNullableImage(value: unknown, path: string): MercariaImage | null {
  return value === null ? null : parseImage(value, path);
}

/**
 * A price. `amount` is integer minor units, and every money value in this
 * contract is a PRICE, so a negative or fractional amount is malformed.
 */
function parseMoney(value: unknown, path: string): Money {
  const record = object(value, path);
  return {
    amount: count(record.amount, `${path}.amount`),
    currency: oneOf(record.currency, ALL_CURRENCY_CODES, `${path}.currency`),
  };
}

function parseNullableMoney(value: unknown, path: string): Money | null {
  return value === null ? null : parseMoney(value, path);
}

function parseCondition(value: unknown, path: string): MercariaProductCondition {
  const record = object(value, path);
  const key = oneOf(record.key, ITEM_CONDITION_KEYS, `${path}.key`);
  const group = oneOf(record.group, CONDITION_GROUPS, `${path}.group`);
  if (CONDITION_KEY_GROUP[key] !== group) fail(`${path}.group`, `the group of condition "${key}"`);
  return { key, group };
}

function parseSeller(value: unknown, path: string): MercariaSeller {
  const record = object(value, path);
  if (record.kind === 'store') {
    return {
      kind: 'store',
      store: parseStoreRef(record.store, `${path}.store`),
      handle: nonEmptyString(record.handle, `${path}.handle`),
      name: string(record.name, `${path}.name`),
      logoUrl: nullableHttpUrl(record.logoUrl, `${path}.logoUrl`),
    };
  }
  if (record.kind === 'person') {
    return {
      kind: 'person',
      oxyUserId: nonEmptyString(record.oxyUserId, `${path}.oxyUserId`),
      displayName: string(record.displayName, `${path}.displayName`),
      username: string(record.username, `${path}.username`),
      avatarUrl: nullableHttpUrl(record.avatarUrl, `${path}.avatarUrl`),
      isVerified: boolean(record.isVerified, `${path}.isVerified`),
    };
  }
  return fail(`${path}.kind`, '"store" or "person"');
}

// ── Products ────────────────────────────────────────────────────────────────

function parsePriceRange(value: unknown, path: string): { min: Money; max: Money } | null {
  if (value === null) return null;
  const record = object(value, path);
  return { min: parseMoney(record.min, `${path}.min`), max: parseMoney(record.max, `${path}.max`) };
}

function parsePurchaseOption(value: unknown, path: string, productId: string): MercariaPurchaseOption {
  const record = object(value, path);
  const ref = parseVariantRef(record.ref, `${path}.ref`);
  // A variant is resolved THROUGH its product, so an option naming another
  // product would make `resolveVariant` hand back the wrong thing.
  if (ref.productId !== productId) fail(`${path}.ref.productId`, 'the id of the product it belongs to');
  return {
    ref,
    title: string(record.title, `${path}.title`),
    price: parseMoney(record.price, `${path}.price`),
    compareAtPrice: parseNullableMoney(record.compareAtPrice, `${path}.compareAtPrice`),
    availability: oneOf(record.availability, ['in_stock', 'out_of_stock'] as const, `${path}.availability`),
  };
}

export function parseProductSummary(value: unknown, path: string): MercariaProductSummary {
  const record = object(value, path);
  return {
    ref: parseProductRef(record.ref, `${path}.ref`),
    title: string(record.title, `${path}.title`),
    primaryImage: parseNullableImage(record.primaryImage, `${path}.primaryImage`),
    price: parseMoney(record.price, `${path}.price`),
    compareAtPrice: parseNullableMoney(record.compareAtPrice, `${path}.compareAtPrice`),
    priceRange: parsePriceRange(record.priceRange, `${path}.priceRange`),
    availability: oneOf(record.availability, MERCARIA_PRODUCT_AVAILABILITIES, `${path}.availability`),
    condition: parseCondition(record.condition, `${path}.condition`),
    seller: parseSeller(record.seller, `${path}.seller`),
    url: httpUrl(record.url, `${path}.url`),
  };
}

/** ISO-8601 date-time: a `YYYY-MM-DDTHH:MM` prefix that `Date` can also read. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function isoDateTime(value: unknown, path: string): string {
  if (typeof value !== 'string' || !ISO_DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) {
    fail(path, 'an ISO-8601 date-time');
  }
  return value;
}

function parseViewer(value: unknown, path: string): { saved: boolean } | null {
  if (value === null) return null;
  const record = object(value, path);
  return { saved: boolean(record.saved, `${path}.saved`) };
}

export function parseProduct(value: unknown, path: string): MercariaProduct {
  const summary = parseProductSummary(value, path);
  const record = value as Json;
  return {
    ...summary,
    description: string(record.description, `${path}.description`),
    images: array(record.images, `${path}.images`, parseImage),
    purchaseOptions: array(record.purchaseOptions, `${path}.purchaseOptions`, (entry, entryPath) =>
      parsePurchaseOption(entry, entryPath, summary.ref.id),
    ),
    updatedAt: isoDateTime(record.updatedAt, `${path}.updatedAt`),
    viewer: parseViewer(record.viewer, `${path}.viewer`),
  };
}

// ── Stores and collections ──────────────────────────────────────────────────

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function parseStore(value: unknown, path: string): MercariaStore {
  const record = object(value, path);
  const brandColor = record.brandColor;
  if (typeof brandColor !== 'string' || !HEX_COLOR.test(brandColor)) {
    fail(`${path}.brandColor`, 'a CSS hex colour');
  }
  const rating = record.rating;
  if (rating !== null && (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 5)) {
    fail(`${path}.rating`, 'a number from 0 to 5, or null');
  }
  return {
    ref: parseStoreRef(record.ref, `${path}.ref`),
    handle: nonEmptyString(record.handle, `${path}.handle`),
    name: string(record.name, `${path}.name`),
    description: nullableString(record.description, `${path}.description`),
    logoUrl: nullableHttpUrl(record.logoUrl, `${path}.logoUrl`),
    coverImageUrl: nullableHttpUrl(record.coverImageUrl, `${path}.coverImageUrl`),
    brandColor,
    rating,
    reviewCount: count(record.reviewCount, `${path}.reviewCount`),
    url: httpUrl(record.url, `${path}.url`),
  };
}

export function parseCollection(value: unknown, path: string): MercariaCollection {
  const record = object(value, path);
  return {
    ref: parseCollectionRef(record.ref, `${path}.ref`),
    store: parseStoreRef(record.store, `${path}.store`),
    title: string(record.title, `${path}.title`),
    description: nullableString(record.description, `${path}.description`),
    image: parseNullableImage(record.image, `${path}.image`),
    url: httpUrl(record.url, `${path}.url`),
  };
}

// ── Pages ───────────────────────────────────────────────────────────────────

export function parsePage<T>(
  value: unknown,
  path: string,
  item: (entry: unknown, path: string) => T,
): MercariaPage<T> {
  const record = object(value, path);
  const nextCursor = record.nextCursor;
  if (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.length === 0)) {
    fail(`${path}.nextCursor`, 'a non-empty string or null');
  }
  return { items: array(record.items, `${path}.items`, item), nextCursor };
}
