/**
 * The comparison space `category_aliases` and `product_type_aliases` live in
 * (#732, ADR 0007 D2).
 *
 * Both tables carry a `normalized_alias` column the SERVICE writes rather than
 * a GENERATED one, and both schema files say why in the same words: `lower(btrim(...))`
 * is enough for an enum value whose spellings differ only in case and padding,
 * and is not enough here, because `transliteration` is a member of
 * `PRODUCT_TYPE_ALIAS_KINDS` and folding accents and scripts is the
 * normalizer's actual job. This module is that normalizer.
 *
 * ## One function, because two would be one bug
 *
 * A write normalizes; a read normalizes; the unique index and the `(locale,
 * normalized_alias)` btree are defined over whatever the write produced. Three
 * things comparing in three spaces do not fail loudly — they fail as an alias
 * that resolves for the operator who tested it with an accent and for nobody
 * else. So there is one exported normalization and every writer and reader in
 * both domains calls it. `services/canonical/normalization.ts`'s
 * `normalizeAliasLookup` is deliberately NOT reused: it states the
 * `lower(btrim(...))` of the GENERATED columns on `brand_aliases` and friends,
 * and widening it to fold accents would silently change the space those
 * indexes are defined over.
 *
 * ## What a shopper's query has to be turned into
 *
 * The lookup is `normalized_alias = ANY(...)`, which is what the btree serves,
 * so the caller needs the SET of phrases a query could be naming. That is
 * {@link catalogAliasCandidates}: every contiguous run of up to
 * {@link MAX_CATALOG_ALIAS_WORDS} words in the query, in both this
 * normalization AND the bare `lower(btrim(...))` one.
 *
 * The second spelling is not belt-and-braces about our own writers — every
 * writer in this repository calls {@link normalizeCatalogAlias}. It is about a
 * row somebody inserted by hand or through a future surface under the obvious
 * `lower()`, which would otherwise be a row, an index entry and no behaviour:
 * exactly the state #732 exists to end. It costs one more element per n-gram in
 * an `= ANY` on an indexed column.
 */

/**
 * The longest alias, in WORDS, a query n-gram is generated for.
 *
 * Four, because the longest alias anybody has written is `ordenador de
 * sobremesa` (three) and a four-word product category name is already a
 * sentence. It is a bound on the CANDIDATE SET and not a refusal: a five-word
 * alias may be stored and simply will not be found by this lookup, which is the
 * safe direction — a missing alias is the behaviour of today.
 *
 * The candidate set is bounded by this times the query's word count, and the
 * query is bounded to `INTENT_QUERY_MAX_LENGTH` (256) characters before it
 * reaches here, so the array can never be longer than a few hundred elements.
 * Nothing is truncated: truncation would be a silent under-match, and an
 * under-match here looks exactly like an alias nobody recorded.
 */
export const MAX_CATALOG_ALIAS_WORDS = 4;

/**
 * The stored form of one alias — what a write persists and a read compares.
 *
 * NFD, combining marks removed, lowercased, whitespace collapsed, trimmed.
 * Identical in effect to `services/search-intent/dictionaries.ts`'s
 * `foldPhrase`, and deliberately duplicated rather than imported: that function
 * defines the space the shipped DICTIONARIES are written in, this one defines
 * a space two Postgres indexes are built over, and coupling them would make a
 * change to the dictionaries' folding a silent schema migration. The two are
 * pinned to each other by a test rather than by an import.
 */
export function normalizeCatalogAlias(alias: string): string {
  return alias
    .normalize('NFD')
    .replace(/[\u{300}-\u{36F}]/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The bare `lower(btrim(...))` a hand-written row is most likely to carry. */
function bareLower(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLowerCase();
}

/**
 * Every phrase in a query that could be a stored alias.
 *
 * Contiguous word runs, both spellings, deduplicated and non-empty. Nothing
 * here decides anything: the caller reads whatever rows exist under these keys,
 * and the INTERPRETER then decides which of them the query actually contains,
 * on a word boundary and longest-first. Splitting it that way is what keeps the
 * decision in one place — the candidate set exists only so the database read is
 * an indexed equality rather than a scan.
 */
export function catalogAliasCandidates(query: string): readonly string[] {
  // Split ONCE, on the query's own words, and normalize each word separately.
  // Normalizing the whole string and splitting it again would produce a second
  // word list whose indexes are only USUALLY the first one's — a word that is
  // nothing but combining marks folds to the empty string — and two lists whose
  // indexes silently disagree is how the bare spelling of one n-gram ends up
  // beside the folded spelling of another.
  const words = query.replace(/\s+/gu, ' ').trim().split(' ').filter((word) => word.length > 0);
  const candidates = new Set<string>();
  for (let start = 0; start < words.length; start += 1) {
    for (let size = 1; size <= MAX_CATALOG_ALIAS_WORDS && start + size <= words.length; size += 1) {
      const phrase = words.slice(start, start + size).join(' ');
      const folded = normalizeCatalogAlias(phrase);
      if (folded.length > 0) candidates.add(folded);
      // The BARE spelling covers a row written under the obvious `lower()`:
      // `móviles` folds to `moviles`, and such a row holds `móviles`.
      const bare = bareLower(phrase);
      if (bare.length > 0) candidates.add(bare);
    }
  }
  return [...candidates];
}
