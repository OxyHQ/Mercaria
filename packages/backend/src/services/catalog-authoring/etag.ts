/**
 * The deterministic validator an `AuthoringSchema` is cached on (ADR 0007 D10).
 *
 * D10 asks for "a deterministic hash used as the ETag", and the word that does
 * the work is DETERMINISTIC: Mercaria runs several ECS tasks, so two of them
 * composing the same schema must produce the same string or a `304` is a
 * coin toss and a client's cache is one task's opinion.
 *
 * ## Over the CONTENT, and over the DIMENSIONS
 *
 * {@link authoringEtag} hashes a canonical serialization — object keys sorted
 * recursively, `undefined` dropped — of the composed body TOGETHER with the
 * semantic dimensions it was composed under and the invalidation revisions it
 * read. Hashing `JSON.stringify(body)` alone would be deterministic only while
 * every object literal in the projection kept its property order, and a refactor
 * that moved one field would re-download every form for every merchant, silently,
 * with no test able to tell that from a real change.
 *
 * Including the dimensions is not redundant with the body carrying them. The
 * body carries the locale it RESOLVED in; two different requested locales that
 * both fell back to `en` produce identical bodies and must still be
 * distinguishable, because the next translation to land changes one of them and
 * not the other.
 *
 * Nothing time-varying may enter the hashed value. There is no clock reading in
 * the composition and none may be added — a `composedAt` would make every
 * request its own cache entry, which is a cache that has stopped working while
 * reporting success.
 */

import { createHash } from 'node:crypto';

/** A value that can appear in a composed authoring payload. */
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
 * Every semantic dimension a composition is keyed by.
 *
 * ADR 0007 D10 lists them — product type version, category, flow, policy,
 * locale, market — and this type is where "keyed by every semantic dimension"
 * stops being a sentence: a dimension that is not a property here cannot enter
 * the key, and `catalog-authoring-etag.test.ts` asserts that changing each one
 * INDIVIDUALLY changes the tag.
 *
 * `permissionFingerprint` is the "policy" member. It is a fingerprint rather
 * than the permission set itself because the set is a projection of the caller's
 * store membership: two callers with the same effective answer share a cache
 * entry, and a caller whose role changed does not.
 */
export interface AuthoringSchemaKey {
  readonly productTypeDefinitionId: string;
  /**
   * The version's LIFECYCLE, and it is a dimension rather than a detail (#611).
   *
   * `published` and `deprecated` are both frozen, so both are memoizable and
   * both share every other member of this key — the version's content does not
   * change when it is deprecated, so `revisions` does not move either. Without
   * this member a composition taken while the version was `published` is served
   * unchanged afterwards, reporting `lifecycle: 'published'` until the entry is
   * evicted or the process restarts.
   *
   * That is not a rare race: publication deprecates the incumbent in the SAME
   * transaction that publishes its successor, because the one-published-per-key
   * partial unique refuses the other order. So every publish diverges every
   * locale already in the memo.
   *
   * Keyed rather than invalidated, deliberately. There is no production
   * invalidation path in this module at all — the only `memo.clear()` is a test
   * seam — so an invalidate-on-transition fix would have to be remembered by
   * whoever writes the SECOND transition, and a key cannot be forgotten.
   */
  readonly lifecycle: string;
  readonly categoryId: string;
  readonly flow: string;
  readonly locale: string;
  readonly market: string;
  readonly permissionFingerprint: string;
  /**
   * `<subject>:<subjectId>=<revision>` for every subject the composition read,
   * SORTED. Sorted here rather than trusted from the caller: a map iteration
   * order that varied would make two tasks disagree, which is the one property
   * this whole module exists to guarantee.
   */
  readonly revisions: readonly string[];
}

/** The key's parts, with the revisions SORTED. One place, two consumers. */
function canonicalKeyParts(key: AuthoringSchemaKey): Serializable {
  return {
    productTypeDefinitionId: key.productTypeDefinitionId,
    lifecycle: key.lifecycle,
    categoryId: key.categoryId,
    flow: key.flow,
    locale: key.locale,
    market: key.market,
    permissionFingerprint: key.permissionFingerprint,
    // Sorted HERE rather than trusted from the caller: a map iteration order
    // that varied would make two tasks disagree, which is the one property this
    // whole module exists to guarantee.
    revisions: [...key.revisions].sort(),
  };
}

/** The stable string form of a key — also what a process-local memo is keyed by. */
export function authoringSchemaCacheKey(key: AuthoringSchemaKey): string {
  return canonicalize(canonicalKeyParts(key));
}

/**
 * A strong ETag over a composed schema, quoted as RFC 9110 requires.
 *
 * The key and the body are canonicalized TOGETHER, as one object, rather than
 * hashed as two strings with a separator between them. A separator has to be a
 * character neither half can contain, and both halves are JSON — where every
 * character can appear inside a string. Nesting them removes the question
 * instead of answering it, which is the only form that is unambiguous by
 * construction rather than by an argument about what an id can hold.
 */
export function authoringEtag(key: AuthoringSchemaKey, body: unknown): string {
  const digest = createHash('sha256')
    .update(canonicalize({ key: canonicalKeyParts(key), body: body as Serializable }))
    .digest('hex');
  return `"authschema-${digest.slice(0, 32)}"`;
}

/*
 * `authoringEtagMatches` used to live here and is GONE — a clean cut, not an
 * alias.
 *
 * It said of itself that the six lines also existed as `navigationEtagMatches`,
 * that the duplication was deliberate while there were only two, and that a
 * THIRD surface needing them is the point at which they stop being HTTP syntax
 * two files happen to spell and become a helper somebody owns. `/taxonomy`
 * (#367 Workstream 1's HTTP surface) is that third surface, so the owner now
 * exists: `lib/http/if-none-match.ts`, `ifNoneMatchMatches`.
 *
 * What did NOT move is what is actually authoring knowledge — the six dimensions
 * a composition is keyed by, and the `authschema-` prefix.
 */

/*
 * `variantAxisSignature` used to live here and is GONE — a clean cut, not an
 * alias.
 *
 * #367 step 4 landed `typedVariantSignature` (`services/variant-axes/signature.ts`),
 * which is the digest `native_variant_signatures` actually stores. Keeping a
 * second one here would have meant a draft and the variant it publishes into
 * disagreeing about which two variants are the same thing — the one fact this
 * whole epic exists to make unambiguous. The authoring domain calls step 4's
 * function and defines no digest of its own.
 */
