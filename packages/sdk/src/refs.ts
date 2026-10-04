import type { z } from 'zod';
import {
  MercariaCollectionRefSchema,
  MercariaLocationRefSchema,
  MercariaProductRefSchema,
  MercariaRefSchema,
  MercariaStoreRefSchema,
  MercariaVariantRefSchema,
} from './contract';
import type {
  MercariaCollectionRef,
  MercariaLocationRef,
  MercariaProductRef,
  MercariaRef,
  MercariaStoreRef,
  MercariaVariantRef,
} from './contract';
import { MercariaValidationError } from './errors';

/**
 * Portable references — what a consumer PERSISTS.
 *
 * A ref is identity and nothing else: no title, no price, no availability, no
 * store handle. Every helper here parses with the contract's ref schemas, which
 * are STRICT (exactly the contract's keys, non-blank string ids) and return a
 * FRESH, FROZEN object, so a ref can be stored, compared and passed around
 * without anything mutable riding along.
 */

/** Build a ref from its parts, or throw {@link MercariaValidationError} naming what was wrong. */
function build<T>(schema: z.ZodType<T>, value: object, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MercariaValidationError(`${what} must be a non-empty string`);
  return parsed.data;
}

/** A product ref. Throws {@link MercariaValidationError} for an empty id. */
export function productRef(id: string): MercariaProductRef {
  return build(MercariaProductRefSchema, { kind: 'product', id }, 'product id');
}

/** A variant (purchase option) ref. Throws {@link MercariaValidationError} for an empty id. */
export function variantRef(productId: string, variantId: string): MercariaVariantRef {
  return build(MercariaVariantRefSchema, { kind: 'variant', productId, variantId }, 'product id and variant id');
}

/** A store ref. Throws {@link MercariaValidationError} for an empty id. */
export function storeRef(id: string): MercariaStoreRef {
  return build(MercariaStoreRefSchema, { kind: 'store', id }, 'store id');
}

/** A collection ref. Throws {@link MercariaValidationError} for an empty id. */
export function collectionRef(id: string): MercariaCollectionRef {
  return build(MercariaCollectionRefSchema, { kind: 'collection', id }, 'collection id');
}

/** A location (shop front) ref. Throws {@link MercariaValidationError} for an empty id. */
export function locationRef(id: string): MercariaLocationRef {
  return build(MercariaLocationRefSchema, { kind: 'location', id }, 'location id');
}

/**
 * Parse an UNTRUSTED value — typically a ref read back from a consumer's own
 * database or a request body — into a ref.
 *
 * Strict on purpose: EXACTLY the contract's keys for its kind, and non-blank
 * string ids. Anything else — an extra key, a missing key, an unknown kind, a
 * numeric id, an array — is `null`. The result is a fresh frozen object, never
 * the input.
 */
export function parseMercariaRef(value: unknown): MercariaRef | null {
  // Plain data only: a class instance that happens to carry the keys is not a
  // ref somebody persisted.
  if (typeof value !== 'object' || value === null) return null;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return null;
  const parsed = MercariaRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Whether `value` is a well-formed ref, by exactly the rules of {@link parseMercariaRef}. */
export function isMercariaRef(value: unknown): value is MercariaRef {
  return parseMercariaRef(value) !== null;
}

/** The scheme prefix of the string form. */
const REF_STRING_SCHEME = 'mercaria';

/**
 * The stable string form of a ref, for consumers that store refs in a text
 * column or a URL:
 *
 * - `mercaria:product:<id>`
 * - `mercaria:variant:<productId>:<variantId>`
 * - `mercaria:store:<id>`
 * - `mercaria:collection:<id>`
 * - `mercaria:location:<id>`
 *
 * Each id is percent-encoded with `encodeURIComponent` (which encodes `:`), so
 * the form is unambiguous for any id and every ref has exactly ONE string —
 * safe to use as a uniqueness key. Throws {@link MercariaValidationError} for a
 * value that is not a well-formed ref.
 */
export function formatMercariaRef(ref: MercariaRef): string {
  const parsed = parseMercariaRef(ref);
  if (parsed === null) throw new MercariaValidationError('not a well-formed Mercaria ref');
  if (parsed.kind === 'variant') {
    return `${REF_STRING_SCHEME}:variant:${encodeURIComponent(parsed.productId)}:${encodeURIComponent(parsed.variantId)}`;
  }
  return `${REF_STRING_SCHEME}:${parsed.kind}:${encodeURIComponent(parsed.id)}`;
}

function decodeCanonical(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  // Only the canonical spelling is accepted, so `mercaria:product:a%62c` and
  // `mercaria:product:abc` cannot both name one product in a uniqueness key.
  return /\S/.test(decoded) && encodeURIComponent(decoded) === segment ? decoded : null;
}

/**
 * Parse the string form written by {@link formatMercariaRef}. Returns `null` for
 * anything that is not exactly that form (wrong scheme, unknown kind, wrong
 * segment count, empty or non-canonically encoded id).
 */
export function parseMercariaRefString(value: unknown): MercariaRef | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  if (parts[0] !== REF_STRING_SCHEME) return null;
  const kind = parts[1];

  if (kind === 'variant') {
    if (parts.length !== 4) return null;
    const productId = decodeCanonical(parts[2] ?? '');
    const variantId = decodeCanonical(parts[3] ?? '');
    return productId === null || variantId === null ? null : parseMercariaRef({ kind: 'variant', productId, variantId });
  }
  if (kind === 'product' || kind === 'store' || kind === 'collection' || kind === 'location') {
    if (parts.length !== 3) return null;
    const id = decodeCanonical(parts[2] ?? '');
    return id === null ? null : parseMercariaRef({ kind, id });
  }
  return null;
}
