/**
 * What a shopper actually authorized (#97 privacy 1 and 7, model 12).
 *
 * PURE. Two things live here and nothing else: the canonical digest of a
 * constraint set, and the refusal that names a forbidden action.
 *
 * ## The digest is what makes "explicit confirmation" a COMPARISON
 *
 * #97 privacy 1 asks that creating an agent require "explicit confirmation of
 * the interpreted constraints". A checkbox satisfies the word and nothing else:
 * a client that renders one interpretation and submits another is
 * indistinguishable from one that does not. So the client echoes back
 * {@link shoppingAgentConstraintDigest} of exactly what it RENDERED, the server
 * recomputes it from what it was SENT, and a mismatch is refused. What the
 * shopper saw and what was stored are then the same object or the write does
 * not happen.
 *
 * The serialization is canonical — object keys sorted at every level, arrays in
 * their given order — because two JSON encodings of one constraint set must
 * produce one digest, and `JSON.stringify`'s key order is insertion order.
 * Array order is deliberately NOT sorted: `[a, b]` and `[b, a]` are the same
 * SET but a re-ordered constraint list renders differently, and a shopper
 * confirming a list is confirming the list they read.
 *
 * ## The forbidden-action refusal names the action
 *
 * A `.strict()` zod schema answers "Unrecognized key: purchase" — technically
 * true and useless. {@link refuseForbiddenAgentAction} is mounted BEFORE the
 * schema and answers with the exact prohibition it found, which is
 * `forbidden-evidence.ts`'s device one domain over (#121) and is the difference
 * between a client author reading "we do not support that field" and reading
 * "this system does not do that".
 */

import { createHash } from 'node:crypto';
import {
  SHOPPING_AGENT_FORBIDDEN_ACTIONS,
  SHOPPING_AGENT_FORBIDDEN_SCOPES,
  type ConstraintSet,
} from '@mercaria/shared-types';

/**
 * A stable digest over a constraint set.
 *
 * `sha256` of the canonical serialization, hex. The prefix names the algorithm
 * so a future change is visible in stored rows rather than silently
 * invalidating every agent's authorization at once.
 */
export function shoppingAgentConstraintDigest(set: ConstraintSet): string {
  return `sha256:${createHash('sha256').update(canonicalJson(set)).digest('hex')}`;
}

/**
 * Whether the digest a client confirmed matches the set it submitted.
 *
 * A plain string comparison and deliberately not a timing-safe one: neither
 * side is a secret. What this defends against is a client that changed its mind
 * between rendering and submitting, not an attacker guessing a hash — and
 * an attacker who can submit a constraint set can trivially compute its digest.
 */
export function shoppingAgentAuthorizationMatches(
  set: ConstraintSet,
  confirmedDigest: string,
): boolean {
  return shoppingAgentConstraintDigest(set) === confirmedDigest;
}

/**
 * The exact forbidden action or scope a request tried to ask for, or `null`.
 *
 * Scans the request's own KEYS and its string VALUES: a client can express
 * "buy it" as a field name (`purchase: true`) or as a value
 * (`kind: 'place_order'`), and only one of those is caught by a strict schema's
 * unknown-key check. Both spellings are compared against the two prohibition
 * vocabularies, normalised so `placeOrder`, `place_order` and `PLACE ORDER` are
 * one thing.
 */
export function refuseForbiddenAgentAction(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const prohibited = [...SHOPPING_AGENT_FORBIDDEN_ACTIONS, ...SHOPPING_AGENT_FORBIDDEN_SCOPES];
  for (const token of collectTokens(body)) {
    const normalized = normalizeToken(token);
    const hit = prohibited.find((value) => normalizeToken(value) === normalized);
    if (hit !== undefined) return hit;
  }
  return null;
}

/** Every key and string value in a bounded walk of the request body. */
function collectTokens(value: unknown, depth = 0): string[] {
  // Bounded: a request is a shallow object and an unbounded walk over
  // caller-supplied JSON is a denial-of-service primitive, which is the same
  // reason #63 refuses to execute anything a feed supplies.
  if (depth > 4) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => collectTokens(entry, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
      key,
      ...collectTokens(entry, depth + 1),
    ]);
  }
  return [];
}

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * A deterministic serialization: object keys sorted at every level.
 *
 * Written out rather than reached for from a library, because the one property
 * that matters — two encodings of one value are one string — is three lines and
 * a dependency is a place it can change under us.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}
