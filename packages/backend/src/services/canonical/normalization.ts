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

/** Any Unicode Mark — `Mn`, `Mc` or `Me`. See {@link wordTokens}. */
const UNICODE_MARK = /\p{M}/u;

/**
 * The Combining Diacritical Marks block — where LATIN accents decompose to.
 *
 * Deliberately not "every combining mark": U+3099 (the katakana voiced sound
 * mark) and the Indic vowel signs are marks too, and they carry a letter's worth
 * of meaning rather than decoration.
 */
const LATIN_COMBINING_DIACRITIC = /[\u0300-\u036f]/u;

/** A base character an accent may legitimately be folded off. */
const LATIN_LETTER = /\p{Script=Latin}/u;

/** A token has to carry at least one letter or digit to be a token. */
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Fold accents off LATIN letters only, and return NFC. "Nestlé" → "Nestle".
 *
 * ## Why the fold is conditional (#830)
 *
 * The obvious spelling — NFD-decompose and drop every `U+0300–U+036F` — folds
 * more than accents, because that block is also where OTHER scripts' letters
 * keep their distinguishing marks. Measured: Cyrillic `й` decomposes to `и` +
 * U+0306, so the unconditional strip returned `красныи` for `красный`. That is
 * not an accent coming off, it is **a different letter**: `й` is its own letter
 * of the Russian alphabet, and folding it collides `мой` with `мои`.
 *
 * So a mark is dropped only when it is a Latin combining diacritic sitting on a
 * Latin base. Everything else survives.
 *
 * ## `ё` → `е` is REFUSED, deliberately
 *
 * Unlike `й`, this one is a plausible *desirable* fold: Russians routinely type
 * `е` for `ё`. It is refused anyway, because it is **a language's orthographic
 * convention and this function has no locale** — applying a Russian rule
 * globally from a function that cannot know which language it is looking at is
 * the exact class of decision that produced #830. If it is ever wanted it
 * belongs in a locale-aware layer that knows the text is Russian.
 *
 * The asymmetry settles every case like it: **under-folding costs recall, which
 * routes a candidate to a human; over-folding costs precision, which is a false
 * merge a customer finds.** When in doubt, do not fold.
 *
 * ## Why the return value is NFC
 *
 * Decomposing without recomposing would leave callers storing NFD strings,
 * whose bytes differ from the composed spelling of the same word — so the two
 * spellings of one Japanese or Hindi name would stop comparing equal. That
 * trades a visible corruption for an invisible non-match, which is worse.
 * `normalization.test.ts` pins composed and decomposed inputs to one output.
 */
export function foldAccents(value: string): string {
  let folded = '';
  let base = '';
  for (const character of value.normalize('NFD')) {
    if (UNICODE_MARK.test(character)) {
      if (LATIN_COMBINING_DIACRITIC.test(character) && LATIN_LETTER.test(base)) continue;
      folded += character;
      continue;
    }
    base = character;
    folded += character;
  }
  return folded.normalize('NFC');
}

/**
 * Split text into word tokens — the ONE definition of "what is part of a word"
 * this repository has, and the fix for #830.
 *
 * ## Marks are part of a word
 *
 * The class is `[^\p{L}\p{N}\p{M}]`, and `\p{M}` is the whole point: `\p{L}`
 * **excludes combining marks**, so the obvious `[^\p{L}\p{N}]` turns Devanagari
 * and Bengali vowel signs — which are `Mn`/`Mc`, not letters — into SPACES.
 * Measured before the fix, `साइकिल` (bicycle) and `साइकिलें` (bicycles) both
 * came back as `"स इक ल"`, so two distinct Hindi listings collided on one
 * string. That is a false merge: it looks exactly like a correct match and is
 * discovered by a customer.
 *
 * ## Why this is exported rather than repeated
 *
 * Three call sites each carried their own copy of that class — the canonical
 * name fold, the catalogue-proposal search form and the matcher's title
 * tokenizer — so #830 was three bugs wearing one line. A character class that
 * decides identity is one fact and it now has one home; a fourth copy is how
 * this comes back.
 *
 * A token must carry at least one letter or digit, which keeps
 * {@link normalizeEntityName}'s "empty for input with no letters or digits"
 * contract true now that a lone mark is no longer discarded by the split.
 */
export function wordTokens(value: string): string[] {
  return value
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter((token) => HAS_LETTER_OR_DIGIT.test(token));
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
