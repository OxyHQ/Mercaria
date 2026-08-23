/**
 * What "reaching the merchandising collection domain" looks like in source.
 *
 * ADR 0007 D3, second sentence: `collections`, `collection_rules` and
 * `listing_collections` "are **not** given category semantics and **a collection
 * membership never becomes a product fact**." Epic #367 line 565 states the same
 * requirement as an action — *"Prevent presentation-only collections from
 * becoming false product facts."*
 *
 * That sentence has THREE doors and they need three different walls:
 *
 *  1. The merchandising domain WRITING a product fact —
 *     `services/__tests__/merchandising-category-isolation.test.ts`, which has
 *     held it since #367 step 7's sibling landed.
 *  2. A module NAMED for a collection sitting outside that domain — the same
 *     file's `#460` population census, which sweeps `src/` by PATH.
 *  3. A fact-establishing domain READING the collection domain. Door 3 was
 *     open: the census in (2) matches a path, so a facet or attribute module
 *     that imported `collectionRepository` was invisible to it while being
 *     exactly the shape D3 forbids — a shelf a merchant built becoming a
 *     property of the product.
 *
 * This module is door 3's vocabulary, in ONE place, because two walls apply it
 * (the attribute domain's and the facet domain's) and two spellings of one
 * prohibition can disagree about what is forbidden.
 *
 * ## What is forbidden, precisely
 *
 * An IMPORT of a merchandising collection module or of the schema module that
 * declares the three tables; and the two unambiguous TABLE NAMES in raw SQL,
 * plus `collections` when it follows a SQL keyword that can only precede a
 * relation. Both arms are needed: an import ban alone misses raw SQL, which is
 * the one-hop door `merchandising-category-isolation.test.ts` records being
 * caught by in #568.
 *
 * ## What is deliberately NOT forbidden, and why each would break the gate
 *
 * - **The bare word `collection`.** It is ordinary English — "a collection of
 *   values" — and a wall that fired on it would go red on prose, be deleted by
 *   whoever hit it, and take the prohibition with it. The same reasoning
 *   `merchandising-category-isolation.test.ts` gives for not firing on the word
 *   `category`, one domain over.
 * - **Bare `collections` on its own.** A local variable meaning "groups" is a
 *   plausible, legitimate name. It is covered only after `from`/`join`/`into`,
 *   where nothing but a relation can appear.
 * - **PICKUP collection (#93).** `services/pickup/collection.service.ts` and
 *   `collection-code.ts` are about collecting a parcel and share a word with
 *   this domain and nothing else — no table, no route, no service. The import
 *   arm names the merchandising modules explicitly rather than matching
 *   `collection.service`, so a pickup import cannot trip it. Pinned by a test.
 * - **`db/merchandising/discountRepository.ts`.** It lives in the same
 *   directory and is not a collection. A facet reading a discount would be odd
 *   and is a different question from D3's; naming it here would make this wall
 *   about directory membership rather than about the invariant.
 */

/**
 * The merchandising COLLECTION modules, by name.
 *
 * Explicit rather than `db/merchandising/` as a directory, so `discountRepository`
 * stays out and so a pickup module sharing the word cannot match.
 */
export const MERCHANDISING_COLLECTION_MODULES = [
  'db/merchandising/collectionRepository',
  'db/merchandising/collectionRules',
  'db/schema/merchandising',
] as const;

/**
 * The collection SERVICE, which needs its own arm and a guard.
 *
 * It is imported by a relative specifier — `'../collection.service.js'` — which
 * carries no directory to match on, so the full path above cannot see it. The
 * bare name would also match `services/pickup/collection.service.js`, which is
 * a parcel being collected and must stay importable. Hence the negative
 * lookbehind: everything named `collection.service` EXCEPT the one under
 * `pickup/`. Both directions are pinned by tests.
 */
export const MERCHANDISING_COLLECTION_SERVICE = String.raw`(?<!pickup\/)collection\.service`;

/** The three tables ADR 0007 D3 names, as they appear in raw SQL. */
export const MERCHANDISING_COLLECTION_TABLES = [
  'listing_collections',
  'collection_rules',
] as const;

/**
 * A module reaching the merchandising collection domain.
 *
 * Arm 1 is an import specifier ending in one of the module names — `.js`
 * suffixes and any number of `../` are covered because the specifier is matched
 * on its TAIL. Arm 2 is a raw-SQL table name. Arm 3 is `collections` in a
 * position where only a relation can stand.
 */
export const MERCHANDISING_COLLECTION_REACH = new RegExp(
  [
    `from\\s+['"][^'"]*(?:${[
      ...MERCHANDISING_COLLECTION_MODULES.map((module) => module.replace(/\//gu, '\\/')),
      MERCHANDISING_COLLECTION_SERVICE,
    ].join('|')})`,
    `\\b(?:${MERCHANDISING_COLLECTION_TABLES.join('|')})\\b`,
    '\\b(?:from|join|into|update)\\s+collections\\b',
  ].join('|'),
  'iu',
);

/**
 * Where a module reaches the collection domain, reported against the ORIGINAL
 * source rather than the stripped copy.
 *
 * The decision is taken on comment-stripped code — a commented-out import is not
 * a reach — but `stripComments` does not preserve line count, so an offset into
 * the stripped copy names a DIFFERENT REAL LINE of the file. Measured here:
 * a violation planted at line 1,037 of `facet.service.ts` was reported at 975.
 *
 * That is worse than reporting no line at all. Somebody opens line 975, finds
 * ordinary code, and concludes the gate is broken — the failure mode #939
 * recorded, arriving in the next gate that borrowed the same stripper.
 *
 * So the match is located in the stripped copy and then RESOLVED in the original
 * by its own text. When the text cannot be found there — which nothing produces
 * today, since a match is always code — the reach is reported with no line
 * rather than with a guess.
 */
export function findMerchandisingReach(
  source: string,
  stripped: string,
): { readonly text: string; readonly line: number | null } | null {
  const match = MERCHANDISING_COLLECTION_REACH.exec(stripped);
  if (match === null) return null;
  const at = source.indexOf(match[0]);
  return {
    text: match[0].trim(),
    line: at === -1 ? null : source.slice(0, at).split('\n').length,
  };
}
