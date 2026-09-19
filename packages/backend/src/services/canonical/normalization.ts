/**
 * Name and domain normalization for the canonical graph (#53 identity rule 3).
 *
 * Normalization exists for CANDIDATE GENERATION and nothing else. The display
 * name is always preserved verbatim on the entity and its aliases; nothing in
 * this module — and nothing downstream of it — merges two entities because
 * their normalizations collide. "Apple" and "Apple Inc." normalizing to the
 * same string makes them candidates for a REVIEW, never one row (#53
 * acceptance 1), which is why these functions return strings and never touch a
 * database.
 *
 * This is application vocabulary, deliberately NOT baked into DDL: the schema's
 * generated `normalized_alias` stays at `lower(btrim(...))` (stable forever),
 * while the deeper folding here can evolve — a change re-normalizes via the
 * write services rather than via a generated-column rewrite that silently drops
 * indexes (see CONVENTIONS.md).
 *
 * `foldAccents` and `wordTokens` were declared here by #834 and MOVED to
 * `@mercaria/shared-types` by #838, unchanged. They had to cross the package
 * boundary because `shared-types`' own condition-label fold needs them and the
 * dependency runs one way; this module now imports them like every other
 * consumer and re-exports neither.
 */

import { foldAccents, wordTokens } from '@mercaria/shared-types';

/**
 * Trailing legal-form tokens stripped for candidate generation.
 *
 * Deliberately TRAILING-only and greedy from the right ("Apple Inc" → "apple";
 * "Nike Inc Ltd" → "nike"): a legal form mid-name is part of the name
 * ("Co-op Market" must not lose its "co"). Dots and other punctuation are
 * already gone by the time these are compared, so `s.l.` matches `sl`.
 */
const LEGAL_SUFFIX_TOKENS: ReadonlySet<string> = new Set([
  'ab',
  'ag',
  'bv',
  'co',
  'company',
  'corp',
  'corporation',
  'gmbh',
  'inc',
  'incorporated',
  'kg',
  'limited',
  'llc',
  'llp',
  'lp',
  'ltd',
  'nv',
  'oy',
  'plc',
  'pty',
  'sa',
  'sarl',
  'sl',
  'spa',
  'srl',
]);

/**
 * The canonical name normalization: accent-folded, lowercased, punctuation
 * collapsed to single spaces, trailing legal suffixes stripped.
 *
 * Never returns the empty string for a name that had any letters or digits: if
 * stripping legal suffixes would consume EVERYTHING ("Limited" the brand), the
 * suffix stripping is skipped — a name that IS a legal form is still a name.
 * Returns `''` only for input with no letters or digits at all, which callers
 * treat as un-normalizable (routed to review, never guessed).
 *
 * The output is NFC and preserves every script's marks — see {@link foldAccents}
 * and {@link wordTokens} for what #830 measured before that was true.
 */
export function normalizeEntityName(value: string): string {
  const tokens = wordTokens(foldAccents(value).toLowerCase());
  if (tokens.length === 0) return '';

  // Strip greedily from the right. A window of trailing SINGLE-LETTER tokens
  // is tried as one abbreviation first, because the punctuation collapse above
  // turns "S.A." into ['s', 'a'] — the dotted spelling of a legal form must
  // strip exactly like the undotted one.
  let end = tokens.length;
  let stripped = true;
  while (stripped && end > 1) {
    stripped = false;
    for (const windowSize of [3, 2, 1]) {
      if (end - windowSize < 1) continue;
      const window = tokens.slice(end - windowSize, end);
      if (windowSize > 1 && !window.every((token) => token.length === 1)) continue;
      if (LEGAL_SUFFIX_TOKENS.has(window.join(''))) {
        end -= windowSize;
        stripped = true;
        break;
      }
    }
  }
  const kept = tokens.slice(0, end);
  return (kept.every((token) => LEGAL_SUFFIX_TOKENS.has(token)) ? tokens : kept).join(' ');
}

/**
 * Which version of {@link normalizeEntityName} a stored value was folded under
 * (#915, epic #367 line 580).
 *
 * Stamped as `name_fold_version` on every column this fold WRITES — five, in
 * `canonical_products`, `canonical_product_families`, `organizations`, `brands`
 * and `catalog_proposals` — and `name-fold-version-census.test.ts` fails the
 * build if a sixth write site appears without one.
 *
 * ## What versions this, and what does not
 *
 * THIS fold and no other. `canonical_attribute_values.normalization_rule_version`
 * versions a different fold over different values, and `match_decisions.policy_version`
 * and `analytics_search_queries`' redaction version are not folds at all — three
 * columns that look like this one and answer other questions. Hence the name:
 * it says which fold, not merely that something was normalized.
 *
 * ## What a bump OBLIGES, which is more than "rows are stale"
 *
 * This fold runs on BOTH sides. Of its production call sites only nine write a
 * stored column; the rest fold a QUERY at read time to compare against one. So
 * changing it does not merely age the stored values:
 *
 * 1. every stored value is folded under the old rules;
 * 2. a query folded under the NEW rules cannot match a row folded under the old
 *    one — **lookups miss silently rather than erroring**, which on the trigram
 *    columns means a candidate search quietly returns less;
 * 3. so a bump obliges EITHER an immediate re-fold of all five columns, OR a
 *    consumer that re-folds progressively AND a read path that tolerates both
 *    versions for the duration.
 *
 * The third option is the one this column exists to make available: without it
 * nothing can tell which rows are in which state, so the only safe bump is an
 * all-at-once one.
 *
 * **Bumping this is therefore a decision with work attached, not a constant
 * edit.** `attribute_reindex_requests` already carries
 * `normalization_rules_changed` as an enqueue reason; it has no consumer (#903),
 * and it can only name canonical products and variants, so it covers one of the
 * five.
 */
export const NAME_FOLD_VERSION = 1;

/**
 * The `lower(btrim(...))` the alias tables' GENERATED `normalized_alias` column
 * applies, stated here so service-side lookups compare in exactly the space the
 * unique index and the btree lookup live in.
 */
export function normalizeAliasLookup(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Normalize a domain OBSERVATION to a bare registrable host: scheme, path,
 * query, port and a leading `www.` stripped; lowercased; IDN left as the caller
 * gave it (punycode conversion is the verifier's job, #83, not an observation's).
 *
 * @returns The bare host, or `null` when the input does not contain one —
 *   callers refuse rather than storing a guess.
 */
export function normalizeDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;

  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//u, '');
  const hostPart = withoutScheme.split(/[/?#]/u, 1)[0] ?? '';
  const withoutPort = hostPart.replace(/:\d+$/u, '');
  const host = withoutPort.replace(/^www\./u, '');

  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u.test(host)) {
    return null;
  }
  return host;
}

/**
 * A URL-safe slug from a display name — the DEFAULT when a caller supplies
 * none. It does not strip legal suffixes: "Apple Inc." the organization slugs
 * as `apple-inc`, which keeps it from colliding with the brand's `apple` by
 * default. Uniqueness is the database's; a collision surfaces as a conflict for
 * the caller to resolve with an explicit slug, never an auto-suffix.
 *
 * @returns The slug, or `null` when the name contains no sluggable character.
 */
export function slugFromName(value: string): string | null {
  const slug = foldAccents(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug.length > 0 ? slug : null;
}
