/**
 * What a provider payload is allowed to leave behind — the ALLOW-list (#62
 * §"SourceRecord persistence", "large/raw source payload retention must be
 * bounded and justified").
 *
 * `services/payments/redact.ts` is the precedent and its sentence is the whole
 * argument: a deny-list is correct only until the provider adds a field, which
 * is exactly when a sensitive one appears. So nothing here inspects the raw
 * payload for things to remove. The raw payload is DIGESTED and discarded, and
 * what is stored is composed from `CATALOG_SOURCE_PAYLOAD_FIELDS` out of the
 * already-bounded normalized record.
 *
 * That is a stronger guarantee than redaction: a provider that starts returning
 * `access_token` beside its prices changes nothing about what Mercaria holds,
 * because no code path reads a key the allow-list does not name.
 *
 * ## The key NAMES are the matcher's read contract
 *
 * `services/matching/subject-loader.ts` already reads `title`, `brand`,
 * `model`, `gtin`, `ean`, `upc`, `isbn`, `mpn`, `sku`, `category`, `condition`
 * and `attributes` off a stored payload. Writing the projection in a second
 * vocabulary would leave every ingested record matching on a title and nothing
 * else — silently, since a missing field is just a NULL feature. The allow-list
 * is therefore that contract, extended with the offer-facing facts #57 needs,
 * and `ingestion-isolation.test.ts` pins the intersection so a rename on either
 * side fails the build.
 *
 * ## Retention is bounded and the bound is enforced
 *
 * `MAX_STORED_PAYLOAD_BYTES` is checked against the SERIALIZED form after
 * projection. It cannot realistically be hit by a record `canonicalizeNormalizedRecord`
 * has already bounded in every dimension — which is the point: the cap is the
 * floor under the caps, so a future field added without a length bound is
 * refused rather than stored.
 */

import { createHash } from 'node:crypto';
import type { NormalizedSourceRecord } from '@mercaria/shared-types';
import { CATALOG_SOURCE_PAYLOAD_FIELDS } from '@mercaria/shared-types';

/**
 * The ceiling on one stored payload.
 *
 * 32 KiB: an order of magnitude above the largest record the normalization
 * bounds can produce (a 4 KB description plus a 512-byte title plus two dozen
 * short strings), so hitting it means a bound was removed rather than a
 * provider being verbose.
 */
export const MAX_STORED_PAYLOAD_BYTES = 32 * 1024;

/** The stored payload's shape. Every key comes from the allow-list. */
export type StoredSourcePayload = Readonly<Record<string, unknown>>;

/** sha-256, lowercase hex — the shape every digest column CHECKs for. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * A digest of the RAW provider payload.
 *
 * The raw bytes are never stored, so this is what keeps a stored observation
 * traceable to what produced it: a provider replaying a delivery can be shown
 * to have sent identical bytes even though Mercaria kept none of them.
 *
 * `JSON.stringify` on an arbitrary value can throw (a circular structure, a
 * BigInt) — a provider payload is arbitrary by definition — so a value that
 * cannot be serialized digests its own type name instead of taking down the
 * page. A digest that says "something unserializable" is worth more than a
 * crash, and it is honest: two unserializable payloads are indistinguishable
 * here and the framework never claims otherwise.
 */
export function rawPayloadDigest(raw: unknown): string {
  try {
    return sha256Hex(JSON.stringify(raw) ?? 'undefined');
  } catch {
    return sha256Hex(`unserializable:${typeof raw}`);
  }
}

/**
 * Sort object keys recursively so the digest of one payload is stable.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * projections built in different field orders would hash differently — and the
 * content hash is the convergence key `source_records` deduplicates on. An
 * unstable hash there means every re-delivery of unchanged content mints a new
 * observation row, which looks exactly like a source that keeps changing.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Drop `undefined` entries so an absent fact never becomes a stored `null`. */
function present(entries: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Build the stored payload from a canonicalized record.
 *
 * The identifiers are FLATTENED into their scheme-named keys rather than kept
 * as an array, because that is the shape `subject-loader.ts` reads. A record
 * asserting two EANs keeps the first: a second value under one key is
 * unrepresentable in the loader's contract, and choosing one is better than
 * inventing a plural field it would ignore.
 */
export function buildStoredPayload(record: NormalizedSourceRecord): StoredSourcePayload {
  const identifiers = new Map<string, string>();
  for (const entry of record.identifiers) {
    if (!identifiers.has(entry.scheme)) identifiers.set(entry.scheme, entry.value);
  }

  const attributes: Record<string, string> = {};
  for (const option of record.options) attributes[option.name] = option.value;

  const payload = present({
    title: record.title,
    description: record.description,
    brand: record.brandHint,
    model: record.model,
    gtin: identifiers.get('gtin'),
    ean: identifiers.get('ean'),
    upc: identifiers.get('upc'),
    isbn: identifiers.get('isbn'),
    mpn: identifiers.get('mpn'),
    sku: record.merchantSku,
    category: record.categoryKey,
    condition: record.conditionLabel,
    attributes: record.options.length > 0 ? attributes : undefined,
    merchant: record.merchantHint,
    storefront: record.storefrontHint,
    price: record.price?.amount,
    currency: record.price?.currency,
    compareAtPrice: record.compareAtPrice?.amount,
    compareAtCurrency: record.compareAtPrice?.currency,
    availability: record.availability,
    availableQuantity: record.availableQuantity,
    delivery: record.delivery,
    returnPolicy: record.returnPolicy,
    country: record.country,
    region: record.region,
    language: record.language,
    media: record.media.length > 0 ? record.media : undefined,
    url: record.sourceUrl,
    affiliateUrl: record.affiliateUrl,
    sourceCreatedAt: record.sourceCreatedAt,
    sourceUpdatedAt: record.sourceUpdatedAt,
  });

  /**
   * The allow-list is applied to the RESULT, not merely used to build it.
   *
   * Composing from a fixed object literal already restricts the keys, so this
   * loop is redundant against today's code and is not redundant against
   * tomorrow's: a field spread in by somebody adding a group is dropped here
   * rather than stored, and the field-set test names the tuple as the
   * authority. A guarantee that depends on nobody using a spread is not a
   * guarantee.
   */
  const allowed = new Set<string>(CATALOG_SOURCE_PAYLOAD_FIELDS);
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!allowed.has(key)) continue;
    projected[key] = value;
  }
  return projected;
}

/** The stored payload plus the content hash `source_records` converges on. */
export interface RedactedObservation {
  readonly payload: StoredSourcePayload;
  /** sha-256 of the STORED payload — the fourth column of the observation unique. */
  readonly contentHash: string;
  /** sha-256 of the RAW payload — traceability without retention. */
  readonly rawDigest: string;
}

/**
 * Project, digest and bound one record.
 *
 * @returns `null` when the projection exceeds {@link MAX_STORED_PAYLOAD_BYTES},
 *   which the caller records as a `payload_too_large` rejection. Refusing is
 *   the right answer rather than truncating: a truncated payload hashes
 *   differently on every delivery of the same content, so the convergence key
 *   would stop converging and the source would mint an observation per refresh
 *   forever.
 */
export function redactSourceObservation(
  record: NormalizedSourceRecord,
  raw: unknown,
): RedactedObservation | null {
  const payload = buildStoredPayload(record);
  const serialized = stableStringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STORED_PAYLOAD_BYTES) return null;
  return {
    payload,
    contentHash: sha256Hex(serialized),
    rawDigest: rawPayloadDigest(raw),
  };
}
