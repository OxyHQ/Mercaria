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

/**
 * Whether an `If-None-Match` header matches the ETag we would serve.
 *
 * Handles the list form and `*`, and compares a `W/`-prefixed candidate on its
 * opaque part: a client that received a strong tag and echoes it weakly is still
 * telling us it holds this exact content, and answering 200 would send the whole
 * schema again on every keystroke that reopened the form.
 *
 * These six lines also exist as `navigationEtagMatches`, and the duplication is
 * deliberate rather than an oversight: an `If-None-Match` comparison is HTTP
 * syntax, not a fact about either domain, and importing a `navigation`-named
 * function into the authoring domain would assert a dependency between two
 * modules that share nothing. If a THIRD surface needs it, it stops being HTTP
 * syntax two files happen to spell and becomes a helper somebody owns — that is
 * the point at which to consolidate, and not before.
 */
export function authoringEtagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  const candidates = ifNoneMatch.split(',').map((value) => value.trim());
  if (candidates.includes('*')) return true;
  const strip = (value: string): string => (value.startsWith('W/') ? value.slice(2) : value);
  return candidates.some((candidate) => strip(candidate) === strip(etag));
}

/**
 * The order-independent digest of one variant's axis assignments (ADR 0007 D6).
 *
 * The normalized set of `(attributeDefinitionId, normalizedValue)` pairs, sorted
 * and hashed, so two variants whose axes were entered in different orders
 * collide by construction rather than by a service comparing lists. It is the
 * same shape `canonical_variants.signature` uses one domain over — a 64-character
 * lowercase sha-256 hex digest — deliberately, so a draft's signature and the
 * canonical one it may eventually be matched against are the same KIND of value.
 *
 * A DUPLICATE pair is a defect rather than a set member: the value repository's
 * partial uniques make one impossible to store, and collapsing one here would
 * hide a variant that had somehow acquired two answers for one axis.
 */
export function variantAxisSignature(
  pairs: readonly { readonly attributeDefinitionId: string; readonly normalizedValue: string }[],
): string {
  const rendered = pairs
    .map((pair): [string, string] => [pair.attributeDefinitionId, pair.normalizedValue])
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  // JSON rather than a joined string, for the reason `authoringEtag` gives. A
  // normalized value may contain a space — `normalizedAxisValue` folds case and
  // trims, and keeps inner whitespace — so a joined `a=x b=y` is produced BOTH
  // by two pairs and by one pair whose value is `x b=y`, which is a real if
  // unlikely collision between two different variants. An array of pairs has no
  // such reading.
  return createHash('sha256').update(JSON.stringify(rendered)).digest('hex');
}
