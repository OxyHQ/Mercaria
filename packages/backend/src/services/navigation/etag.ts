/**
 * The deterministic validator a navigation read is cached on (ADR 0007 D10).
 *
 * D10 requires "a deterministic hash used as the ETag" for the authoring
 * schema; a navigation tree is read on the first request of every session, by
 * every client, and is the other payload in this epic that earns one.
 *
 * ## Deterministic means over the CONTENT, and nothing else
 *
 * {@link navigationEtag} hashes a canonical serialization with recursively
 * sorted object keys. Hashing `JSON.stringify(payload)` directly would be
 * deterministic only for as long as every object literal in the projection kept
 * its property order — a refactor that moved one field would change every
 * client's validator and re-download every menu, silently, with no test able to
 * tell that from a real change.
 *
 * Nothing time-varying may enter the payload being hashed. The composed
 * response carries the tree's own schedule and no clock reading, which is what
 * lets two requests a second apart share a validator.
 *
 * ## The locale and the market are a typed KEY, not two fields in a payload
 *
 * A navigation tree is read per `(market, locale)`, so the validator has to vary
 * by both. It did — but only because `readNavigationTrees` happened to put
 * `market` and `requestedLocale` in the object it passed here, which made the
 * variation a property of that call site rather than of this module. Removing
 * either from the body (a plausible "the client already knows what it asked
 * for") left every test in the repository green while two requested locales that
 * resolve to the same tree — both falling back to base, say — shared a tag. A
 * client then holds a cached body reporting somebody else's `requestedLocale`,
 * which is the one field a caller debugging a fallback is reading.
 *
 * So the dimensions are a REQUIRED parameter, the `AuthoringSchemaKey` device
 * from `catalog-authoring/etag.ts` one domain over: a dimension that is not a
 * property of {@link NavigationEtagKey} cannot enter the tag, `tsc` refuses a
 * caller that omits one, and `navigation-projection.test.ts` asserts that
 * changing each one INDIVIDUALLY changes the tag. Asserting variation over a
 * synthetic object handed to a hash function would have measured the hash — it
 * canonicalizes whatever it is given — and said nothing about whether the
 * service supplies the dimensions.
 */

import { createHash } from 'node:crypto';

/** A value that can appear in a composed navigation payload. */
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
 * The semantic dimensions a navigation validator must vary by.
 *
 * Two, and both are required. `market` is nullable because a tree may be
 * authored for every market; `null` and the string `'null'` canonicalize
 * differently, so an unscoped read and a read scoped to a market literally named
 * "null" do not collide.
 */
export interface NavigationEtagKey {
  readonly market: string | null;
  readonly requestedLocale: string;
}

/** The key's parts. One place, so the tag and any future cache key agree. */
function canonicalKeyParts(key: NavigationEtagKey): Serializable {
  return { market: key.market, requestedLocale: key.requestedLocale };
}

/**
 * A strong ETag over a composed payload, quoted as RFC 9110 requires.
 *
 * The key and the body are canonicalized TOGETHER, as one nested object, rather
 * than hashed as two strings with a separator between them — the sibling
 * domain's reasoning, and for the same reason: a separator has to be a character
 * neither half can contain, and both halves are JSON, where every character can
 * appear inside a string.
 */
export function navigationEtag(key: NavigationEtagKey, payload: unknown): string {
  const digest = createHash('sha256')
    .update(canonicalize({ key: canonicalKeyParts(key), body: payload as Serializable }))
    .digest('hex');
  return `"nav-${digest.slice(0, 32)}"`;
}

/*
 * `navigationEtagMatches` used to live here and is GONE — a clean cut, not an
 * alias.
 *
 * `services/catalog-authoring/etag.ts` carried the identical six lines and said
 * that the duplication was deliberate while there were only two spellings, and
 * that a THIRD surface needing them is the point at which they stop being HTTP
 * syntax two files happen to spell and become a helper somebody owns. `/taxonomy`
 * (#367 Workstream 1's HTTP surface) is that third surface, so the owner now
 * exists: `lib/http/if-none-match.ts`, `ifNoneMatchMatches`.
 *
 * What did NOT move is what is actually navigation knowledge — the dimensions a
 * tree projection is keyed by, and the `nav-` prefix.
 */
