/**
 * The deterministic validator the taxonomy reads are cached on.
 *
 * Mercaria runs several ECS tasks, so two of them answering the same taxonomy
 * request must produce the same tag or a `304` is a coin toss and a client's
 * cache is one task's opinion. Same property, same reason and same canonical
 * serialization as `services/catalog-authoring/etag.ts` and
 * `services/navigation/etag.ts`.
 *
 * ## Over the CONTENT and over the DIMENSIONS, and the dimensions are not redundant
 *
 * The hashed value is a canonical serialization — object keys sorted recursively,
 * `undefined` dropped — of the composed body TOGETHER with the READ it answers
 * and the semantic dimensions it was composed under. Hashing the body alone would
 * be deterministic only while every object literal in the projection kept its
 * property order, and a refactor moving one field would silently re-download the
 * whole taxonomy for every client.
 *
 * `read`, `subject` and `parameters` are NOT recoverable from the body, and that
 * is measured rather than argued: the children of a leaf, the descendants of that
 * same leaf, the children of a DIFFERENT leaf and the same read under a different
 * `limit` are all byte-identical empty pages, so a key missing any of the three
 * would let a `304` answer one question with another's cached body. Removing each
 * of them individually turns `catalog-api-contract.realdb.test.ts`'s
 * BYTE-IDENTICAL case red.
 *
 * `requestedLocale` is DIFFERENT and the difference is stated rather than implied:
 * no test can fail if it is removed. `LocalizedResolution` echoes the requested
 * locale inside every field it resolves, so two locales always produce different
 * BODIES and the tag differs through the body whatever this key does. Freezing it
 * here was mutation-tested and SURVIVED. It stays because the key is the wrong
 * place to depend on a payload's shape — a projection that stopped echoing the
 * locale would silently start sharing cache entries across languages — and
 * because a fallback-only difference is exactly what the next translation to land
 * changes. It is defence in depth, not the load-bearing dimension it would look
 * like otherwise.
 *
 * ## Nothing time-varying, and no caller identity
 *
 * There is no clock reading in the composition and none may be added — a
 * `composedAt` would make every request its own cache entry, which is a cache
 * that has stopped working while reporting success.
 *
 * There is also no permission fingerprint, unlike the authoring schema's key.
 * That is not an omission: this surface is anonymous and its answer is identical
 * for every reader, which is what lets the response be `Cache-Control: public`
 * and what makes one validator valid across callers. A caller dimension appearing
 * here would mean the surface had stopped being public and the header had become
 * a lie.
 *
 * The `If-None-Match` comparison is NOT here. It is HTTP syntax and its owner is
 * `lib/http/if-none-match.ts` — this module was the third surface that needed it,
 * which is the condition the authoring module named for consolidating it.
 */

import { createHash } from 'node:crypto';

/** A value that can appear in a composed taxonomy payload. */
type Serializable =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly Serializable[]
  | { readonly [key: string]: Serializable };

/** JSON with every object's keys in sorted order, and `undefined` dropped. */
function canonicalize(value: Serializable): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalize(element as Serializable)).join(',')}]`;
  }
  const record = value as { readonly [key: string]: Serializable };
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

/**
 * Every dimension a taxonomy read is keyed by.
 *
 * A dimension that is not a property here cannot enter the key, and
 * `taxonomy-etag.test.ts` asserts that changing each one INDIVIDUALLY changes the
 * tag — a single "change everything" case passes with all but one dimension
 * missing.
 */
export interface TaxonomyEtagKey {
  /** Which read — `roots`, `children`, `ancestors`, `search`, … */
  readonly read: string;
  /**
   * What the read is ABOUT: a category id, a key, or a query string.
   *
   * `null` for a read with no subject (`roots`). Never coerced to a string: a
   * subject literally spelled `"null"` and an absent subject are different reads
   * and `canonicalize` renders them differently.
   */
  readonly subject: string | null;
  /** Folded, verbatim as requested — not the locale that answered. */
  readonly requestedLocale: string;
  /** Every remaining request parameter that can change the answer. */
  readonly parameters: { readonly [key: string]: string | number | boolean | null };
}

/** The key's parts, in one place so the tag and a memo key cannot disagree. */
function canonicalKeyParts(key: TaxonomyEtagKey): Serializable {
  return {
    read: key.read,
    subject: key.subject,
    requestedLocale: key.requestedLocale,
    parameters: key.parameters,
  };
}

/** The stable string form of a key. */
export function taxonomyReadCacheKey(key: TaxonomyEtagKey): string {
  return canonicalize(canonicalKeyParts(key));
}

/**
 * A strong ETag over a composed taxonomy read, quoted as RFC 9110 requires.
 *
 * The key and the body are canonicalized TOGETHER, as ONE NESTED object, rather
 * than hashed as two strings with a separator between them. A separator has to be
 * a character neither half can contain, and both halves are JSON — where every
 * character can appear inside a string. Nesting removes the question instead of
 * answering it.
 */
export function taxonomyEtag(key: TaxonomyEtagKey, body: unknown): string {
  const digest = createHash('sha256')
    .update(canonicalize({ key: canonicalKeyParts(key), body: body as Serializable }))
    .digest('hex');
  return `"tax-${digest.slice(0, 32)}"`;
}
