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

/** A strong ETag over a composed payload, quoted as RFC 9110 requires. */
export function navigationEtag(payload: unknown): string {
  const digest = createHash('sha256').update(canonicalize(payload as Serializable)).digest('hex');
  return `"nav-${digest.slice(0, 32)}"`;
}

/**
 * Whether an `If-None-Match` header matches the ETag we would serve.
 *
 * Handles the list form and `*`, and compares a `W/`-prefixed candidate on its
 * opaque part: a client that received a strong tag and echoes it weakly is still
 * telling us it holds this exact content, and answering 200 to it would send the
 * whole menu again on every navigation.
 */
export function navigationEtagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  const candidates = ifNoneMatch.split(',').map((value) => value.trim());
  if (candidates.includes('*')) return true;
  const strip = (value: string): string => (value.startsWith('W/') ? value.slice(2) : value);
  return candidates.some((candidate) => strip(candidate) === strip(etag));
}
