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
 */

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

/** Fold accents: NFD-decompose, then drop the combining marks. "Nestlé" → "Nestle". */
export function foldAccents(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * The canonical name normalization: accent-folded, lowercased, punctuation
 * collapsed to single spaces, trailing legal suffixes stripped.
 *
 * Never returns the empty string for a name that had any letters or digits: if
 * stripping legal suffixes would consume EVERYTHING ("Limited" the brand), the
 * suffix stripping is skipped — a name that IS a legal form is still a name.
 * Returns `''` only for input with no letters or digits at all, which callers
 * treat as un-normalizable (routed to review, never guessed).
 */
export function normalizeEntityName(value: string): string {
  const tokens = foldAccents(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
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
